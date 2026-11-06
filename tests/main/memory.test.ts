import { describe, expect, it } from 'vitest'
import {
  MEMORY_INJECT_CHARS,
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_TEXT,
  memoryBlock,
  mergeMemory,
  normalizeKind,
  normalizeText,
  removeMemory,
  sameMemory
} from '../../src/main/node/memory'
import type { MemoryEntry } from '../../src/shared/types'

/**
 * 跨会话记忆。
 *
 * 这块最容易做歪的地方：把记忆当成事实来源。所以除了增删改，
 * 重点测两件事——重复保存不堆条目、注入提示词时明确说"可能过时"。
 */

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: over.id ?? 'm1',
  kind: 'fact',
  text: '一条记忆',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

describe('规范化', () => {
  it('折叠空白并截断到上限', () => {
    expect(normalizeText('  多行\n文本   带空格  ')).toBe('多行 文本 带空格')
    expect(normalizeText('啊'.repeat(500))).toHaveLength(MEMORY_MAX_TEXT)
  })

  it('非法类型回落到 fact', () => {
    expect(normalizeKind('preference')).toBe('preference')
    expect(normalizeKind('瞎写')).toBe('fact')
    expect(normalizeKind(undefined)).toBe('fact')
  })

  it('同一条记忆只差标点/大小写/空白时判定为同一件事', () => {
    expect(sameMemory('喜欢简洁的回答', '喜欢简洁的回答。')).toBe(true)
    expect(sameMemory('用 WeChat 联系我', '用 wechat 联系我')).toBe(true)
    expect(sameMemory('喜欢简洁的回答', '喜欢详细的回答')).toBe(false)
  })

  it('空内容不判为同一件事（否则删除会误伤）', () => {
    expect(sameMemory('', '')).toBe(false)
    expect(sameMemory('   ', '　')).toBe(false)
  })
})

describe('mergeMemory · 新增', () => {
  it('空内容拒绝保存', () => {
    const out = mergeMemory([], { text: '   ' })
    expect(out.ok).toBe(false)
    expect(out.list).toEqual([])
  })

  it('新内容加到最前面', () => {
    const out = mergeMemory([entry({ id: 'old', text: '旧的' })], { text: '新的', kind: 'preference' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.list[0].text).toBe('新的')
    expect(out.list[0].kind).toBe('preference')
    expect(out.replaced).toBe(false)
    expect(out.list).toHaveLength(2)
  })

  it('类型缺省时按 fact 存', () => {
    const out = mergeMemory([], { text: '随便一件事' })
    expect(out.ok && out.entry.kind).toBe('fact')
  })
})

describe('mergeMemory · 重复保存', () => {
  it('同一件事再存一次只刷新时间，不堆条目', () => {
    const list = [entry({ id: 'e1', text: '我喜欢简洁的回答', updatedAt: '2026-01-01T00:00:00.000Z' })]
    const out = mergeMemory(list, { text: '我喜欢简洁的回答。', kind: 'preference' }, '2026-06-01T00:00:00.000Z')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.replaced).toBe(true)
    expect(out.list).toHaveLength(1)
    expect(out.list[0].id).toBe('e1')
    expect(out.list[0].updatedAt).toBe('2026-06-01T00:00:00.000Z')
    // createdAt 是"第一次记下"的时间，不该被刷新
    expect(out.list[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('mergeMemory · 上限', () => {
  it('超过上限时丢弃最久没被确认的那条', () => {
    const list: MemoryEntry[] = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, i) =>
      entry({
        id: `m${i}`,
        text: `第 ${i} 条`,
        createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        // 越靠前越新
        updatedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + (MEMORY_MAX_ENTRIES - i) * 1000).toISOString()
      })
    )
    const out = mergeMemory(list, { text: '最新的一条' }, '2026-12-31T00:00:00.000Z')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.list).toHaveLength(MEMORY_MAX_ENTRIES)
    expect(out.list.some((item) => item.text === '最新的一条')).toBe(true)
    // 最旧的那条（updatedAt 最小）应该被挤掉
    const oldest = [...list].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0]
    expect(out.list.some((item) => item.id === oldest.id)).toBe(false)
  })
})

describe('removeMemory', () => {
  const list = [entry({ id: 'a', text: '第一条' }), entry({ id: 'b', text: '第二条' })]

  it('按 id 删除', () => {
    const out = removeMemory(list, 'a')
    expect(out.removed?.id).toBe('a')
    expect(out.list.map((m) => m.id)).toEqual(['b'])
  })

  it('按原文删除（用户说"忘掉那条"时不必知道 id）', () => {
    const out = removeMemory(list, '第二条。')
    expect(out.removed?.id).toBe('b')
  })

  it('找不到时原样返回，不误删', () => {
    const out = removeMemory(list, '不存在的')
    expect(out.removed).toBeNull()
    expect(out.list).toHaveLength(2)
  })

  it('空参数不删任何东西', () => {
    expect(removeMemory(list, '   ').removed).toBeNull()
  })
})

describe('memoryBlock · 注入提示词', () => {
  it('没有记忆时返回空串（提示词里不留空段落）', () => {
    expect(memoryBlock([])).toBe('')
  })

  it('按最近确认时间排序，最新的在前', () => {
    const block = memoryBlock([
      entry({ id: 'old', text: '旧事', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'new', text: '新事', updatedAt: '2026-06-01T00:00:00.000Z' })
    ])
    expect(block.indexOf('新事')).toBeLessThan(block.indexOf('旧事'))
  })

  it('明确标注"是线索不是证据"，并要求事实类问题现查', () => {
    // 这句是整个设计的支点：没有它，模型会拿三个月前的记忆回答"我现在装了什么"
    const block = memoryBlock([entry({ text: '用户偏好简洁回答' })])
    expect(block).toMatch(/线索，不是证据/)
    expect(block).toMatch(/必须先调工具查/)
  })

  it('带上类型标签', () => {
    const block = memoryBlock([entry({ text: '喜欢简洁', kind: 'preference' })])
    expect(block).toContain('〔偏好〕')
  })

  it('总字数受上限约束，不会把预算吃光', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry({ id: `m${i}`, text: `${i}${'填'.repeat(190)}` }))
    const block = memoryBlock(many)
    expect(block.length).toBeLessThan(MEMORY_INJECT_CHARS + 400)
  })

  it('单条超长也不会让整段爆掉', () => {
    const block = memoryBlock([entry({ text: '啊'.repeat(MEMORY_MAX_TEXT) })])
    expect(block.length).toBeLessThan(MEMORY_INJECT_CHARS + 400)
  })
})
