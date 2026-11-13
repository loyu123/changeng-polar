import { promises as fs } from 'node:fs'
import path from 'node:path'
import { decodeText, looksBinary } from './file'

/**
 * 读日志的**尾巴**。
 *
 * 为什么不能拿 read_file 凑合：read_file 从头切片（`file.ts` 的
 * DEFAULT_MAX_CHARS=3200 / HARD_MAX_CHARS=4000），而「进展到哪了」的答案
 * 全在**末尾**。用 read_file 只能"先问总长度、再带 offset 读最后一段"，
 * 一个文件两轮工具往返，而 TOOL_BUDGET_STEPS 是 5——问一句进展就可能把
 * 预算烧掉一半。这个工具一次就拿到尾巴。
 *
 * 三条与既有代码对齐的口径：
 * - **编码复用 `decodeText` 的阶梯**（BOM → UTF-16 → 严格 UTF-8 → GB18030）。
 *   日志是中文记事本/IDE/重定向都可能产出的，自写一套一定会漏。
 * - **二进制要拒**：日志位置填错成 .docx/.pdf 时，解出来是一串控制字符，
 *   让模型去总结只会得到幻觉。`looksBinary` 判掉，如实说"这不像文本日志"。
 * - **不从文件头开始读**：日志可以很大，只从尾部读固定字节数。
 *   代价是首行可能被切断，所以**从第一个换行之后开始算**，并且明确
 *   告诉调用方"前面还有内容没读"。
 */

/** 一次最多读这么多字节：够 2000 行普通日志，也不至于把内存吃掉 */
export const TAIL_MAX_BYTES = 512 * 1024
/** 默认返回多少行 */
export const TAIL_DEFAULT_LINES = 80
/** 行数上限：再多就不该用这个工具，该做的是缩小范围 */
export const TAIL_MAX_LINES = 1000

export interface TailResult {
  /** 实际读的那个文件（日志位置是目录时，这里会是里面最新的那个） */
  file: string
  /** 尾部内容（按行） */
  text: string
  lines: number
  /** 文件总字节数 */
  bytes: number
  mtime: string
  encoding: string
  /** 上面还有内容没读（文件比读到的多） */
  truncatedFromStart: boolean
  /** 日志位置是目录时，说明"挑的是里面最新的文件" */
  pickedNewest?: string
}

export type TailOutcome = { ok: true; value: TailResult } | { ok: false; reason: string }

/**
 * 日志位置是目录时的挑选规则：取**最近修改**的那个文件。
 *
 * 这是真实形态：这个报告项目的进度日志就是 `.workbuddy/memory/2026-11-13.md`
 * 这种按天分文件的写法。让模型自己去翻"哪个是今天的"是在浪费它的往返次数，
 * 而"最近改的"恰恰就是"最近的进展"。
 *
 * 只在这一层里挑，不递归：日志目录通常就是平铺的，递归下去会挑到备份目录里
 * 的旧快照（`.workbuddy/backup/` 就是这种），反而离"最新"更远。
 */
async function newestFileIn(dir: string): Promise<string | null> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let best: { file: string; mtime: number } | null = null
  for (const e of entries) {
    if (!e.isFile()) continue
    const full = path.join(dir, e.name)
    try {
      const st = await fs.stat(full)
      if (!best || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs }
    } catch {
      /* 读不到的条目跳过：挑最新文件这件事不该被一个坏文件挡住 */
    }
  }
  return best?.file ?? null
}

/**
 * 从尾部读。
 *
 * `start` 的计算是这里唯一的技术点：要保证读到的是**整数个字符**而不是
 * 半个多字节汉字，所以从 `size - bytes` 处开始读之后，丢掉第一个（可能
 * 残缺的）片段。丢掉多少要看编码——但解码前不知道编码，所以做法是：
 * 先解码，再看解出来的首字符是不是替换符 U+FFFD，是就把第一行连同它一起丢掉。
 * 这样对 UTF-8 / GBK 都成立，不用为了切一个字节去猜编码。
 */
export async function readTail(
  filePath: string,
  opts: { lines?: number; maxBytes?: number } = {}
): Promise<TailOutcome> {
  const wantLines = Math.min(Math.max(1, Math.floor(Number(opts.lines ?? TAIL_DEFAULT_LINES)) || TAIL_DEFAULT_LINES), TAIL_MAX_LINES)
  const maxBytes = Math.min(Math.max(1024, Math.floor(Number(opts.maxBytes ?? TAIL_MAX_BYTES)) || TAIL_MAX_BYTES), TAIL_MAX_BYTES)

  let target = filePath
  let pickedNewest: string | undefined

  let st
  try {
    st = await fs.stat(target)
  } catch {
    return { ok: false, reason: `读不到「${target}」（文件不存在，或者当前账号没有权限）` }
  }

  if (st.isDirectory()) {
    const newest = await newestFileIn(target)
    if (!newest) return { ok: false, reason: `「${target}」是个目录，里面没有文件可读` }
    pickedNewest = path.basename(newest)
    target = newest
    try {
      st = await fs.stat(target)
    } catch {
      return { ok: false, reason: `找到了「${newest}」，但读不了它` }
    }
  }

  if (!st.isFile()) return { ok: false, reason: `「${target}」不是普通文件` }

  const size = st.size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length === 0) {
    return {
      ok: true,
      value: {
        file: target,
        text: '',
        lines: 0,
        bytes: 0,
        mtime: st.mtime.toISOString(),
        encoding: '空文件',
        truncatedFromStart: false,
        ...(pickedNewest ? { pickedNewest } : {})
      }
    }
  }

  let buffer: Buffer
  try {
    const handle = await fs.open(target, 'r')
    try {
      buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
    } finally {
      await handle.close()
    }
  } catch (err) {
    return { ok: false, reason: `读「${target}」失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const decoded = decodeText(buffer)
  if (looksBinary(decoded.text)) {
    return {
      ok: false,
      reason: `「${path.basename(target)}」的内容不像文本日志（解出来大多是控制字符）。日志位置可能填错了，或者这个文件根本不是日志`
    }
  }

  /**
   * 从中间开始读时，第一个字符可能是被切断的多字节字符。
   *
   * 丢掉第一个换行之前的所有内容——那半行是不完整的，读出来会让模型
   * 以为日志里有一行怪东西。**但同时要记住"上面还有"**，由
   * truncatedFromStart 说清楚，不能让它以为这就是全文。
   */
  let text = decoded.text
  const cutHead = start > 0
  if (cutHead) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }

  const all = text.split(/\r?\n/)
  // 末尾的空行不算内容：文件以换行结尾时 split 会多出一个 ''
  while (all.length > 0 && all[all.length - 1] === '') all.pop()

  const tail = all.slice(-wantLines)

  return {
    ok: true,
    value: {
      file: target,
      text: tail.join('\n'),
      lines: tail.length,
      bytes: size,
      mtime: st.mtime.toISOString(),
      encoding: decoded.encoding,
      // 两种情况都算"前面还有"：读了半截文件，或者文件比要求看的长
      truncatedFromStart: cutHead || all.length > tail.length,
      ...(pickedNewest ? { pickedNewest } : {})
    }
  }
}
