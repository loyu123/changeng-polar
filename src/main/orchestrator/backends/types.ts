/**
 * 工作体后端的公共契约。
 *
 * 为什么要有这一层：不同外部智能体的自动化入口形状完全不同——
 * pi 是常驻 RPC、codex 是 `exec` 一次性跑、claude 是 `-p`、codebuddy 是 node 脚本。
 * 各家参数、事件格式、限权方式都不一样，但它们对上游只需要交出同一件事：
 * 「回答是什么、调了哪些工具、花了多少」。把差异关在各自的实现里，
 * 编排层（runner / plan / acceptance）就一行都不用改。
 *
 * 所有后端必须共同遵守的三条：
 * 1. **不静默回落**：没配好、没登录，就明确报原因，绝不"换个后端试试"。
 * 2. **不放开权限**：永远不传 `--dangerously-skip-permissions` /
 *    `--dangerously-bypass-approvals-and-sandbox`。限权靠各家的显式白名单与沙箱档。
 * 3. **过程要说真话**：工具调用从事件流里数出来，不用模型自报。
 */

export type WorkerBackendKind = 'pi' | 'codex' | 'codebuddy' | 'claude'

export interface WorkerToolCall {
  name: string
  args?: unknown
  ok?: boolean
  durationMs?: number
}

export interface WorkerRunResult {
  ok: boolean
  text: string
  toolCalls: WorkerToolCall[]
  usage?: Record<string, unknown>
  exitCode: number | null
  failureReason?: string
}

export interface WorkerRunOptions {
  prompt: string
  workDir: string
  signal?: AbortSignal
  onProgress?: (event: { kind: 'tool-start' | 'tool-end'; call: WorkerToolCall }) => void
}

/** 一个后端实例：绑定好参数，只等被要求跑一次 */
export interface WorkerBackend {
  readonly kind: WorkerBackendKind
  /** 这个后端现在能不能用（装没装、登没登录）。不能就给出人话原因 */
  ready(): Promise<{ ok: boolean; reason?: string }>
  run(opts: WorkerRunOptions): Promise<WorkerRunResult>
}

/** 只允许"安全的裸值"进命令行参数：带空格或引号的值等于给 shell 开口子 */
export const SAFE_TOKEN = /^[A-Za-z0-9._\-\/:]+$/

export class WorkerConfigError extends Error {}

/** 起进程的公共壳：统一处理超时、取消、stderr 尾部留存 */
export interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

export function spawnCollect(
  bin: string,
  args: string[],
  opts: {
    cwd: string
    timeoutMs: number
    signal?: AbortSignal
    shell?: boolean
    /**
     * 写进子进程 stdin 的内容（通常是提示词）。
     *
     * 为什么提示词走 stdin 而不是命令行参数：Windows 上这些 CLI 是 .cmd，
     * 不过 shell 起不来；过了 shell，带空格和中文的参数会被 cmd.exe 拆碎——
     * 实测表现为"提示词只剩前半句，模型不知道要干什么，照样回一句客套话"。
     * 走 stdin 完全不经过 shell 解析，UTF-8 也能原样送到。
     */
    stdin?: string
  }
): Promise<SpawnResult> {
  // 延迟 require，避免把 electron 依赖带进纯逻辑单测
  const { spawn } = require('node:child_process') as typeof import('node:child_process')

  return new Promise<SpawnResult>((resolve) => {
    let child
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        shell: opts.shell ?? process.platform === 'win32',
        windowsHide: true
      })
    } catch (e) {
      resolve({
        code: null,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        aborted: false
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    let aborted = false

    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      resolve({ code, stdout, stderr, timedOut, aborted })
    }

    const onAbort = (): void => {
      aborted = true
      finish(null)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      finish(null)
    }, opts.timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c: string) => {
      stdout += c
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c: string) => {
      // 只留尾部：诊断信息在最后几行，全存会吃内存
      stderr = (stderr + c).slice(-4000)
    })
    child.on('error', (e: Error) => {
      stderr = (stderr + '\n' + e.message).slice(-4000)
      finish(null)
    })
    child.on('exit', (code: number | null) => finish(code))

    // 提示词走 stdin。没有提示词也必须立刻关掉 stdin——codex 的规则是
    // "参数里没给就从 stdin 读"，留着一个打开的 pipe 它会一直等下去
    // （实测表现为能跑但永不退出，只能靠超时杀掉）。
    try {
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin, 'utf8')
      else child.stdin?.end()
    } catch {
      /* 有些命令不读 stdin */
    }
  })
}
