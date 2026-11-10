import { promises as fs } from 'node:fs'
import path from 'node:path'
import { outputPath, runAcceptance, taskWorkDir } from './acceptance'
import { projectProgress, readyTasks } from './plan'
import type { ProjectStore } from './store'
import type { OrchestrationProject, OrchestrationTask, WorkerSpec } from './types'
import {
  runWorker,
  toRunRecord,
  type WorkerConfig,
  type WorkerRunOptions,
  type WorkerRunResult
} from './worker'

/** 同时最多几个工作体。再多人也看不过来，且网关的并发上限没人知道 */
export const MAX_CONCURRENCY = 8

/**
 * 串行推进（P1）。
 *
 * 形态是"长庚每次被唤醒推进一格"，不是"一口气跑完整个项目"——
 * 单轮工具预算只有 5 步，长项目本来就不可能一口气跑完。这不是缺陷，
 * 是必须接受的形态：进程崩了，最多丢一格，runs.jsonl 里能查到最后到哪。
 *
 * 上游产出怎么传给下游：**把上游 output.txt 的路径和内容交给长庚接力**，
 * 工作体之间从不直接通信（它们物理上也看不见彼此）。每转一手都会掉信息，
 * 所以提示词里要写明"这些是上游产物"，让它知道哪些是别人写的、不是自己查的。
 */

export interface RunnerOptions {
  store: ProjectStore
  /** 按任务的 worker 声明解析出实际配置；返回 null 表示没配好 */
  resolveWorker: (spec?: WorkerSpec) => WorkerConfig | null
  /** 过程事件（汇报用） */
  onEvent?: (e: RunnerEvent) => void
  /**
   * 最多几个任务同时跑（P2）。缺省 1 = 串行。
   *
   * 上限不是随便定的：工作体接的是同一个网关，网关自己有多少并发没人知道，
   * 开太多只会一起变慢甚至一起 429。所以卡在 1~8，且冲突检测（同一工作目录）
   * 永远优先于并发数——两个任务同时写同一批文件，结果一定是坏的。
   */
  concurrency?: number
  /**
   * 真正起工作体的那层，默认走 `runWorker`。
   *
   * **签名里带 config**：这样测试才能断言"这一件到底派给了哪家、
   * 用了哪几个能力词"。不带的话，按任务分配后端这件事就测不出来。
   */
  runWorkerImpl?: (opts: WorkerRunOptions & { config: WorkerConfig }) => Promise<WorkerRunResult>
}

export type RunnerEvent =
  | { kind: 'task-start'; taskId: string }
  | { kind: 'task-progress'; taskId: string; tool: string; ok?: boolean }
  | { kind: 'task-end'; taskId: string; ok: boolean; reason?: string }
  | { kind: 'project-done'; total: number; done: number }
  /** 同层任务抢同一个工作目录，被推迟到下一批 */
  | { kind: 'deferred'; taskId: string; reason: string }

export class ProjectRunner {
  constructor(private readonly opts: RunnerOptions) {}

  /** 推进一格：拿第一个可派发任务跑完。没有可派发的就返回 null */
  async step(project: OrchestrationProject, signal?: AbortSignal): Promise<OrchestrationTask | null> {
    const ready = readyTasks(project)
    if (ready.length === 0) return null
    return this.runTask(project, ready[0], signal)
  }

  /** 一直推进到没有可派发任务（串行；concurrency=1 时等价于 P1 的形态） */
  async runAll(project: OrchestrationProject, signal?: AbortSignal): Promise<OrchestrationProject> {
    return this.runAllConcurrent(project, 1, signal)
  }

  /**
   * 并行推进（P2）：每批取"现在能派发的 + 工作目录不冲突的"任务，最多 N 个同时跑。
   *
   * 为什么按批而不是按静态分层：分层是在计划不变的前提下算的；一批里某个任务失败，
   * 它的下游这一轮就该进不来。每批重新算 ready，比预先算好的层更不容易跑偏。
   */
  async runAllConcurrent(
    project: OrchestrationProject,
    concurrency = 1,
    signal?: AbortSignal
  ): Promise<OrchestrationProject> {
    const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, MAX_CONCURRENCY))
    let current = await this.fresh(project)

    for (;;) {
      if (signal?.aborted) break
      const { batch } = this.pickBatch(current, limit)
      if (batch.length === 0) break
      await Promise.all(batch.map((t) => this.runTask(current, t, signal)))
      current = await this.fresh(current)
    }

    const p = projectProgress(current)
    this.opts.onEvent?.({ kind: 'project-done', total: p.total, done: p.done })
    return current
  }

  /**
   * 从可派发任务里挑一批：按顺序取，跳过工作目录已经被占的。
   * 被跳过的发 deferred 事件，让汇报里看得见"它没被忘掉，只是排在下一批"。
   */
  private pickBatch(
    project: OrchestrationProject,
    limit: number
  ): { batch: OrchestrationTask[]; deferred: OrchestrationTask[] } {
    const ready = readyTasks(project)
    const batch: OrchestrationTask[] = []
    const deferred: OrchestrationTask[] = []
    const usedDirs = new Set<string>()
    for (const t of ready) {
      if (batch.length >= limit) break
      const dir = path.resolve(taskWorkDir(project.rootDir, t))
      if (usedDirs.has(dir)) {
        deferred.push(t)
        this.opts.onEvent?.({
          kind: 'deferred',
          taskId: t.id,
          reason: `工作目录 ${dir} 已被同批任务占用，推迟到下一批`
        })
        continue
      }
      usedDirs.add(dir)
      batch.push(t)
    }
    return { batch, deferred }
  }

  private async fresh(project: OrchestrationProject): Promise<OrchestrationProject> {
    return (await this.opts.store.load()) ?? project
  }

  private async runTask(
    project: OrchestrationProject,
    task: OrchestrationTask,
    signal?: AbortSignal
  ): Promise<OrchestrationTask> {
    const workerConfig = this.opts.resolveWorker(task.worker)
    if (!workerConfig) {
      await this.opts.store.updateTask(task.id, {
        status: 'failed',
        failureReason: '工作体没有配置（provider / model）'
      })
      this.opts.onEvent?.({ kind: 'task-end', taskId: task.id, ok: false, reason: '工作体未配置' })
      return { ...task, status: 'failed' }
    }

    // 任务可以单独指定后端：同一个项目里按活的性质分配（整理资料给 codebuddy，
    // 跑代码给 pi）。没指定就用默认后端。
    const backend = task.worker?.backend ?? workerConfig.backend ?? 'pi'
    // 工具名在这里就翻成该后端认的名字：任务写的是能力词，各家叫法不同
    const effective: WorkerConfig = {
      ...workerConfig,
      backend,
      tools: task.worker?.tools ?? workerConfig.tools
    }

    const workDir = taskWorkDir(project.rootDir, task)
    const startedAt = new Date().toISOString()
    this.opts.onEvent?.({ kind: 'task-start', taskId: task.id })
    await this.opts.store.updateTask(task.id, {
      status: 'running',
      startedAt,
      attempts: task.attempts + 1,
      failureReason: undefined
    })

    // 先把上游产出搬进这个任务自己的目录，再拼提示词。
    // 不让工作体去读别人的目录：隔离目录是硬边界，越界读写会在别处把活覆盖掉。
    const upstreamFiles = await this.handOffUpstream(project, task, workDir)
    const prompt = await this.composePrompt(project, task, upstreamFiles)
    const result = await (this.opts.runWorkerImpl ?? runWorker)({
      config: effective,
      prompt,
      workDir,
      signal,
      onProgress: (e) =>
        this.opts.onEvent?.({ kind: 'task-progress', taskId: task.id, tool: e.call.name, ok: e.call.ok })
    })
    const record = toRunRecord({ projectId: project.id, taskId: task.id, startedAt, result })
    await this.opts.store.appendRun(record)

    if (!result.ok) {
      // 进程被杀/超时不等于"失败"：它可能已经做了一半。标 unknown 让用户决定重跑还是人工确认
      const status = isIndeterminate(result) ? 'unknown' : 'failed'
      await this.opts.store.updateTask(task.id, {
        status,
        endedAt: new Date().toISOString(),
        lastRunId: record.runId,
        failureReason: result.failureReason ?? '工作体未成功'
      })
      this.opts.onEvent?.({ kind: 'task-end', taskId: task.id, ok: false, reason: result.failureReason })
      return { ...task, status }
    }

    const outFile = await this.opts.store.writeOutput(project, task, result.text)
    // 验收是硬门：工作体说做完了不算，文件在这里、够大、含该有的字才算
    const acceptance = await runAcceptance(task.acceptance, workDir)
    const detail = acceptance.results
      .map((r) => `${r.passed ? '✓' : '✗'} ${r.detail}`)
      .join('；')
    const status = acceptance.passed ? 'done' : 'failed'
    await this.opts.store.updateTask(task.id, {
      status,
      endedAt: new Date().toISOString(),
      lastRunId: record.runId,
      outputFile: outFile,
      failureReason: acceptance.passed ? undefined : `验收未通过：${detail}`
    })
    this.opts.onEvent?.({ kind: 'task-end', taskId: task.id, ok: acceptance.passed, reason: detail })
    return { ...task, status }
  }

  /**
   * 把上游任务的产出复制到下游任务的 `_upstream/` 下，返回"给下游看的相对路径"。
   *
   * 为什么复制而不是给绝对路径：工作体只被允许在自己目录里动手（隔离目录是硬边界）。
   * 让它跨目录去读，今天能读，明天就可能写到别人家里去。
   */
  private async handOffUpstream(
    project: OrchestrationProject,
    task: OrchestrationTask,
    workDir: string
  ): Promise<{ title: string; relPath: string }[]> {
    const handed: { title: string; relPath: string }[] = []
    if (task.dependsOn.length === 0) return handed
    const dir = path.join(workDir, '_upstream')
    await fs.mkdir(dir, { recursive: true })
    for (const depId of task.dependsOn) {
      const dep = project.tasks.find((t) => t.id === depId)
      if (!dep || dep.status !== 'done') continue
      const src = dep.outputFile ?? outputPath(project.rootDir, dep)
      const name = `${dep.id}.md`
      try {
        await fs.copyFile(src, path.join(dir, name))
        handed.push({ title: dep.title, relPath: path.join('_upstream', name) })
      } catch {
        // 产出文件丢了就如实不算交接，下游看到的上游列表里不会有它
      }
    }
    return handed
  }

  /**
   * 拼提示词。三件事必须写清楚，否则工作体会跑偏：
   * 1. 你能动哪个目录（越界会被拒）
   * 2. 上游给了什么（以及那是"别人写的"，不是它自己查到的）
   * 3. 交上来会被怎么验（事先说清验收，比事后返工便宜）
   */
  private async composePrompt(
    project: OrchestrationProject,
    task: OrchestrationTask,
    upstreamFiles: { title: string; relPath: string }[] = []
  ): Promise<string> {
    const parts: string[] = []
    parts.push(`# 任务：${task.title}`)
    parts.push(task.prompt.trim())
    parts.push(`\n## 工作目录\n你只能在这个目录里工作：${taskWorkDir(project.rootDir, task)}`)

    if (upstreamFiles.length > 0) {
      const list = upstreamFiles.map((u) => `- ${u.title} → ${u.relPath}`).join('\n')
      parts.push(
        `\n## 上游产出\n下面这些是**之前的工作体**做的，不是你自己查到的。引用时按这个口径说：\n${list}`
      )
    }

    if (task.acceptance.length > 0) {
      const checks = task.acceptance.map(describeCheck).join('\n')
      parts.push(`\n## 交付会被这样检查（不满足即判未完成）\n${checks}`)
    }

    const out = outputPath(project.rootDir, task)
    parts.push(`\n## 交付方式\n把最终回答直接写在回复里即可；系统会把它保存到 ${path.basename(out)}。`)
    return parts.join('\n')
  }
}

function describeCheck(c: OrchestrationTask['acceptance'][number]): string {
  switch (c.kind) {
    case 'file-exists':
      return `- 必须存在文件 ${c.path}`
    case 'min-bytes':
      return `- 文件 ${c.path} 至少 ${c.bytes} 字节`
    case 'contains':
      return `- 文件 ${c.path} 必须包含「${c.text}」`
    case 'not-contains':
      return `- 文件 ${c.path} 不能包含「${c.text}」`
  }
}

/** 结果未知：进程中断/超时/取消，可能已经做了一半 */
function isIndeterminate(result: WorkerRunResult): boolean {
  if (result.ok) return false
  const reason = result.failureReason ?? ''
  return /超时|取消|中断|没有正常收敛/.test(reason)
}
