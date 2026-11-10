import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  SAFE_TOKEN,
  WorkerConfigError,
  type WorkerBackend,
  type WorkerRunOptions,
  type WorkerRunResult,
  type WorkerToolCall
} from './types'

/**
 * pi 后端：RPC 常驻模式。
 *
 * 为什么用 RPC 而不是 `pi -p`：`-p` 是"起进程 → 读一段文本 → 退出"，无状态；
 * RPC 是常驻的，能连续推进多格、持续收事件。探针实测：一个进程连推 3 轮，
 * 第 2 轮记得第 1 轮的内容。
 *
 * 三个实测坑：
 * 1. **不能让模型走默认值。** pi 的默认模型解析到 anthropic，没配 Key 就是
 *    401 Invalid bearer token。provider / model 必须显式传。
 * 2. **stdout 是协议流，不是日志。** 严格按 LF 切分，不能切 U+2028/U+2029
 *    （它们在 JSON 字符串里合法）。用 readline 会切坏。
 * 3. **模型调用失败时 pi 仍会发 agent_settled。** 不查 stopReason === 'error'
 *    就会把失败汇报成成功。
 */

export interface PiOptions {
  /** pi 可执行文件；空则走 PATH */
  binPath?: string
  provider: string
  model: string
  tools: string[]
  timeoutMs: number
}

export const PI_PROVIDER_HINT =
  'pi 必须显式指定 provider 和 model：默认模型会落到 anthropic，没 Key 就是 401。' +
  '例如 provider=eepseek、model=deepseek-v4-flash（以 pi --list-models 为准）'

export function assertPiOptions(o: PiOptions): void {
  if (!o.provider?.trim() || !o.model?.trim()) throw new WorkerConfigError(PI_PROVIDER_HINT)
  if (!SAFE_TOKEN.test(o.provider)) throw new WorkerConfigError(`provider 含非法字符：${o.provider}`)
  if (!SAFE_TOKEN.test(o.model)) throw new WorkerConfigError(`model 含非法字符：${o.model}`)
  for (const t of o.tools) {
    if (!SAFE_TOKEN.test(t)) throw new WorkerConfigError(`工具名含非法字符：${t}`)
  }
}

export function buildPiArgs(o: PiOptions): string[] {
  assertPiOptions(o)
  const args = ['--mode', 'rpc', '--provider', o.provider, '--model', o.model, '--no-session', '--no-context-files']
  if (o.tools.length > 0) args.push('--tools', o.tools.join(','))
  else args.push('--no-tools')
  return args
}

export class PiBackend implements WorkerBackend {
  readonly kind = 'pi' as const
  constructor(private readonly opts: PiOptions) {}

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    try {
      assertPiOptions(this.opts)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  run(opts: WorkerRunOptions): Promise<WorkerRunResult> {
    try {
      assertPiOptions(this.opts)
    } catch (e) {
      return Promise.resolve(fail(e))
    }
    const { prompt, workDir, signal, onProgress } = opts
    const args = buildPiArgs(this.opts)
    const bin = this.opts.binPath?.trim() || 'pi'

    return new Promise<WorkerRunResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(bin, args, {
          cwd: workDir,
          shell: process.platform === 'win32',
          windowsHide: true
        }) as ChildProcessWithoutNullStreams
      } catch (e) {
        resolve(fail(e))
        return
      }

      const toolCalls: WorkerToolCall[] = []
      const byCallId = new Map<string, WorkerToolCall>()
      let text = ''
      let usage: Record<string, unknown> | undefined
      let stderr = ''
      let lastError: string | undefined
      let settled = false
      let finished = false
      let timer: NodeJS.Timeout | null = null
      let buf = ''

      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
        signal?.removeEventListener('abort', onAbort)
      }

      const finish = (result: WorkerRunResult): void => {
        if (finished) return
        finished = true
        cleanup()
        try {
          child.stdin.end()
        } catch {
          /* 已经关了 */
        }
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        resolve(result)
      }

      const onAbort = (): void =>
        finish({
          ok: false,
          text,
          toolCalls,
          usage,
          exitCode: null,
          failureReason: '已取消（用户停止或应用退出）'
        })
      signal?.addEventListener('abort', onAbort, { once: true })

      timer = setTimeout(() => {
        finish({
          ok: false,
          text,
          toolCalls,
          usage,
          exitCode: null,
          failureReason: `超时 ${Math.round(this.opts.timeoutMs / 1000)} 秒未收敛，已终止`
        })
      }, this.opts.timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buf += chunk
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (!line.trim()) continue
          let rec: Record<string, unknown>
          try {
            rec = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          handleRecord(rec)
        }
      })

      const handleRecord = (rec: Record<string, unknown>): void => {
        const type = rec.type as string | undefined
        if (type === 'tool_execution_start') {
          const call: WorkerToolCall = { name: String(rec.toolName ?? ''), args: rec.args }
          const id = String(rec.toolCallId ?? '')
          if (id) byCallId.set(id, call)
          toolCalls.push(call)
          onProgress?.({ kind: 'tool-start', call })
          return
        }
        if (type === 'tool_execution_end') {
          const call = byCallId.get(String(rec.toolCallId ?? ''))
          if (call) {
            call.ok = (rec.result as { isError?: boolean } | undefined)?.isError !== true
            call.durationMs = typeof rec.durationMs === 'number' ? rec.durationMs : undefined
            onProgress?.({ kind: 'tool-end', call })
          }
          return
        }
        if (type === 'message_end') {
          const msg = rec.message as
            | { role?: string; content?: { text?: string }[]; usage?: Record<string, unknown>; stopReason?: string; errorMessage?: string }
            | undefined
          if (msg?.role === 'assistant') {
            const said = (msg.content ?? []).map((p) => p.text ?? '').join('').trim()
            if (said) text = said
            if (msg.usage) usage = msg.usage
            if (msg.stopReason === 'error') {
              lastError = msg.errorMessage?.trim() || '模型调用失败（stopReason=error，没有给出原因）'
            }
          }
          return
        }
        if (type === 'agent_settled') {
          settled = true
          if (lastError) {
            finish({ ok: false, text, toolCalls, usage, exitCode: 0, failureReason: lastError })
            return
          }
          if (!text.trim() && toolCalls.length === 0) {
            finish({
              ok: false,
              text,
              toolCalls,
              usage,
              exitCode: 0,
              failureReason: '工作体什么都没做：没有工具调用，也没有任何回答'
            })
            return
          }
          finish({ ok: true, text, toolCalls, usage, exitCode: 0 })
        }
      }

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000)
      })

      child.on('error', (e) => finish({ ok: false, text, toolCalls, usage, exitCode: null, failureReason: `工作体进程出错：${e.message}` }))

      child.on('exit', (code) => {
        if (finished) return
        const hint = stderr.trim()
        finish({
          ok: false,
          text,
          toolCalls,
          usage,
          exitCode: code,
          failureReason: settled
            ? `进程退出 code=${code}`
            : `工作体没有正常收敛（code=${code}）${hint ? `：${hint.split('\n').slice(-1)[0]?.slice(0, 200)}` : ''}`
        })
      })

      // 提示词走 stdin 的 JSONL 命令：中文在 argv 上会被 Windows 编码毁掉
      child.stdin.write(JSON.stringify({ id: 'prompt-1', type: 'prompt', message: prompt }) + '\n')
    })
  }
}

function fail(e: unknown): WorkerRunResult {
  return {
    ok: false,
    text: '',
    toolCalls: [],
    exitCode: null,
    failureReason: e instanceof Error ? e.message : String(e)
  }
}
