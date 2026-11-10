import { CodebuddyBackend } from './backends/codebuddy'
import { ClaudeBackend } from './backends/claude'
import { CodexBackend } from './backends/codex'
import { PiBackend } from './backends/pi'
import {
  WorkerConfigError,
  type WorkerBackend,
  type WorkerBackendKind,
  type WorkerRunOptions,
  type WorkerRunResult,
  type WorkerToolCall
} from './backends/types'
import type { WorkerRunRecord } from './types'

export type { WorkerBackend, WorkerBackendKind, WorkerToolCall, WorkerRunOptions, WorkerRunResult }
export { WorkerConfigError }

/**
 * 工作体配置。
 *
 * `backend` 是这一层的核心开关：同一个编排队列可以派给不同家的智能体。
 * 各家需要的参数不一样，所以这里是"一个大对象里放各家的字段"，
 * 而不是给每家一个配置——用户改一处就够，不用记四套配置文件。
 */
export interface WorkerConfig {
  /** 用哪个后端。缺省 pi */
  backend?: WorkerBackendKind
  /** 显式指定可执行文件/脚本；空则用各家的默认查找逻辑 */
  binPath?: string
  /**
   * pi 专用：provider 必填。
   * pi 的默认模型会落到 anthropic，没 Key 就是 401，所以不接受空值。
   */
  provider?: string
  /** 模型名。各家都认；留空 = 用该后端自己的默认 */
  model?: string
  /** 允许工作体用的工具白名单 */
  tools: string[]
  timeoutMs?: number
  /** 向后兼容：老字段名 */
  piBin?: string
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** 各家的人话说明，用在错误信息与设置页里 */
export const BACKEND_INFO: Record<WorkerBackendKind, { label: string; note: string }> = {
  pi: {
    label: 'pi',
    note: '常驻 RPC，最贴总线结构。走局域网网关，不花钱。必须显式填 provider 和 model。'
  },
  codex: {
    label: 'codex',
    note: 'OpenAI 的命令行入口（ChatGPT 桌面版没有 CLI，能自动化的是它）。一次性跑完，有沙箱档位和 JSON 事件流。'
  },
  codebuddy: {
    label: 'codebuddy',
    note: 'WorkBuddy 内置的 CLI。需要先登录一次才能非交互使用。'
  },
  claude: {
    label: 'claude',
    note: 'Claude Code。按订阅计费（一次极短问答约 $0.067），默认关闭，要用请显式指定。'
  }
}

export const ALL_BACKENDS: WorkerBackendKind[] = ['pi', 'codex', 'codebuddy', 'claude']

function timeoutOf(config: WorkerConfig): number {
  return config.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/** 按配置造一个后端实例。同一个后端可以被反复调用（每次 run 起一次进程） */
export function createBackend(config: WorkerConfig): WorkerBackend {
  const kind = config.backend ?? 'pi'
  switch (kind) {
    case 'pi':
      return new PiBackend({
        binPath: config.binPath ?? config.piBin,
        provider: config.provider ?? '',
        model: config.model ?? '',
        tools: config.tools,
        timeoutMs: timeoutOf(config)
      })
    case 'codex':
      return new CodexBackend({
        binPath: config.binPath,
        model: config.model,
        // 写权限由 tools 白名单推出来：给了 write 才开 workspace-write
        write: config.tools.some((t) => /^(write|edit|bash)$/i.test(t)),
        timeoutMs: timeoutOf(config)
      })
    case 'codebuddy':
      return new CodebuddyBackend({
        scriptPath: config.binPath,
        tools: config.tools,
        timeoutMs: timeoutOf(config)
      })
    case 'claude':
      return new ClaudeBackend({
        binPath: config.binPath,
        model: config.model,
        tools: config.tools,
        timeoutMs: timeoutOf(config)
      })
    default:
      throw new WorkerConfigError(`未知的工作体后端：${String(kind)}`)
  }
}

/** 校验配置能不能跑。不合法就抛，绝不"换个后端试试" */
export function assertWorkerConfig(config: WorkerConfig): void {
  const backend = createBackend(config)
  if (backend.kind === 'pi') {
    if (!config.provider?.trim() || !config.model?.trim()) {
      throw new WorkerConfigError(
        'pi 后端必须显式填 provider 和 model：默认模型会落到 anthropic，没 Key 就是 401。' +
          '例如 provider=eepseek、model=deepseek-v4-flash（以 pi --list-models 为准）'
      )
    }
  }
}

/** 后端能不能用（装没装、登没登录）。不能就返回人话原因 */
export async function checkBackend(config: WorkerConfig): Promise<{ ok: boolean; reason?: string }> {
  try {
    assertWorkerConfig(config)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  return createBackend(config).ready()
}

/** 跑一个任务：按配置派给对应后端 */
export function runWorker(opts: WorkerRunOptions & { config: WorkerConfig }): Promise<WorkerRunResult> {
  let backend: WorkerBackend
  try {
    assertWorkerConfig(opts.config)
    backend = createBackend(opts.config)
  } catch (e) {
    return Promise.resolve({
      ok: false,
      text: '',
      toolCalls: [],
      exitCode: null,
      failureReason: e instanceof Error ? e.message : String(e)
    })
  }
  return backend.run({ prompt: opts.prompt, workDir: opts.workDir, signal: opts.signal, onProgress: opts.onProgress })
}

/** 把一次运行收成 runs.jsonl 的一行 */
export function toRunRecord(args: {
  projectId: string
  taskId: string
  startedAt: string
  result: WorkerRunResult
}): WorkerRunRecord {
  return {
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: args.projectId,
    taskId: args.taskId,
    startedAt: args.startedAt,
    endedAt: new Date().toISOString(),
    ok: args.result.ok,
    exitCode: args.result.exitCode,
    toolCalls: args.result.toolCalls,
    outputChars: args.result.text.length,
    usage: args.result.usage,
    failureReason: args.result.failureReason
  }
}
