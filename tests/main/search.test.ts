import { describe, expect, it } from 'vitest'
import { searchAll } from '../../src/main/node/search'
import type { ChatSession } from '../../src/shared/types'

/**
 * 全局搜索（现在跑在主进程）。
 * 重点是"命中口径与高亮口径一致"：搜大写词能出结果却不标红，是之前的 bug。
 *
 * 早先这里还覆盖「项目/方案/待办」，那一套已经整块移除（页面、数据、IPC 都没了），
 * 用例一并删掉；现在只剩会话一类。
 */

const session = (over: Partial<ChatSession> = {}): ChatSession => ({
  id: 's1',
  ts: 1,
  title: '关于 WeChat 的讨论',
  messages: [],
  ...over
})

const base = { sessions: [session()], query: '' }

describe('searchAll · 基本命中', () => {
  it('按会话标题命中', () => {
    const hits = searchAll({ ...base, query: 'WeChat' })
    expect(hits[0]).toMatchObject({ kind: 'session', sessionId: 's1' })
  })

  it('大小写不敏感（这是之前高亮不出色的根因）', () => {
    const upper = searchAll({ ...base, query: 'WeChat' })
    const lower = searchAll({ ...base, query: 'wechat' })
    expect(upper.map((h) => h.key)).toEqual(lower.map((h) => h.key))
    expect(upper.length).toBeGreaterThan(0)
  })

  it('空查询返回空结果', () => {
    expect(searchAll({ ...base, query: '' })).toEqual([])
    expect(searchAll({ ...base, query: '   ' })).toEqual([])
  })
})

describe('searchAll · 会话正文', () => {
  const withBody = session({
    id: 's2',
    title: '无关标题',
    messages: [
      { id: 'm1', text: '先看看这个' },
      { id: 'm2', text: '这个软件的官网地址是 example.com' }
    ]
  })

  it('正文命中时带回 messageId（用于定位到那条消息）', () => {
    const hits = searchAll({ ...base, sessions: [withBody], query: 'example' })
    const hit = hits.find((h) => h.kind === 'session')
    expect(hit).toMatchObject({ sessionId: 's2', messageId: 'm2' })
  })

  it('摘要从命中位置附近截，而不是永远从头截', () => {
    const long = session({
      id: 's3',
      title: '标题',
      messages: [{ id: 'm1', text: `${'前置内容'.repeat(40)}关键命中词${'后置内容'.repeat(40)}` }]
    })
    const hit = searchAll({ ...base, sessions: [long], query: '关键命中词' }).find((h) => h.kind === 'session')
    expect(hit?.sub).toContain('关键命中词')
    expect(hit?.sub.startsWith('…')).toBe(true)
  })

  it('单字符不搜会话正文（命中率低且慢）', () => {
    const hits = searchAll({ ...base, sessions: [withBody], query: 'e' })
    expect(hits.some((h) => h.kind === 'session')).toBe(false)
  })

  it('标题命中时 messageId 为空（定位到会话即可）', () => {
    const hits = searchAll({ ...base, query: 'WeChat' })
    const hit = hits.find((h) => h.kind === 'session')
    expect(hit?.messageId).toBeUndefined()
  })

  it('畸形消息结构不抛错', () => {
    const weird = session({ messages: [null, 42, { id: 1 }, { text: '正常文本' }] as unknown[] })
    expect(() => searchAll({ ...base, sessions: [weird], query: '正常' })).not.toThrow()
  })
})

describe('searchAll · 上限', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    session({ id: `s${i}`, title: `记账${i}`, messages: [] })
  )

  it('结果条数受 limit 限制', () => {
    expect(searchAll({ sessions: many, query: '记账', limit: 10 })).toHaveLength(10)
  })

  it('默认上限 40', () => {
    expect(searchAll({ sessions: many, query: '记账' })).toHaveLength(40)
  })
})
