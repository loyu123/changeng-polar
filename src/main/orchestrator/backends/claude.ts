import {
  SAFE_TOKEN,
  WorkerConfigError,
  spawnCollect,
  type WorkerBackend,
  type WorkerRunOptions,
  type WorkerRunResult,
  type WorkerToolCall
} from './types'

/**
 * Claude Code 后端：`claude -p`。
 *
 * **默认关闭，必须显式启用。** 两个原因：
 * 1. 用户当时明确要求「把我现在使用的 Claude Code 单独移开，不做入记录」——
 *    他自己正拿它改这个仓库，长庚再往里派活会互相覆盖（隔离目录缓解了这一点，
 *    但订阅额度是同一份）。
 * 2. 它按订阅计费。实测一句"回答两个字"就花了 $0.067（13900+ 输入 token，
 *    因为每次都要带完整系统提示）。这跟 pi 走内网网关的"免费"完全不是一回事。
 *
 * 所以这个后端存在、可用，但**没人把它配成默认**。要用就在
 * `ButlerConfig.worker.backend` 里显式写 'claude'，并且知道它在花钱。
 *
 * 永不传 `--dangerously-skip-permissions`；限权走 `--allowedTools`。
 */

export interface ClaudeOptions {
  binPath?: string
  model?: string
  /** 允许用的工具；空数组 = 不给任何工具 */
  tools: string[]
  timeoutMs: number
}

/**
 * 构造 `claude -p` 的参数。
 *
 * 两个实测坑，都跟"变参"有关：
 * 1. **`--allowedTools` 是变参，会把后面的位置参数整串吞掉。** 第一次写成
 *    `--allowedTools '' "提示词"`，提示词被当成工具名吃了，claude 直接报
 *    `Input must be provided either through stdin or as a prompt argument`。
 *    所以提示词必须紧跟 `-p`。
 * 2. **它要的是空格分隔的多个参数，不是逗号连起来的一个。** 传 `Read,Write`
 *    会被当成一个叫 "Read,Write" 的工具（不存在），结果一个工具都用不了——
 *    实测表现为"回答里说已经写好了，磁盘上什么都没有"。
 *    既然它是变参且放在最后，多个工具直接摊开传即可。
 */
export function buildClaudeArgs(o: ClaudeOptions): string[] {
  if (o.model && !SAFE_TOKEN.test(o.model)) throw new WorkerConfigError(`model 含非法字符：${o.model}`)
  const args = ['-p', '--output-format', 'json']
  if (o.model) args.push('--model', o.model)
  // 放最后：它会把后面剩下的参数全吃进去，所以不能在它之后再放别的
  args.push('--allowedTools', ...(o.tools.length > 0 ? o.tools : ['__polar_no_tools__']))
  return args
}

export class ClaudeBackend implements WorkerBackend {
  readonly kind = 'claude' as const
  constructor(private readonly opts: ClaudeOptions) {}

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true }
  }

  async run(opts: WorkerRunOptions): Promise<WorkerRunResult> {
    let args: string[]
    try {
      args = buildClaudeArgs(this.opts)
    } catch (e) {
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: String(e instanceof Error ? e.message : e) }
    }
    const bin = this.opts.binPath?.trim() || 'claude'

    const res = await spawnCollect(bin, args, {
      cwd: opts.workDir,
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
      shell: process.platform === 'win32',
      stdin: opts.prompt
    })

    if (res.timedOut) {
      return {
        ok: false,
        text: '',
        toolCalls: [],
        exitCode: null,
        failureReason: `超时 ${Math.round(this.opts.timeoutMs / 1000)} 秒未结束，已终止`
      }
    }
    if (res.aborted) {
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: '已取消（用户停止或应用退出）' }
    }

    const parsed = parseClaudeOutput(res.stdout)
    if (!parsed.text.trim()) {
      return {
        ok: false,
        text: '',
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        exitCode: res.code,
        failureReason: `claude 没有给出回答（退出码 ${res.code}）${tail(res.stderr)}`
      }
    }
    return {
      ok: res.code === 0,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      exitCode: res.code,
      failureReason: res.code === 0 ? undefined : `claude 退出码 ${res.code}${tail(res.stderr)}`
    }
  }
}

interface ClaudeParse {
  text: string
  toolCalls: WorkerToolCall[]
  usage?: Record<string, unknown>
}

/**
 * 解析 `claude -p --output-format json` 的结果。
 *
 * 形状（实测）：`{ result, is_error, total_cost_usd, usage: {...}, modelUsage: {...}, session_id }`。
 * 用量里 total_cost_usd 才是真正花掉的钱，单独拎出来放进 usage，汇报时能看见。
 */
export function parseClaudeOutput(stdout: string): ClaudeParse {
  const trimmed = stdout.trim()
  if (!trimmed) return { text: '', toolCalls: [] }

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    const text = typeof obj.result === 'string' ? obj.result : ''
    const usage = (obj.usage ?? {}) as Record<string, unknown>
    if (typeof obj.total_cost_usd === 'number') usage.total_cost_usd = obj.total_cost_usd
    return { text: text.trim(), toolCalls: [], usage }
  } catch {
    // 不是 JSON（旧版本或参数不同）：整段当文本
    return { text: trimmed, toolCalls: [] }
  }
}

function tail(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const lines = t.split('\n')
  return `：${lines[lines.length - 1].slice(0, 200)}`
}
