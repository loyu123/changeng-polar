import { randomUUID } from 'node:crypto'
import { MEMORY_KIND_LABEL, type MemoryEntry, type MemoryKind } from '../../shared/types'

/**
 * 跨会话记忆。
 *
 * 为什么要有它：sessions / tasks / notes 是各管各的文件，
 * 每次对话只带本会话最近 12 条历史。于是"我说过我偏好什么""上次做到哪"
 * 这类事，换一次对话就全丢了——一个叫管家、却记不住主人的东西。
 *
 * 边界（这块很容易做歪，先写清楚）：
 * - 只存"以后还用得上的一句话"，不存聊天记录（那是 sessions.json 的事）
 * - 由模型显式调用工具写入，不自动抽取：自动抽取等于让模型自己决定
 *   什么值得长期记住，很容易把一次性的上下文固化成"事实"
 * - 注入提示词时有条数与字数上限，且**明说这些是可能过期的旧记录**——
 *   记忆是线索，不是证据；回答本机事实仍然要以当次工具结果为准
 */

export const MEMORY_MAX_ENTRIES = 200
export const MEMORY_MAX_TEXT = 200
/** 注入提示词的条数上限：太多会挤占预算，也会让模型抓不住重点 */
export const MEMORY_INJECT_LIMIT = 40
/** 注入提示词的总字数上限 */
export const MEMORY_INJECT_CHARS = 1500

const VALID_KINDS: MemoryKind[] = ['user', 'preference', 'project', 'fact']

export function normalizeKind(raw: unknown): MemoryKind {
  return VALID_KINDS.includes(raw as MemoryKind) ? (raw as MemoryKind) : 'fact'
}

/** 折叠空白并截断：记忆是一条一句话，换行会把它变成半篇文章 */
export function normalizeText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEMORY_MAX_TEXT)
}

/**
 * 判断两条记忆是不是"同一件事"。
 *
 * 不做模糊匹配也不做相似度：宁可留下两条措辞不同的记录让用户自己删，
 * 也不要因为算法判断"差不多"就把用户的两句话合成一句。
 * 只做归一化后的精确比对（大小写、标点、空白差异不算不同）。
 */
export function sameMemory(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[\s，,。.！!？?；;：:、"'“”‘’()（）]/g, '')
  return norm(a) === norm(b) && norm(a).length > 0
}

export interface SaveMemoryInput {
  kind?: unknown
  text?: unknown
  source?: string
}

export type SaveMemoryResult =
  | { ok: true; entry: MemoryEntry; replaced: boolean }
  | { ok: false; reason: string }

/**
 * 把一次保存意图合并进现有列表。
 *
 * 返回新的完整列表：调用方把它写回磁盘，不需要自己再拼一遍。
 */
export function mergeMemory(
  list: MemoryEntry[],
  input: SaveMemoryInput,
  now = new Date().toISOString()
): SaveMemoryResult & { list: MemoryEntry[] } {
  const text = normalizeText(input.text)
  if (!text) return { ok: false, reason: '没有给出要记住的内容', list }

  const kind = normalizeKind(input.kind)
  const existing = list.find((item) => sameMemory(item.text, text))
  if (existing) {
    // 同一件事又说了一遍：只刷新时间，不堆重复条目
    const updated: MemoryEntry = { ...existing, kind, updatedAt: now }
    return {
      ok: true,
      entry: updated,
      replaced: true,
      list: list.map((item) => (item.id === existing.id ? updated : item))
    }
  }

  const entry: MemoryEntry = {
    id: randomUUID(),
    kind,
    text,
    createdAt: now,
    updatedAt: now,
    source: input.source
  }

  // 超出上限时丢最久没被确认的那条：常用的事会一直被刷新 updatedAt，自然留下来
  const next = [entry, ...list]
  if (next.length > MEMORY_MAX_ENTRIES) {
    const sorted = [...next].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return { ok: true, entry, replaced: false, list: sorted.slice(0, MEMORY_MAX_ENTRIES) }
  }
  return { ok: true, entry, replaced: false, list: next }
}

/** 按 id 或原文删除；返回删除后的列表与是否真的删掉了 */
export function removeMemory(list: MemoryEntry[], ref: string): { list: MemoryEntry[]; removed: MemoryEntry | null } {
  const needle = String(ref ?? '').trim()
  if (!needle) return { list, removed: null }
  const hit = list.find((item) => item.id === needle) ?? list.find((item) => sameMemory(item.text, needle))
  if (!hit) return { list, removed: null }
  return { list: list.filter((item) => item.id !== hit.id), removed: hit }
}

/**
 * 生成注入系统提示词的那一段。
 *
 * 刻意写成"参考，不是证据"：这些是过去说过的话，可能已经过时。
 * 如果让模型把记忆当成事实来源，它会用三个月前的一句偏好去回答
 * "我现在装了什么"这种必须查的问题。
 */
export function memoryBlock(list: MemoryEntry[]): string {
  if (list.length === 0) return ''

  const sorted = [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const lines: string[] = []
  let used = 0
  for (const item of sorted.slice(0, MEMORY_INJECT_LIMIT)) {
    const line = `- 〔${MEMORY_KIND_LABEL[item.kind] ?? '记录'}〕${item.text}`
    if (used + line.length > MEMORY_INJECT_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''

  return [
    '## 你记得的事',
    '下面是你之前记下的内容（用户让你记的，或你判断值得长期记住的）。',
    '**这是线索，不是证据**：它可能已经过时。涉及"这台机器现在装了什么 / 有什么"这类事实，仍然必须先调工具查，不能拿记忆当答案。',
    '用户明确纠正时，以用户这次说的为准，并考虑更新记忆。',
    ...lines
  ].join('\n')
}
