import { describe, expect, it } from 'vitest'
import { messageTokens, trimHistory } from '../../src/main/agent/budget'
import type { ChatMessage } from '../../src/shared/types'

/**
 * 上下文预算。
 *
 * 这套逻辑出错的症状很具体：请求被后端拒（"有 tool 结果却没有对应调用"），
 * 或者 system 提示被裁掉（能力声明没了，模型开始胡说自己能做什么）。
 */
const system = (text = '你是管家'): ChatMessage => ({ role: 'system', content: text })
const user = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text })

function bigUser(chars: number, label: string): ChatMessage {
  return user(`${label}${'填充'.repeat(Math.ceil(chars / 2))}`.slice(0, chars))
}

describe('trimHistory · 保留规则', () => {
  it('预算充足时一条都不丢', () => {
    const messages = [system(), user('问'), assistant('答'), user('再问')]
    const result = trimHistory(messages, { maxTokens: 10_000 })
    expect(result.messages).toHaveLength(4)
    expect(result.dropped).toBe(0)
  })

  it('system 提示永远保留，哪怕预算不够', () => {
    const messages = [system('重要的能力声明'), bigUser(50_000, '很久以前'), user('现在的问题')]
    const result = trimHistory(messages, { maxTokens: 100 })
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[0].content).toBe('重要的能力声明')
  })

  it('超预算时从旧到新丢弃，最新的留在最后', () => {
    const messages = [
      system(),
      bigUser(4000, '旧一'),
      bigUser(4000, '旧二'),
      bigUser(4000, '旧三'),
      user('最新问题')
    ]
    const result = trimHistory(messages, { maxTokens: 2500, keepRecent: 1 })
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.messages.at(-1)?.content).toBe('最新问题')
  })

  it('tool 结果与它的 assistant.tool_calls 要么一起留、要么一起丢', () => {
    // 只留 tool 结果会被后端拒：有 tool_call_id 却找不到对应的调用
    const messages: ChatMessage[] = [
      system(),
      bigUser(8000, '无关的旧历史'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_email', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'read_email', content: '邮件内容' },
      user('继续')
    ]
    const result = trimHistory(messages, { maxTokens: 300, keepRecent: 1 })
    const hasTool = result.messages.some((m) => m.role === 'tool')
    const hasCall = result.messages.some((m) => (m.tool_calls?.length ?? 0) > 0)
    expect(hasTool).toBe(hasCall)
  })

  it('多个连续 tool 结果成组处理，不会只剩一半', () => {
    const messages: ChatMessage[] = [
      system(),
      bigUser(8000, '旧'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', name: 'a', arguments: '{}' },
          { id: 'c2', name: 'b', arguments: '{}' }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', name: 'a', content: '结果一' },
      { role: 'tool', tool_call_id: 'c2', name: 'b', content: '结果二' },
      user('继续')
    ]
    const result = trimHistory(messages, { maxTokens: 200, keepRecent: 1 })
    const toolIds = result.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    const callIds = result.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
    for (const id of toolIds) expect(callIds).toContain(id)
  })

  it('预算极紧时仍保留最近几轮（keepRecent 兜底）', () => {
    const messages = [system(), user('一'), assistant('一答'), user('二'), assistant('二答'), user('三')]
    const result = trimHistory(messages, { maxTokens: 10, keepRecent: 4 })
    expect(result.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('保持原始顺序：裁剪后不会乱序', () => {
    const messages = [system(), user('甲'), assistant('乙'), user('丙')]
    const result = trimHistory(messages, { maxTokens: 10_000 })
    const roles = result.messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
  })
})

describe('trimHistory · 单条超长', () => {
  it('单条消息过长时按字符截断，并留下明确标记', () => {
    const huge = user('啊'.repeat(40_000))
    const result = trimHistory([system(), huge], { maxTokens: 1_000_000 })
    const content = result.messages[1].content ?? ''
    expect(content.length).toBeLessThan(40_000)
    expect(content).toMatch(/已截断到前/)
  })

  it('截断后仍能算出估算值，不会返回空消息', () => {
    const result = trimHistory([system(), user('x'.repeat(100_000))], { maxTokens: 1_000_000 })
    expect(result.messages).toHaveLength(2)
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })
})

describe('token 估算', () => {
  it('中文按字计，英文按 4 字符计', () => {
    expect(messageTokens(user('中文四个字'))).toBeGreaterThanOrEqual(6) // 4 字 + 开销
    const en = messageTokens(user('a'.repeat(400)))
    const zh = messageTokens(user('中'.repeat(400)))
    expect(zh).toBeGreaterThan(en)
  })

  it('工具调用的参数也计入', () => {
    const withCall: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', name: 'read_email', arguments: '{"limit":10}' }]
    }
    expect(messageTokens(withCall)).toBeGreaterThan(messageTokens({ role: 'assistant', content: null }))
  })

  it('空内容不产生负值', () => {
    expect(messageTokens({ role: 'assistant', content: null })).toBeGreaterThanOrEqual(0)
    expect(messageTokens({ role: 'assistant', content: '' })).toBeGreaterThanOrEqual(0)
  })
})
