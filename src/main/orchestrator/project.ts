import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runAcceptance, taskWorkDir } from './acceptance'
import { previewDispatch, projectProgress, validatePlan, type DispatchPreview } from './plan'

export { previewDispatch, type DispatchPreview }
import { ProjectRunner } from './runner'
import { ProjectStore } from './store'
import type { OrchestrationProject, OrchestrationTask } from './types'
import type { WorkerConfig, WorkerRunOptions, WorkerRunResult } from './worker'

/**
 * 多任务项目派发（候选卡在这里发挥作用）。
 *
 * 与 delegate.ts 的分工：
 * - delegate：**一个**任务，边界是"做完这一件"
 * - project（本文件）：**一组**有依赖的任务，边界是"跑完这个项目"
 *
 * 并行是有代价的：同一层 N 个任务同时跑 = N 倍并发打到同一个模型网关。
 * 所以不替用户决定，把它做成候选卡上的一次点击——并且**只在真有同层多任务时
 * 才把并行选项摆出来**。链式计划（A→B→C）开多少路都一样快，给这种计划
 * 摆并行选项就是骗人。
 */

export interface ProjectRunRequest {
  name: string
  tasks: OrchestrationTask[]
  /** 选定的派发方式：'serial' 或 'parallel:N'。没给就由调用方先弹卡 */
  mode?: string
}

export interface ProjectRunResult {
  ok: boolean
  summary: string
  projectRoot: string
  project: OrchestrationProject
  preview: DispatchPreview
  concurrency: number
  /** 每个任务的最终状态，汇报用 */
  taskStates: { id: string; title: string; status: string; reason?: string }[]
}

/** 把 'parallel:3' 解析成并发数；'serial'/非法值 一律按 1 */
export function parseMode(mode: string | undefined): number {
  if (!mode) return 1
  const m = /^parallel:(\d+)$/.exec(mode.trim())
  if (!m) return 1
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 1 ? n : 1
}

/**
 * 生成候选卡选项。
 *
 * 只列出"用户真正会选"的那几档：串行、2 路、以及最宽层数（上限 4）。
 * 列太多等于让用户做算术题。最宽层只有 1 时只给串行。
 */
export function dispatchOptions(preview: DispatchPreview): { value: string; label: string; detail: string }[] {
  const serial = {
    value: 'serial',
    label: '串行',
    detail: `一次跑一个，最稳。共 ${preview.total} 个任务`
  }
  if (!preview.parallelizable) return [serial]

  const widths = [...new Set(preview.layerWidths.filter((w) => w >= 2))].sort((a, b) => a - b)
  const wanted = widths.filter((w) => w <= 4)
  const levels = wanted.length > 0 ? wanted : [Math.min(preview.maxWidth, 4)]

  return [
    serial,
    ...levels.map((n) => ({
      value: `parallel:${n}`,
      label: `并行 ${n} 路`,
      detail: `最多 ${n} 个任务同时在跑（${n} 倍并发）。慢的只剩最宽那一层`
    }))
  ]
}

export interface RunProjectOptions {
  rootDir: string
  worker: WorkerConfig
  mode?: string
  signal?: AbortSignal
  onEvent?: (e: { kind: string; taskId?: string; note?: string }) => void
  /** 过程进度（会一路透传到界面） */
  onProgress?: (note: string) => void
  /** 测试接缝：替换真正起进程的那层，见 runner.ts 的同名字段 */
  runWorkerImpl?: (opts: WorkerRunOptions) => Promise<WorkerRunResult>
}

export async function runProject(
  req: ProjectRunRequest,
  opts: RunProjectOptions
): Promise<ProjectRunResult> {
  const validation = validatePlan(req.tasks)
  if (!validation.ok) {
    // 计划不合法就不建目录：半截计划落盘之后只会变成"打不开的项目"
    throw new Error(`计划不合法：${validation.errors.map((e) => e.message).join('；')}`)
  }

  const preview = previewDispatch(req.tasks)
  const concurrency = Math.min(parseMode(req.mode), Math.max(1, preview.maxWidth))
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const projectDir = path.join(opts.rootDir, `project-${stamp}`)
  await fs.mkdir(projectDir, { recursive: true })

  const store = new ProjectStore(projectDir)
  await store.create(req.name, req.tasks)
  const created = (await store.load())!

  const runner = new ProjectRunner({
    store,
    resolveWorker: () => opts.worker,
    runWorkerImpl: opts.runWorkerImpl,
    onEvent: (e) => {
      if (e.kind === 'task-start') {
        opts.onEvent?.({ kind: 'start', taskId: e.taskId })
        opts.onProgress?.(`开始：${e.taskId}`)
      } else if (e.kind === 'task-progress') {
        opts.onEvent?.({ kind: 'progress', taskId: e.taskId, note: e.tool })
        opts.onProgress?.(`${e.taskId} 调用 ${e.tool}`)
      } else if (e.kind === 'task-end') {
        opts.onEvent?.({ kind: 'end', taskId: e.taskId, note: e.ok ? '通过' : (e.reason ?? '未通过') })
        opts.onProgress?.(`${e.taskId} ${e.ok ? '通过' : '未通过'}`)
      } else if (e.kind === 'deferred') {
        opts.onEvent?.({ kind: 'deferred', taskId: e.taskId, note: e.reason })
        opts.onProgress?.(`${e.taskId} 推迟：${e.reason}`)
      }
    }
  })

  await runner.runAllConcurrent(created, concurrency, opts.signal)
  const done = (await store.load()) ?? created
  const progress = projectProgress(done)

  const taskStates = done.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    reason: t.failureReason
  }))

  return {
    ok: progress.done === progress.total,
    summary:
      progress.done === progress.total
        ? `项目完成：${progress.done}/${progress.total} 个任务全部通过验收`
        : `项目未全部通过：完成 ${progress.done}/${progress.total}，失败 ${progress.failed}，未知 ${progress.unknown}，卡住 ${progress.blocked}`,
    projectRoot: projectDir,
    project: done,
    preview,
    concurrency,
    taskStates
  }
}

/** 读一个任务产出的绝对路径（给汇报用；不存在就不报） */
export async function taskArtifacts(rootDir: string, task: OrchestrationTask): Promise<string[]> {
  const dir = taskWorkDir(rootDir, task)
  const found: string[] = []
  for (const c of task.acceptance) {
    const p = path.resolve(dir, c.path)
    try {
      await fs.stat(p)
      found.push(p)
    } catch {
      /* 不存在就不报，不把"应该有"当结果 */
    }
  }
  if (task.outputFile) found.push(task.outputFile)
  return [...new Set(found)]
}

/** 按任务的验收再跑一遍（复核用，不改状态） */
export async function recheck(rootDir: string, task: OrchestrationTask): Promise<{ passed: boolean; detail: string }> {
  const r = await runAcceptance(task.acceptance, taskWorkDir(rootDir, task))
  return {
    passed: r.passed,
    detail: r.results.map((x) => `${x.passed ? '✓' : '✗'} ${x.detail}`).join('；')
  }
}
