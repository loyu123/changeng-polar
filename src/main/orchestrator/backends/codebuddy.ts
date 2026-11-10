import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnCollect, type WorkerBackend, type WorkerRunOptions, type WorkerRunResult, type WorkerToolCall } from './types'

/**
 * codebuddy 后端。
 *
 * **这台机器上有两个不同的 codebuddy，登录态不共用**（2026-11-10 实测）：
 * 1. 独立的 npm 全局包 `codebuddy`（v2.182+）——能非交互跑，**默认用这个**
 * 2. WorkBuddy 内置的 `codebuddy-lite-wb.mjs`——同一个包装的另一套，
 *    在独立版已登录的情况下它仍然报 `Authentication required`
 *
 * 所以默认优先级是：`codebuddy` 命令 → 内置 `.mjs` 兜底。
 * 两个都不是就能明确报"没装"，而不是猜。
 *
 * 另外两个实测坑：
 * - **`--tools` 是变参**，会吞掉后面的位置参数，所以提示词走 stdin。
 * - **未登录时返回退出码 0 + 空 result**，光看退出码会当成"跑完了没说话"。
 */

export interface CodebuddyOptions {
  /** 显式指定可执行文件或脚本；空则按 codebuddy → 内置 mjs 的顺序找 */
  binPath?: string
  /** 允许用的工具，逗号分隔；空数组 = 一个都不给 */
  tools: string[]
  timeoutMs: number
}

/** 内置 CLI 的常见位置（独立版命令不在这里，靠 PATH 找） */
const BUNDLED_CANDIDATES = [
  'D:\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\dist\\codebuddy-lite-wb.mjs',
  path.join(
    os.homedir(),
    'AppData',
    'Local',
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'dist',
    'codebuddy-lite-wb.mjs'
  )
]

export function findBundledCodebuddy(): string | null {
  for (const p of BUNDLED_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return null
}

/** 一个要执行的命令：独立版直接调，内置版要过 node */
export interface CodebuddyInvocation {
  bin: string
  args: string[]
  /** 是不是内置 .mjs（决定要不要过 node、要不要过 shell） */
  bundled: boolean
}

export function resolveCodebuddyInvocation(o: CodebuddyOptions): CodebuddyInvocation | null {
  const explicit = o.binPath?.trim()
  if (explicit) {
    const bundled = explicit.toLowerCase().endsWith('.mjs')
    return { bin: bundled ? 'node' : explicit, args: buildCodebuddyArgs(o), bundled }
  }
  // 独立版优先：它在 PATH 上，登录态独立可用
  return { bin: 'codebuddy', args: buildCodebuddyArgs(o), bundled: false }
}

/**
 * 构造参数。
 *
 * 三个实测坑：
 * 1. **`--tools` 是变参**，后面紧跟的位置参数会被它吞掉。
 *    原本写成 `-p --output-format json --tools '' "提示词"`，提示词被当成工具名吃了，
 *    codebuddy 在"没有提示词"的状态下跑完，返回一个 `result: ""` 的成功结果——
 *    看起来像"跑完了但没说话"。所以提示词走 stdin。
 * 2. **空参数在 shell 下会消失**（Windows 上要过 shell）。`--tools ""` 里的空字符串
 *    传不到对方，只剩一个孤零零的 `--tools`。工具清单为空时改用一个不存在的工具名。
 * 3. **非交互模式下写文件会被权限拦住。** 实测它确实调了 Write，然后回一句
 *    "Write 工具被拒绝…请用 -y 或 --permission-mode bypassPermissions"。
 *    这里用 `acceptEdits`：**只自动放行文件编辑，不放行危险命令**，
 *    比 `bypassPermissions` 窄得多，更不碰 `--dangerously-skip-permissions`。
 *    只给了 write 工具时才加这个档；纯只读任务不加，多一分限制都不放松。
 */
export function buildCodebuddyArgs(o: CodebuddyOptions): string[] {
  const tools = o.tools.length > 0 ? o.tools.join(',') : NO_TOOLS_SENTINEL
  const args = ['-p', '--output-format', 'json', '--tools', tools]
  if (o.tools.some((t) => /^(write|edit)$/i.test(t))) args.push('--permission-mode', 'acceptEdits')
  return args
}

/** 一个永远不会存在的工具名：等价于"不给任何工具"，且不会被 shell 吞掉 */
const NO_TOOLS_SENTINEL = '__polar_no_tools__'

/** 登录提示的识别：这句出现就是没登录，不是"跑完了没说话" */
const NOT_LOGGED_IN_RE = /Authentication required|Please use \/login|not signed in|未登录/i

export class CodebuddyBackend implements WorkerBackend {
  readonly kind = 'codebuddy' as const
  constructor(private readonly opts: CodebuddyOptions) {}

  async ready(): Promise<{ ok: boolean; reason?: string }> {
    const inv = resolveCodebuddyInvocation(this.opts)
    if (!inv) {
      return {
        ok: false,
        reason:
          '找不到 codebuddy。需要一个能非交互跑的命令：' +
          '`npm i -g codebuddy` 装独立版（需先登录），或在配置里填 binPath 指向 WorkBuddy 内置的 .mjs。'
      }
    }
    return { ok: true }
  }

  async run(opts: WorkerRunOptions): Promise<WorkerRunResult> {
    const inv = resolveCodebuddyInvocation(this.opts)
    if (!inv) {
      const r = await this.ready()
      return { ok: false, text: '', toolCalls: [], exitCode: null, failureReason: r.reason }
    }

    const args = inv.bundled ? [this.opts.binPath!.trim(), ...inv.args] : inv.args
    const res = await spawnCollect(inv.bin, args, {
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
          `codebuddy 没有登录（用的是 ${inv.bundled ? 'WorkBuddy 内置 CLI' : '独立版 codebuddy'}）。` +
          '注意这台机器上有两个 codebuddy，登录态不共用：独立版在终端跑一次 `codebuddy` 然后 /login；' +
          '内置版则要 `node <那个 .mjs>` 再 /login。'
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
