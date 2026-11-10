import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnCollect, type WorkerBackend, type WorkerRunOptions, type WorkerRunResult, type WorkerToolCall } from './types'

/**
 * codebuddy 后端：WorkBuddy 内置的那套 CLI（`codebuddy-lite-wb.mjs`）。
 *
 * 形态是"起 node 跑一个 .mjs 脚本 → 提示词进 → 文本出 → 退出"，一次性。
 *
 * 一个实测坑：**没登录时会返回成功退出码加一行提示**——
 * `Authentication required. Please use /login command to sign in to your account`。
 * 退出码是 0，所以光看退出码会当成"跑完了但没说话"。这里显式识别这句话并判失败。
 *
 * 永不传 `-y/--dangerously-skip-permissions`；限权走 `--tools` 白名单。
 */

export interface CodebuddyOptions {
  /** 默认去找 WorkBuddy 里那个内置 CLI */
  scriptPath?: string
  /** 允许用的工具，逗号分隔；空数组 = 全部禁用 */
  tools: string[]
  timeoutMs: number
}

const DEFAULT_CANDIDATES = [
  'D:\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')
]

export function findCodebuddyScript(): string | null {
  for (const p of DEFAULT_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 构造参数。
 *
 * 两个实测坑：
 * 1. **`--tools` 是变参**，后面紧跟的位置参数会被它吞掉。原本写成
 *    `-p --output-format json --tools '' "提示词"`，提示词被当成工具名吃了，
 *    codebuddy 在"没有提示词"的状态下跑完，返回一个 `result: ""` 的成功结果——
 *    看起来像"跑完了但没说话"。所以提示词必须紧跟 `-p`，选项全部放后面。
 * 2. **空参数在 shell 下会消失**（Windows 上面要过 shell）。`--tools ""` 里的空字符串
 *    传不到对方，只剩一个孤零零的 `--tools`。工具清单为空时改用一个不存在的工具名，
 *    效果同样是"一个工具都不给"，而且不会被 shell 吃掉。
 */
export function buildCodebuddyArgs(o: CodebuddyOptions): string[] {
  const tools = o.tools.length > 0 ? o.tools.join(',') : NO_TOOLS_SENTINEL
  return ['-p', '--output-format', 'json', '--tools', tools]
}

/** 一个永远不会存在的工具名：等价于"不给任何工具"，且不会被 shell 吞掉 */
const NO_TOOLS_SENTINEL = '__polar_no_tools__'

/** 登录提示的识别：这句出现就是没登录，不是"跑完了没说话" */
const NOT_LOGGED_IN_RE = /Authentication required|Please use \/login|not signed in|未登录/i

export class CodebuddyBackend implements WorkerBackend {
  readonly kind = 'codebuddy' as const
  constructor(private readonly opts: CodebuddyOptions) {}

  private script(): string | null {
    return this.opts.scriptPath?.trim() || findCodebuddyScript()
  }

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.script()) {
      return {
        ok: false,
        reason:
          '找不到 codebuddy-lite-wb.mjs。它随 WorkBuddy 安装，默认在 ' +
          'D:\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\。装在别处就在配置里填 scriptPath。'
      }
    }
    return { ok: true }
  }

  async run(opts: WorkerRunOptions): Promise<WorkerRunResult> {
    const script = this.script()
    if (!script) {
      const r = await this.ready()
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: r.reason }
    }

    // 用 node 跑脚本；node 走 PATH
    const res = await spawnCollect('node', [script, ...buildCodebuddyArgs(this.opts)], {
      cwd: opts.workDir,
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
      shell: process.platform === 'win32',
      stdin: opts.prompt
    })

    const combined = `${res.stdout}\n${res.stderr}`
    if (NOT_LOGGED_IN_RE.test(combined)) {
      return {
        ok: false,
        text: '',
        toolCalls: [],
        exitCode: res.code,
        failureReason:
          'codebuddy 没有登录：这个 CLI 需要先登录一次才能非交互使用。' +
          '在终端里跑一次 `node "' + script + '" ` 进交互界面，用 /login 登录后再派发。'
      }
    }
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

    const parsed = parseCodebuddyOutput(res.stdout)
    if (!parsed.text.trim()) {
      return {
        ok: false,
        text: '',
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
        exitCode: res.code,
        failureReason: `codebuddy 没有给出回答（退出码 ${res.code}）${tail(res.stderr)}`
      }
    }
    return {
      ok: res.code === 0,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      exitCode: res.code,
      failureReason: res.code === 0 ? undefined : `codebuddy 退出码 ${res.code}${tail(res.stderr)}`
    }
  }
}

interface CodebuddyParse {
  text: string
  toolCalls: WorkerToolCall[]
  usage?: Record<string, unknown>
}

/**
 * 解析 codebuddy 的输出。
 *
 * 实测形状：`--output-format json` 给的是一个 **JSON 数组**（不是对象，也不是 JSONL），
 * 里面最后一条 `{"type":"result","subtype":...,"result":"...",...}` 才是回答。
 * 之前只认 `{` 开头，数组就漏了，结果把整段 JSON 当回答交上去——所以这里
 * 三种形状都认：数组、单个对象、JSONL。全认不出才退回纯文本。
 */
export function parseCodebuddyOutput(stdout: string): CodebuddyParse {
  const trimmed = stdout.trim()
  if (!trimmed) return { text: '', toolCalls: [] }

  // 形状 1：单个对象
  const obj = tryParseJson(trimmed)
  if (obj) return fromRecord(obj)

  // 形状 2：数组 —— 取最后一个带 result 的元素
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown
      if (Array.isArray(arr)) {
        let text = ''
        let usage: Record<string, unknown> | undefined
        for (const el of arr) {
          if (!el || typeof el !== 'object') continue
          const r = fromRecord(el as Record<string, unknown>)
          if (r.text) text = r.text
          if (r.usage) usage = r.usage
        }
        // 结构认出来了但 result 是空的（典型是"没登录，空跑一轮"）：
        // 必须返回空串，让调用方判失败。这里退回原文等于把一段 JSON 当回答交上去。
        return { text, toolCalls: [], usage }
      }
    } catch {
      /* 不是合法数组，往下走 */
    }
  }

  // 形状 3：JSONL
  const lines = trimmed.split('\n')
  if (lines.some((l) => l.trim().startsWith('{'))) {
    let text = ''
    let usage: Record<string, unknown> | undefined
    let recognized = false
    for (const line of lines) {
      const rec = tryParseJson(line.trim())
      if (!rec) continue
      recognized = true
      const r = fromRecord(rec)
      if (r.text) text = r.text
      if (r.usage) usage = r.usage
    }
    if (recognized) return { text, toolCalls: [], usage }
  }

  // 认不出结构：整段当文本，至少不丢回答
  return { text: trimmed, toolCalls: [] }
}

function fromRecord(obj: Record<string, unknown>): CodebuddyParse {
  const text = pickString(obj, ['result', 'response', 'text', 'output', 'content', 'message']) ?? ''
  const usage = (obj.usage ?? obj.tokenUsage) as Record<string, unknown> | undefined
  return { text: text.trim(), toolCalls: [], usage }
}

function tryParseJson(s: string): Record<string, unknown> | null {
  if (!s.startsWith('{')) return null
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function tail(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const lines = t.split('\n')
  return `：${lines[lines.length - 1].slice(0, 200)}`
}
