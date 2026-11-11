import { promises as fs } from 'node:fs'
import path from 'node:path'
import { projectProgress } from './plan'
import type { OrchestrationProject } from './types'
import { runAcceptance, taskWorkDir } from './acceptance'
import type {
  OrchestrationProjectView,
  OrchestrationTaskView
} from '../../shared/orchestration'

export type { OrchestrationProjectView, OrchestrationTaskView }

/**
 * 给界面用的只读视图：列出编排项目。只读、不改任何状态。
 *
 * 界面上"重新核对"也不改任务状态——它只是把当前磁盘上的事实再核对一遍给你看，
 * 免得"上次通过"变成一句无从复核的自述。
 *
 * **身份是项目目录的绝对路径**，不是某一个根下的目录名。
 * 之前只有一个根（userData/orchestrator），`dirKey` 是那下面的子目录名；
 * 现在用户可以另外打开别处的目录（桌面、D 盘），两个根里出现同名子目录时，
 * 目录名就不再唯一了——拿它当键会选错项目、核对错项目。
 *
 * 每个根认两种形状：
 * - 根本身就是一个项目（用户直接把 `project-xxx` 那个目录选进来了）
 * - 根下面还有若干项目（选的是 `长庚测试项目` 这类上层目录）
 *
 * 两种都认是因为人挑目录时不会先想清楚自己站在哪一层——而选错一层就被判成
 * 「这里没有项目」，比报错更让人没法查。
 */
export async function listProjects(roots: string[]): Promise<OrchestrationProjectView[]> {
  const out: OrchestrationProjectView[] = []
  const seen = new Set<string>()

  const add = async (projectDir: string, scanRoot: string): Promise<void> => {
    const key = path.resolve(projectDir)
    if (seen.has(key)) return
    const view = await readProject(key, scanRoot)
    if (!view) return
    seen.add(key)
    out.push(view)
  }

  for (const root of roots) {
    const scanRoot = path.resolve(String(root ?? ''))
    if (!scanRoot) continue
    // 根本身就是项目
    await add(scanRoot, scanRoot)

    let entries: string[]
    try {
      entries = await fs.readdir(scanRoot)
    } catch {
      continue // 目录还没建，或者不在了
    }
    for (const key of entries) await add(path.join(scanRoot, key), scanRoot)
  }

  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** 读一个项目目录；目录里没有 `.orchestrator/project.json` 就返回 null */
export async function readProject(
  projectDir: string,
  scanRoot = projectDir
): Promise<OrchestrationProjectView | null> {
  const metaDir = path.join(projectDir, '.orchestrator')
  let raw: string
  try {
    raw = await fs.readFile(path.join(metaDir, 'project.json'), 'utf8')
  } catch {
    return null // 不是项目目录
  }
  let project: OrchestrationProject
  try {
    project = JSON.parse(raw.replace(/^﻿/, '')) as OrchestrationProject
  } catch {
    return null // 写坏的文件跳过，不因为一个坏项目让整页打不开
  }

  const runs = await readRuns(metaDir)
  return {
    projectDir,
    id: project.id,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    rootDir: projectDir,
    progress: projectProgress(project),
    runCount: runs.count,
    lastRunAt: runs.lastAt,
    scanRoot,
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
        artifacts: await existingArtifacts(projectDir, t)
      }))
    )
  }
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

/**
 * 复核一个项目的全部验收，返回逐条结果（不改状态）。
 *
 * 参数是**项目目录本身**，不是「根 + 子目录名」：见文件头的说明。
 */
export async function recheckProject(projectDir: string): Promise<{ taskId: string; passed: boolean; detail: string }[]> {
  let project: OrchestrationProject
  try {
    const raw = await fs.readFile(path.join(projectDir, '.orchestrator', 'project.json'), 'utf8')
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
    const r = await runAcceptance(t.acceptance, taskWorkDir(projectDir, t))
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
