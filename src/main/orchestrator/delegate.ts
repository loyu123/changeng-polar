import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ProjectRunner } from './runner'
import { ProjectStore } from './store'
import type { AcceptanceCheck, OrchestrationProject, OrchestrationTask } from './types'
import type { WorkerBackendKind, WorkerConfig } from './worker'

/**
 * 把编排层接到对话里：长庚自己能派活出去。
 *
 * 边界（这几条不是建议，是硬约束）：
 * - **每次必弹卡**：委派交给的是一个无人值守的外部智能体，它能执行命令、能读那个目录。
 *   按 write 自动放行等于没人同意过。所以工具带 requiresConfirmation。
 * - **永远不「始终允许」**：闸门对 requiresConfirmation 已经关掉记忆。
 * - **工作目录隔离**：每个委派一个独立目录，不许指向用户正在用的仓库。
 * - **不静默越权**：工具白名单由参数决定，默认只给 read/write；不给 bash 就不给。
 */

export interface DelegateRequest {
  title?: string
  prompt: string
  /** 期望的产出，用来做确定性验收；为空时只取回答 */
  expect?: AcceptanceCheck[]
  /** 工作体可用的工具白名单，缺省 read + write */
  tools?: string[]
}

export interface DelegateResult {
  ok: boolean
  summary: string
  projectRoot: string
  taskStatus: string
  artifactPaths: string[]
  failureReason?: string
  outputChars: number
}

/**
 * 从配置读出一个后端配置；缺关键项就返回 null（由调用方明确报错，不猜）。
 *
 * 注意各家要求不同：
 * - pi **必须**有 provider + model（默认模型会落到 anthropic，401）
 * - codex / codebuddy / claude 的模型可以留空，用它们自己的配置
 */
export function workerConfigFrom(
  worker: { backend?: WorkerBackendKind; provider?: string; model?: string; binPath?: string; timeoutSec?: number } | undefined,
  tools?: string[]
): WorkerConfig | null {
  const backend = worker?.backend ?? 'pi'
  const provider = worker?.provider?.trim()
  const model = worker?.model?.trim()

  if (backend === 'pi' && (!provider || !model)) return null

  return {
    backend,
    provider: provider || undefined,
    model: model || undefined,
    binPath: worker?.binPath?.trim() || undefined,
    tools: tools ?? ['read', 'write'],
    timeoutMs: (worker?.timeoutSec ?? 300) * 1000
  }
}

/**
 * 跑一次委派：建一个单任务项目，跑到验收为止。
 *
 * 为什么走 ProjectStore 而不是直接调 runWorker：路径和状态要留痕——
 * 事后能回答"这次派了什么、调到哪一步、验收过没过"。
 */
export async function runDelegation(
  req: DelegateRequest,
  workerCfg: WorkerConfig,
  opts: { rootDir: string; signal?: AbortSignal; onProgress?: (note: string) => void } = { rootDir: '' }
): Promise<DelegateResult> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const projectDir = path.join(opts.rootDir, `delegate-${stamp}`)

  const task: OrchestrationTask = {
    id: 'delegate',
    title: req.title?.trim() || '委派任务',
    prompt: req.prompt.trim(),
    dependsOn: [],
    status: 'pending',
    acceptance: req.expect ?? [],
    attempts: 0
  }

  const store = new ProjectStore(projectDir)
  const project = await createSingleTaskProject(store, projectDir, task, stamp)

  const runner = new ProjectRunner({
    store,
    resolveWorker: () => ({ ...workerCfg, tools: req.tools ?? workerCfg.tools }),
    onEvent: (e) => {
      if (e.kind === 'task-start') opts.onProgress?.('已开始')
      if (e.kind === 'task-progress') opts.onProgress?.(`调用 ${e.tool}`)
    }
  })

  await runner.runAllConcurrent(project, 1, opts.signal)
  const done = (await store.load()) ?? project
  const t = done.tasks[0]

  const artifactPaths = await collectArtifacts(projectDir, task)

  return {
    ok: t.status === 'done',
    summary:
      t.status === 'done'
        ? `委派完成：${t.title}`
        : `委派未通过（${t.status}）：${t.failureReason ?? '原因未知'}`,
    projectRoot: projectDir,
    taskStatus: t.status,
    artifactPaths,
    failureReason: t.failureReason,
    outputChars: t.outputFile ? (await fs.stat(t.outputFile).catch(() => ({ size: 0 }))).size : 0
  }
}

/** 单任务项目：验收允许为空（只取回答），所以不走 validatePlan */
async function createSingleTaskProject(
  store: ProjectStore,
  rootDir: string,
  task: OrchestrationTask,
  stamp: string
): Promise<OrchestrationProject> {
  await fs.mkdir(path.join(rootDir, '.orchestrator'), { recursive: true })
  await fs.mkdir(path.join(rootDir, 'tasks', task.id), { recursive: true })
  const now = new Date().toISOString()
  const project: OrchestrationProject = {
    id: `delegate-${stamp}`,
    name: task.title,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    rootDir,
    tasks: [task]
  }
  await store.save(project)
  return project
}

/** 产出清单：只报真实存在的文件，不把"应该有"的路径当结果 */
async function collectArtifacts(projectDir: string, task: OrchestrationTask): Promise<string[]> {
  const found: string[] = []
  const workDir = path.join(projectDir, 'tasks', task.id)
  for (const c of task.acceptance) {
    if ('path' in c) {
      const p = path.resolve(workDir, c.path)
      if (await exists(p)) found.push(p)
    }
  }
  const out = path.join(workDir, 'output.txt')
  if (await exists(out)) found.push(out)
  return [...new Set(found)]
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
