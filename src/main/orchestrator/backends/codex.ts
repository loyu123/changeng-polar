import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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
 * codex 后端：`codex exec`，一次性跑完退出。
 *
 * 这是 OpenAI 那一边**唯一**可自动化的入口。ChatGPT 桌面版是纯 GUI，程序喂不进去；
 * 能喂的是 codex CLI，而它已经装在这台机器上。
 *
 * 三个要点：
 * 1. **可执行文件的路径会变。** 它装在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe`，
 *    一升级哈希目录就换名。所以不能写死路径，每次去 bin 下找最新的那个。
 * 2. **沙箱档位要压到最低档够用。** read-only 够读，workspace-write 够写；
 *    永远不传 `danger-full-access`，更不传 `--dangerously-bypass-approvals-and-sandbox`。
 * 3. **`item.type === 'error'` 不等于失败。** codex 把"配置里有不认识的字段"这种
 *    警告也发成 error 项；把它当失败会把正常跑完的任务判成失败。
 */

export interface CodexOptions {
  /** 显式指定可执行文件；空则自动去 AppData 下找 */
  binPath?: string
  /** 模型名。留空 = 用 codex 自己 config.toml 里的 */
  model?: string
  /** 允许写文件吗。true → workspace-write，false → read-only */
  write: boolean
  timeoutMs: number
}

/**
 * 找 codex 可执行文件，**优先 PATH 上的独立版**。
 *
 * 这台机器上可能同时存在两个 codex：
 * 1. `npm i -g @openai/codex` 装的独立版 → 在 PATH 上，是稳定版（0.167.0）
 * 2. ChatGPT 桌面版自带的 → 在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\`，
 *    是 alpha 版（0.167.0-alpha.3.2），而且**哈希目录会随桌面版更新改名**
 *
 * 优先独立版：稳定版、路径固定、不跟着桌面版一起变。
 * 都找不到则由调用方明确报"没装"。
 */
export function findCodexBin(): string | null {
  // 先看 PATH：Windows 上要认 .cmd/.exe 两种形式
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathEntries) {
    if (!dir) continue
    for (const name of ['codex.exe', 'codex.cmd', 'codex']) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }

  // 退回桌面版自带的那个：哈希目录会变，所以每次重新扫
  const root = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
  if (!existsSync(root)) return null
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  const candidates: { file: string; mtime: number }[] = []
  for (const d of dirs) {
    const file = path.join(root, d, 'codex.exe')
    if (existsSync(file)) {
      try {
        candidates.push({ file, mtime: statSync(file).mtimeMs })
      } catch {
        /* 读不到时间就跳过 */
      }
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].file
}

/**
 * 构造参数。**提示词不在参数里**——它走 stdin（见 spawnCollect 的说明）：
 * 带空格和中文的提示词在 Windows 过 shell 时会被 cmd.exe 拆碎。
 */
export function buildCodexArgs(o: CodexOptions): string[] {
  if (o.model && !SAFE_TOKEN.test(o.model)) throw new WorkerConfigError(`model 含非法字符：${o.model}`)
  const args = [
    'exec',
    // 编排目录不是 git 仓库，不跳过就会被 codex 拒绝
    '--skip-git-repo-check',
    // 沙箱只在这两档里选；危险档一律不碰
    '-s', o.write ? 'workspace-write' : 'read-only',
    '--ephemeral',
    '--json',
    '--color', 'never'
  ]
  if (o.model) args.push('-m', o.model)
  return args
}

/**
 * 把网关层的报错翻译成人话。
 *
 * codex 只支持 Responses 协议（实测：`wire_api` 只认 `responses`，写 chat 直接报
 * unknown variant）。而很多网关（LiteLLM 就是）的 Responses 实现是把请求转成
 * chat completions 再发出去，这一步会出各种错——实测两个模型两种错法：
 * - deepseek-v4-flash → `Tool names must be unique`（工具定义被重复了一遍）
 * - Qwen3.8-Flash     → `Unexpected reasoning effort high`、`System message must be at the beginning`
 *
 * 这些都不是配置能绕过的，也不是 codex 的锅。所以直接把人话说清楚，
 * 别让用户以为是 key 填错了、或者我们的代码坏了。
 */
export function explainGatewayError(raw: string): string | undefined {
  if (!/litellm/i.test(raw)) return undefined
  if (/Tool names must be unique/i.test(raw)) {
    return (
      '网关的 Responses 接口把工具定义重复发给了上游模型，被模型拒收（Tool names must be unique）。' +
      '这是 LiteLLM 那层把 Responses 转成 chat completions 时的转换问题，改 codex 参数绕不过去。' +
      '要么升级/换掉那个网关，要么把 codex 指向一个原生支持 Responses 协议的服务。'
    )
  }
  if (/System message must be at the beginning/i.test(raw)) {
    return (
      '网关把消息顺序转错了（System message must be at the beginning），' +
      '同样是 LiteLLM 的 Responses 转换问题。'
    )
  }
  if (/Unexpected reasoning effort/i.test(raw)) {
    return '网关不支持 codex 发过去的推理档位（Unexpected reasoning effort），属于 Responses 转换层的问题。'
  }
  return `网关返回了错误（LiteLLM 层）：${raw.slice(0, 200)}`
}

export class CodexBackend implements WorkerBackend {
  readonly kind = 'codex' as const
  constructor(private readonly opts: CodexOptions) {}

  private bin(): string | null {
    return this.opts.binPath?.trim() || findCodexBin()
  }

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    const bin = this.bin()
    if (!bin) {
      return {
        ok: false,
        reason:
          '找不到 codex.exe（应在 %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\<哈希>\\codex.exe）。' +
          '没装就先装 Codex CLI；装在别处就在配置里填 binPath。'
      }
    }
    return { ok: true }
  }

  async run(opts: WorkerRunOptions): Promise<WorkerRunResult> {
    const bin = this.bin()
    if (!bin) {
      const r = await this.ready()
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: r.reason }
    }
    let args: string[]
    try {
      args = buildCodexArgs(this.opts)
    } catch (e) {
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: String(e instanceof Error ? e.message : e) }
    }

    const res = await spawnCollect(bin, args, {
      cwd: opts.workDir,
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
      // npm 全局装出来的是 `.cmd` shim，在 Windows 上直接 spawn 会报 EINVAL，
      // 必须过 shell。而 .exe 不过 shell 更安全（路径带空格也不会被拆）。
      // 提示词走 stdin，参数都是我们自己构造的，过 shell 也不给用户输入留缝。
      shell: /\.(cmd|bat)$/i.test(bin),
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

    const parsed = parseCodexJsonl(res.stdout)
    if (res.code !== 0 && !parsed.text) {
      return {
        ok: false,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        exitCode: res.code,
        // 已经有翻译过的硬错，就别再拼 stderr 尾巴：那行是 "Reading prompt from stdin..."
        // 之类的噪音，跟失败原因无关，混在一起反而把真原因淹掉
        failureReason: `codex 退出码 ${res.code}${parsed.hardError ? `：${parsed.hardError}` : lastLine(res.stderr)}`
      }
    }
    if (parsed.hardError) {
      return {
        ok: false,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        exitCode: res.code,
        failureReason: parsed.hardError
      }
    }
    if (!parsed.text.trim()) {
      return {
        ok: false,
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        exitCode: res.code,
        failureReason: `codex 没有给出回答${lastLine(res.stderr)}`
      }
    }
    return { ok: true, text: parsed.text, toolCalls: parsed.toolCalls, usage: parsed.usage, exitCode: res.code }
  }
}

export interface CodexParse {
  text: string
  toolCalls: WorkerToolCall[]
  usage?: Record<string, unknown>
  /** 真正的错误（不是配置警告） */
  hardError?: string
}

/**
 * 解析 codex 的 JSONL 事件流。
 *
 * 认这几种：
 * - `item.completed` + `item.type === 'agent_message'` → 最终回答（多条取最后一条）
 * - `item.completed`/`item.started` + `command_execution` → 一次命令执行
 * - `turn.completed` → 用量
 * - `item.type === 'error'` → **默认当警告**。codex 会把配置里不认识的字段也发成
 *   error 项；只有 message 明显是执行失败（含 "failed"/"error executing"）才算硬错。
 */
export function parseCodexJsonl(stdout: string): CodexParse {
  const toolCalls: WorkerToolCall[] = []
  let text = ''
  let usage: Record<string, unknown> | undefined
  let hardError: string | undefined

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = rec.type as string | undefined
    if (type === 'item.completed' || type === 'item.started') {
      const item = rec.item as Record<string, unknown> | undefined
      const itemType = item?.type as string | undefined
      if (itemType === 'agent_message') {
        const said = String(item?.text ?? '').trim()
        if (said) text = said
        continue
      }
      if (itemType === 'command_execution') {
        const cmd = String(item?.command ?? '')
        const call: WorkerToolCall = { name: 'command_execution', args: cmd }
        if (type === 'item.completed') {
          call.ok = String(item?.status ?? 'completed') === 'completed'
          toolCalls.push(call)
        }
        continue
      }
      if (itemType === 'file_change') {
        toolCalls.push({ name: 'file_change', args: item?.path ?? item?.changes })
        continue
      }
      if (itemType === 'error') {
        const msg = String(item?.message ?? '').trim()
        // 配置警告不是失败：真的执行失败时 codex 会给带 failed 的措辞
        if (/failed|error executing|not found|unauthori[sz]ed|authentication/i.test(msg)) {
          hardError = msg.slice(0, 300)
        }
        continue
      }
      if (itemType === 'reasoning' || itemType === 'todo_list' || itemType === 'web_search') continue
      continue
    }
    if (type === 'turn.completed' && rec.usage) {
      usage = rec.usage as Record<string, unknown>
      continue
    }
    if (type === 'error' && typeof rec.message === 'string') {
      const msg = rec.message
      // 网关层的错优先翻译成人话：这类错的原文几千字，直接抛给用户没意义
      const explained = explainGatewayError(msg)
      if (explained) hardError = explained
      else if (/failed|error executing|authentication/i.test(msg)) hardError = msg.slice(0, 300)
    }
    if (type === 'turn.failed') {
      const err = rec.error as { message?: string } | undefined
      const msg = err?.message ?? ''
      const explained = explainGatewayError(msg)
      if (explained) hardError = explained
      else if (msg) hardError = msg.slice(0, 300)
    }
  }

  return { text, toolCalls, usage, hardError }
}

function lastLine(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const lines = t.split('\n')
  return `：${lines[lines.length - 1].slice(0, 200)}`
}
