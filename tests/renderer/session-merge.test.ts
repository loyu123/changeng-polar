import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../../src/shared/types'

/**
 * 三边会话合并显示。
 *
 * 起因：用户在手机上说了话、在桌面悬浮球里说了话，回到主窗口「最近」里找不到。
 * 分开存是内部实现，但用户不该为此付出"我明明问过却找不到"的代价。
 *
 * 这里复刻的是 ChatPage 里 `mergeSessions` 的规则（渲染层没有 DOM 环境，
 * 只能把规则单独测；组件那边用它，两边改一处就得一起改）。
 */

interface Session {
  id: string
  ts: number
  title: string
  origin?: 'orb' | 'remote'
}

function mergeSessions(main: ChatSession[], orb: ChatSession[]): Session[] {
  const out = new Map<string, Session>()
  for (const raw of main) out.set(raw.id, { id: raw.id, ts: raw.ts, title: raw.title, ...(raw.origin ? { origin: raw.origin } : {}) })
  for (const raw of orb) {
    if (out.has(raw.id)) continue
    out.set(raw.id, { id: raw.id, ts: raw.ts, title: raw.title, origin: raw.origin ?? 'orb' })
  }
  return [...out.values()].sort((a, b) => b.ts - a.ts)
}

const s = (id: string, ts: number, origin?: 'orb' | 'remote'): ChatSession =>
  ({ id, ts, title: id, messages: [], ...(origin ? { origin } : {}) }) as ChatSession

describe('会话合并', () => {
  it('悬浮球的会话会出现在列表里，并标上来源', () => {
    const merged = mergeSessions([s('a', 2)], [s('b', 1)])
    expect(merged.map((x) => x.id)).toEqual(['a', 'b'])
    expect(merged.find((x) => x.id === 'b')?.origin).toBe('orb')
  })

  it('手机的会话保留 remote 标记（不被当成桌面）', () => {
    const merged = mergeSessions([s('r', 3, 'remote')], [])
    expect(merged[0].origin).toBe('remote')
  })

  it('同一个 id 两边都有时只留一份，且以主窗口那份为准（它带着后续上下文）', () => {
    const merged = mergeSessions([s('x', 5, 'remote')], [s('x', 1)])
    expect(merged).toHaveLength(1)
    expect(merged[0].ts).toBe(5)
    expect(merged[0].origin).toBe('remote')
  })

  it('按时间倒序：刚聊的排前面，不管它来自哪儿', () => {
    const merged = mergeSessions([s('old', 1), s('new', 9)], [s('mid', 5)])
    expect(merged.map((x) => x.id)).toEqual(['new', 'mid', 'old'])
  })

  it('主窗口会话没有 origin 时保持没有（不硬塞一个"桌面"标签）', () => {
    const merged = mergeSessions([s('a', 1)], [])
    expect(merged[0].origin).toBeUndefined()
  })

  it('两边都空时返回空数组，不抛', () => {
    expect(mergeSessions([], [])).toEqual([])
  })
})
