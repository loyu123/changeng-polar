import { describe, expect, it } from 'vitest'
import { searchAll } from '../../src/main/node/search'
import type { ChatSession, ProjectDef, TodoDef } from '../../src/shared/types'

/**
 * 全局搜索（现在跑在主进程）。
 * 重点是"命中口径与高亮口径一致"：搜大写词能出结果却不标红，是之前的 bug。
 */

const project = (over: Partial<ProjectDef> = {}): ProjectDef => ({
  id: 'p1',
  name: '记账工具',
  goal: '把每个月的开销记清楚',
  prompts: [],
  createdAt: '',
  ...over
})

const todo = (over: Partial<TodoDef> = {}): TodoDef => ({
  id: 't1',
  projectId: 'p1',
  title: '接入微信账单',
  status: 'todo',
  priority: 'normal',
  createdAt: '',
  ...over
})

const session = (over: Partial<ChatSession> = {}): ChatSession => ({
  id: 's1',
  ts: 1,
  title: '关于 WeChat 的讨论',
  messages: [],
  ...over
})

const base = { projects: [project()], todos: [todo()], sessions: [session()], query: '' }

describe('searchAll · 基本命中', () => {
  it('按项目名命中', () => {
    const hits = searchAll({ ...base, query: '记账' })
    expect(hits.some((h) => h.kind === 'project')).toBe(true)
  })

  it('按项目目标命中', () => {
    const hits = searchAll({ ...base, query: '开销' })
    expect(hits[0]).toMatchObject({ kind: 'project', projectId: 'p1' })
  })

  it('按任务标题命中，副标题带项目名', () => {
    const hits = searchAll({ ...base, query: '微信账单' })
    const task = hits.find((h) => h.kind === 'task')
    expect(task?.sub).toContain('记账工具')
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
    const hits = searchAll({ ...base, query: '微信' })
    const hit = hits.find((h) => h.kind === 'session')
    expect(hit?.messageId).toBeUndefined()
  })

  it('畸形消息结构不抛错', () => {
    const weird = session({ messages: [null, 42, { id: 1 }, { text: '正常文本' }] as unknown[] })
    expect(() => searchAll({ ...base, sessions: [weird], query: '正常' })).not.toThrow()
  })
})

describe('searchAll · 排序与上限', () => {
  it('按 项目 → 方案 → 任务 → 会话 排序', () => {
    const withPlan = project({ plans: [{ id: 'pl1', title: '记账方案', body: '记账方案正文', createdAt: '' }] })
    const hits = searchAll({
      projects: [withPlan, project({ id: 'p2', name: '记账二号', prompts: [] })],
      todos: [todo({ title: '记账任务' })],
      sessions: [session({ title: '记账会话', messages: [] })],
      query: '记账'
    })
    const order = hits.map((h) => h.kind)
    const rank = { project: 0, plan: 1, task: 2, session: 3 }
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]])
    }
  })

  it('结果条数受 limit 限制', () => {
    const many = Array.from({ length: 60 }, (_, i) => project({ id: `p${i}`, name: `记账${i}` }))
    expect(searchAll({ projects: many, todos: [], sessions: [], query: '记账', limit: 10 })).toHaveLength(10)
  })

  it('默认上限 40', () => {
    const many = Array.from({ length: 60 }, (_, i) => project({ id: `p${i}`, name: `记账${i}` }))
    expect(searchAll({ projects: many, todos: [], sessions: [], query: '记账' })).toHaveLength(40)
  })
})
