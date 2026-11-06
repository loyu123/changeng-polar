import type { ChatMessage } from '../../shared/types'

/**
 * 请求前的上下文预算。
 *
 * 之前历史是全量塞进请求的：每步工具结果上限 6000 字符、最多 5 步、
 * 加上整段会话历史，长会话迟早撞上模型的上下文窗口，表现是请求直接报错，
 * 而报错信息通常只有一句 "maximum context length"，用户看不出为什么。
 *
 * 策略：
 * - system 提示永不裁（能力声明、不可信内容规则都在里面）
 * - 其余按"从旧到新"保留，直到预算用完；成对的
 *   assistant.tool_calls 与 tool 结果要么一起留、要么一起丢，
 *   否则请求会被后端拒（有 tool 结果却没有对应的调用）
 * - 再切一刀保底：单条消息超过上限时按字符截断，避免一条巨大的邮件正文
 *   把整个预算吃光
 */

/**
 * 粗略 token 估算。
 *
 * 不引 tokenizer：多一种依赖就多一处和模型对不上的地方，而这里要的
 * 只是"大概不超"——留足余量比算得准更重要。
 * 中文字符约 1 字 1 token，英文约 4 字符 1 token，其余按 2 字符 1 token 折中。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、日文假名、韩文
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 一条消息的估算（含工具调用的参数） */
export function messageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content ?? '') + 4
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(call.arguments) + 8
  }
  return total
}

/** 单条消息的字符上限：超了就截断，并留下明确标记 */
const MAX_MESSAGE_CHARS = 24_000

function clipMessage(message: ChatMessage): ChatMessage {
  const content = message.content
  if (!content || content.length <= MAX_MESSAGE_CHARS) return message
  const kept = content.slice(0, MAX_MESSAGE_CHARS)
  return {
    ...message,
    content: `${kept}\n\n…（这条内容过长，已截断到前 ${MAX_MESSAGE_CHARS} 字符，共 ${content.length} 字符）`
  }
}

export interface TrimOptions {
  /** 总 token 预算 */
  maxTokens: number
  /** 保留的最近消息条数下限：无论预算多紧，至少留这么多轮 */
  keepRecent?: number
}

export interface TrimResult {
  messages: ChatMessage[]
  /** 被丢掉的消息条数（用于审计与提示） */
  dropped: number
  /** 估算的 token 数（裁剪后） */
  estimatedTokens: number
}

/**
 * 按预算裁剪历史。
 *
 * system 消息全部保留在最前面；其余从最新往回取，成对的消息一起保留。
 * 返回的 messages 仍然保持原始顺序。
 */
export function trimHistory(messages: ChatMessage[], options: TrimOptions): TrimResult {
  const { maxTokens, keepRecent = 6 } = options
  const clipped = messages.map(clipMessage)

  const system = clipped.filter((m) => m.role === 'system')
  const rest = clipped.filter((m) => m.role !== 'system')

  let budget = maxTokens - system.reduce((sum, m) => sum + messageTokens(m), 0)
  // 预算已经被 system 吃光时不再硬塞：留 0 条也比发出一个超限请求好，
  // 但下面 keepRecent 会兜底保留最近几条
  const picked: ChatMessage[] = []

  // 从最新往回走，成对处理
  let i = rest.length - 1
  while (i >= 0) {
    const message = rest[i]
    // tool 结果必须带上它前面的 assistant.tool_calls，否则后端会拒绝
    if (message.role === 'tool') {
      let j = i - 1
      while (j >= 0 && rest[j].role === 'tool') j -= 1
      const pair = rest.slice(Math.max(0, j), i + 1)
      const cost = pair.reduce((sum, m) => sum + messageTokens(m), 0)
      if (picked.length >= keepRecent && cost > budget) break
      picked.unshift(...pair)
      budget -= cost
      i = j - 1
      continue
    }
    const cost = messageTokens(message)
    if (picked.length >= keepRecent && cost > budget) break
    picked.unshift(message)
    budget -= cost
    i -= 1
  }

  // 保底：预算极紧时仍要保证最近 keepRecent 条在场（一轮完整的问答）
  const recentFloor = rest.slice(-keepRecent)
  const merged = picked.length >= recentFloor.length ? picked : recentFloor

  return {
    messages: [...system, ...merged],
    dropped: rest.length - merged.length,
    estimatedTokens: [...system, ...merged].reduce((sum, m) => sum + messageTokens(m), 0)
  }
}
