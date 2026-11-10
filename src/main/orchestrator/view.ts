import { promises as fs } from 'node:fs'
import path from 'node:path'
import { projectProgress, type ProjectProgress } from './plan'
import type { OrchestrationProject } from './types'
import { runAcceptance, taskWorkDir } from './acceptance'

/**
 * 给界面用的只读视图：列出 userData/orchestrator 下所有编排项目。
 *
 * 只读、不改任何状态。界面上"重跑验收"也不改任务状态——它只是把当前磁盘上的
 * 事实重新核对一遍给你看，免得"上次通过"变成一句无从复核的自述。
 */

export interface OrchestrationTaskView {
  id: string
  title: string
  status: string
  dependsOn: string[]
  attempts: number
  failureReason?: string
  startedAt?: string
  endedAt?: string
  /** 验收项的原始描述，展开时显示 */
  acceptance: string[]
  /** 产出文件（绝对路径），只列真实存在的 */
  artifacts: string[]
}

export interface OrchestrationProjectView {
  /** 目录名，界面上用它当唯一标识 */
  dirKey: string
  id: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
  rootDir: string
  progress: ProjectProgress
  tasks: OrchestrationTaskView[]
  /** 最近一次派发时间（runs.jsonl 最后一条） */
  lastRunAt?: string
  /** 派发次数 */
  runCount: number
}

/** 列出所有项目，最近更新的在前 */
export async function listProjects(rootDir: string): Promise<OrchestrationProjectView[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(rootDir)
  } catch {
    return [] // 还没派发过任何东西
  }

  const out: OrchestrationProjectView[] = []
  for (const key of entries) {
    const metaDir = path.join(rootDir, key, '.orchestrator')
    let raw: string
    try {
      raw = await fs.readFile(path.join(metaDir, 'project.json'), 'utf8')
    } catch {
      continue // 不是项目目录
    }
    let project: OrchestrationProject
    try {
      project = JSON.parse(raw.replace(/^﻿/, '')) as OrchestrationProject
    } catch {
      continue // 写坏的文件跳过，不因为一个坏项目让整页打不开
    }

    const runs = await readRuns(metaDir)
    out.push({
      dirKey: key,
      id: project.id,
      name: project.name,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      rootDir: path.join(rootDir, key),
      progress: projectProgress(project),
      runCount: runs.count,
      lastRunAt: runs.lastAt,
      tasks: await Promise.all(
        project.tasks.map(async (t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          dependsOn: t.dependsOn,
          attempts: t.attempts,
          failureReason: t.failureReason,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          acceptance: t.acceptance.map(describeCheck),
          artifacts: await existingArtifacts(path.join(rootDir, key), t)
        }))
      )
    })
  }

  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

interface RunTally {
  count: number
  lastAt?: string
}

async function readRuns(metaDir: string): Promise<RunTally> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(metaDir, 'runs.jsonl'), 'utf8')
  } catch {
    return { count: 0 }
  }
  let count = 0
  let lastAt: string | undefined
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    count += 1
    try {
      const rec = JSON.parse(line) as { endedAt?: string }
      if (rec.endedAt) lastAt = rec.endedAt
    } catch {
      /* 坏行跳过 */
    }
  }
  return { count, lastAt }
}

/** 复核一个项目的全部验收，返回逐条结果（不改状态） */
export async function recheckProject(
  rootDir: string,
  dirKey: string
): Promise<{ taskId: string; passed: boolean; detail: string }[]> {
  let project: OrchestrationProject
  try {
    const raw = await fs.readFile(path.join(rootDir, dirKey, '.orchestrator', 'project.json'), 'utf8')
    project = JSON.parse(raw.replace(/^﻿/, '')) as OrchestrationProject
  } catch {
    return []
  }
  const results: { taskId: string; passed: boolean; detail: string }[] = []
  for (const t of project.tasks) {
    if (t.acceptance.length === 0) {
      results.push({ taskId: t.id, passed: t.status === 'done', detail: '没有验收项：只能按状态判断' })
      continue
    }
    const r = await runAcceptance(t.acceptance, taskWorkDir(path.join(rootDir, dirKey), t))
    results.push({
      taskId: t.id,
      passed: r.passed,
      detail: r.results.map((x) => `${x.passed ? '✓' : '✗'} ${x.detail}`).join('；')
    })
  }
  return results
}

function describeCheck(c: { kind: string; path: string; bytes?: number; text?: string }): string {
  switch (c.kind) {
    case 'file-exists':
      return `存在 ${c.path}`
    case 'min-bytes':
      return `${c.path} ≥ ${c.bytes} 字节`
    case 'contains':
      return `${c.path} 含「${c.text}」`
    case 'not-contains':
      return `${c.path} 不含「${c.text}」`
    default:
      return `${c.kind} ${c.path}`
  }
}

async function existingArtifacts(root: string, task: { acceptance: { path?: string }[]; outputFile?: string }): Promise<string[]> {
  const found: string[] = []
  const workDir = taskWorkDir(root, task as never)
  for (const c of task.acceptance) {
    if (!c.path) continue
    const p = path.resolve(workDir, c.path)
    if (await isFile(p)) found.push(p)
  }
  if (task.outputFile && (await isFile(task.outputFile))) found.push(task.outputFile)
  return [...new Set(found)]
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}
