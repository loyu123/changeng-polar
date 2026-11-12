import { describe, expect, it } from 'vitest'
import { iconOf, labelOf } from '../../src/renderer/src/pages/RecordsPage'
import type { RecordEntry } from '../../src/shared/types'

/**
 * 记录页不能因为「不认识的 kind」整页白屏。
 *
 * 真机踩到过：`records.jsonl` 里躺着 63 条 11 月 3 日的 `kind: "verify"`——
 * 那是「官网查证」功能留下的历史数据，后来功能删了、`RecordKind` 里也没有它了，
 * 但记录还在盘上。渲染时 `KIND_ICON[record.kind]` 拿到 undefined，
 * 读 `.bg` 直接抛，React 把整棵子树带走，用户看到的是**整页白屏**。
 *
 * 这里钉住的不是"verify 该怎么办"，而是**任何未来的 kind 变化都不该让页面打不开**：
 * 历史数据是真实发生过的动作，认不出图标也要照常显示记录本身。
 */

const rec = (patch: Partial<RecordEntry>): RecordEntry =>
  ({
    id: 'x',
    ts: '2026-11-03T03:20:43.960Z',
    kind: 'read',
    title: 't',
    sub: 's',
    result: 'ok',
    reversible: false,
    ...patch
  }) as RecordEntry

describe('记录页 · 不认识的 kind 不能崩', () => {
  it('已删除功能的旧 kind（verify）拿到兜底图标，而不是 undefined', () => {
    const icon = iconOf('verify')
    expect(icon).toBeTruthy()
    expect(typeof icon.bg).toBe('string')
    expect(typeof icon.stroke).toBe('string')
    expect(icon.path).toBeTruthy()
  })

  it('完全没见过的 kind 也走兜底', () => {
    for (const k of ['whatever', '', 'Read', 'read ']) {
      expect(() => iconOf(k)).not.toThrow()
      expect(iconOf(k).bg).toBeTruthy()
    }
  })

  it('八种已知 kind 仍然各有图标（兜底没把正常的吃掉）', () => {
    const known = ['read', 'web', 'ui', 'write', 'destroy', 'refuse', 'memory', 'task']
    const bgs = known.map((k) => iconOf(k).bg)
    // 兜底是灰色；已知的里面至少有好几种不同底色，说明查到的不是同一个兜底
    expect(new Set(bgs).size).toBeGreaterThan(1)
  })

  it('超时未响应优先于结果文案（rejected + expired 要能区分开）', () => {
    const expired = labelOf(rec({ result: 'rejected', authz: 'expired' }))
    const denied = labelOf(rec({ result: 'rejected' }))
    expect(expired.note).toBe('超时未响应')
    expect(denied.note).toBe('已拒绝')
  })

  it('不认识的结果值给"已记录"，不猜也不崩', () => {
    expect(labelOf(rec({ result: 'weird' as never })).note).toBe('已记录')
  })
})
