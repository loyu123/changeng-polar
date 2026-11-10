import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { outputPath, runsPath, taskWorkDir } from './acceptance'
import { validatePlan } from './plan'
import type { OrchestrationProject, OrchestrationTask, WorkerRunRecord } from './types'

/**
 * 项目状态的落盘。一个项目一个根目录：
 *
 * ```
 * <rootDir>/
 *   .orchestrator/project.json     项目、任务、依赖、验收、每步状态
 *   .orchestrator/runs.jsonl       每次派发的记录（append-only，事后可查）
 *   tasks/<id>/                    每个任务的工作目录，工作体只能在这里动手
 * ```
 *
 * 两件必须守住的事：
 * - **写入是原子的**：先写临时文件再 rename。直接覆盖写，进程在写到一半被杀会留下
 *   半个 JSON，下次启动就"项目全丢了"。
 * - **状态未知要如实标 unknown**：派发时先落 running，进程退出后如果没走到收尾，
 *   重启时看到 running 且没有对应 run 记录，就标 unknown 而不是猜成功或失败。
 */

export class ProjectStore {
  constructor(private readonly rootDir: string) {}

  private get metaDir(): string {
    return path.join(this.rootDir, '.orchestrator')
  }

  private get file(): string {
    return path.join(this.metaDir, 'project.json')
  }

  /** 建一个新项目并落盘。计划不合法直接抛错，不落盘——半截计划比没有计划更糟 */
  async create(name: string, tasks: OrchestrationTask[]): Promise<OrchestrationProject> {
    const validation = validatePlan(tasks)
    if (!validation.ok) {
      throw new Error(`计划不合法：${validation.errors.map((e) => e.message).join('；')}`)
    }
    const now = new Date().toISOString()
    const project: OrchestrationProject = {
      id: randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      status: 'planning',
      rootDir: this.rootDir,
      tasks: tasks.map((t) => ({ ...t, status: t.status ?? 'pending', attempts: t.attempts ?? 0 }))
    }
    await this.ensureDirs(project)
    await this.save(project)
    return project
  }

  /**
   * 读当前项目，并做一次重启对账。
   *
   * 读也走队列：见 save() 那条注释——Windows 上 rename 撞上别人正在读会 EPERM。
   */
  async load(): Promise<OrchestrationProject | null> {
    return this.enqueue(async () => {
      const project = await this.readRaw()
      return project ? this.reconcile(project) : null
    })
  }

  /** 不做对账的原始读，只在队列内部用 */
  private async readRaw(): Promise<OrchestrationProject | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch {
      return null
    }
    return JSON.parse(raw.replace(/^﻿/, '')) as OrchestrationProject
  }

  /**
   * 原子写：先写临时文件再 rename。
   *
   * 两个 Windows 上的坑，都实测踩过：
   * 1. **临时文件名必须唯一。** 只用 pid 时，同一进程里两个并发保存会写同一个临时
   *    文件；一个先 rename 走了，另一个 rename 就报 EPERM。
   * 2. **rename 期间不能有人正在读目标文件。** Windows 上目标文件被别的句柄打开时，
   *    覆盖式 rename 会失败（EPERM）。所以读和写都走同一条串行队列。
   */
  async save(project: OrchestrationProject): Promise<void> {
    await this.enqueue(() => this.writeAtomic(project))
  }

  private async writeAtomic(project: OrchestrationProject): Promise<void> {
    project.updatedAt = new Date().toISOString()
    await fs.mkdir(this.metaDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${++this.saveSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8')
    try {
      await fs.rename(tmp, this.file)
    } catch (err) {
      // 写不成也不能留下垃圾临时文件
      await fs.unlink(tmp).catch(() => undefined)
      throw err
    }
  }

  /** 只改一个任务，走串行队列避免"读全表改再写回"把别人的改动覆盖掉 */
  async updateTask(taskId: string, patch: Partial<OrchestrationTask>): Promise<OrchestrationProject> {
    return this.enqueue(async () => {
      const project = await this.readRaw()
      if (!project) throw new Error('没有可更新的项目')
      const idx = project.tasks.findIndex((t) => t.id === taskId)
      if (idx < 0) throw new Error(`项目里没有任务 ${taskId}`)
      project.tasks[idx] = { ...project.tasks[idx], ...patch }
      await this.writeAtomic(project)
      return project
    })
  }

  async appendRun(record: WorkerRunRecord): Promise<void> {
    const project = await this.load()
    if (!project) throw new Error('没有可记录的项目')
    await this.enqueue(async () => {
      const p = runsPath(this.rootDir)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.appendFile(p, JSON.stringify(record) + '\n', 'utf8')
    })
  }

  /**
   * 重启时的对账：上次留着 running、但根本没有 run 记录的任务，
   * 状态其实是未知——不能当成功，也不能当失败。
   */
  private async reconcile(project: OrchestrationProject): Promise<OrchestrationProject> {
    if (!project.tasks.some((t) => t.status === 'running')) return project
    const finished = new Set<string>()
    try {
      const raw = await fs.readFile(runsPath(this.rootDir), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line) as WorkerRunRecord
          finished.add(rec.runId)
        } catch {
          /* 坏行跳过：一条写坏的记录不该让整个项目打不开 */
        }
      }
    } catch {
      /* 没有 runs.jsonl = 一次都没派发过 */
    }
    for (const t of project.tasks) {
      if (t.status !== 'running') continue
      if (!t.lastRunId || !finished.has(t.lastRunId)) {
        t.status = 'unknown'
        t.failureReason = '上次派发中断，结果未知：只能重跑或人工确认，不能假设成功'
      }
    }
    return project
  }

  private async ensureDirs(project: OrchestrationProject): Promise<void> {
    await fs.mkdir(this.metaDir, { recursive: true })
    for (const t of project.tasks) {
      await fs.mkdir(taskWorkDir(this.rootDir, t), { recursive: true })
    }
  }

  /** 工作体的原文回答落盘 */
  async writeOutput(project: OrchestrationProject, task: OrchestrationTask, text: string): Promise<string> {
    const p = outputPath(project.rootDir, task)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, text, 'utf8')
    return p
  }

  // ---- 串行队列 ----
  private chain: Promise<unknown> = Promise.resolve()
  /** 临时文件名自增序号：同一进程里并发保存时不会撞车 */
  private saveSeq = 0

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }
}
