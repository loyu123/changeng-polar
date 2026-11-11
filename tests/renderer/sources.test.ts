import { describe, expect, it } from 'vitest'
import { SOURCE_PREVIEW, visibleSources } from '../../src/renderer/src/utils/sources'
import type { Evidence } from '../../src/shared/types'

/**
 * 来源列表的截断。
 *
 * 这条是从真实体感来的：一条检索型回答带十几条出处，全展开会把结论挤出屏幕。
 * 但"截掉"很容易截出问题——把本机证据截掉、或者悄悄少显示几条不告诉用户。
 */

const web = (i: number): Evidence => ({
  id: `w${i}`,
  at: '2026-11-11T00:00:00.000Z',
  type: 'web',
  title: `网页 ${i}`,
  url: `https://example.com/${i}`
})
const local = (i: number): Evidence => ({
  id: `l${i}`,
  at: '2026-11-11T00:00:00.000Z',
  type: 'local',
  title: `本机 ${i}`,
  detail: '读自注册表'
})

describe('visibleSources', () => {
  it('条数不多就全给，不折', () => {
    const list = [web(1), web(2), web(3)]
    const { shown, hidden } = visibleSources(list, false)
    expect(shown).toHaveLength(3)
    expect(hidden).toBe(0)
  })

  it('刚好等于上限也不折（多出按钮反而占地方）', () => {
    const list = Array.from({ length: SOURCE_PREVIEW }, (_, i) => web(i))
    const { shown, hidden } = visibleSources(list, false)
    expect(shown).toHaveLength(SOURCE_PREVIEW)
    expect(hidden).toBe(0)
  })

  it('超了就先给前几条，并说清折了几条', () => {
    const list = Array.from({ length: 15 }, (_, i) => web(i))
    const { shown, hidden } = visibleSources(list, false)
    expect(shown).toHaveLength(SOURCE_PREVIEW)
    expect(hidden).toBe(15 - SOURCE_PREVIEW)
    // 少了几条必须能算出来：按钮上的数字就是它
    expect(shown.length + hidden).toBe(list.length)
  })

  it('点开之后全都给', () => {
    const list = Array.from({ length: 15 }, (_, i) => web(i))
    const { shown, hidden } = visibleSources(list, true)
    expect(shown).toHaveLength(15)
    expect(hidden).toBe(0)
  })

  it('本机证据再靠后也一定保住：它是唯一"不是网上说的"那部分', () => {
    // 检索结果一口气十几条时，本机实测那两条排在最末——按纯顺序截断就会把它们丢掉
    const list = [...Array.from({ length: 12 }, (_, i) => web(i)), local(1), local(2)]
    const { shown, hidden } = visibleSources(list, false)
    expect(shown).toHaveLength(SOURCE_PREVIEW)
    expect(shown.filter((e) => e.type === 'local')).toHaveLength(2)
    expect(hidden).toBe(list.length - SOURCE_PREVIEW)
  })

  it('保住归保住，显示顺序还按原来的来（出处顺序是模型引用的顺序）', () => {
    const list = [local(1), web(1), local(2), web(2), web(3), web(4), web(5), web(6), web(7)]
    const { shown } = visibleSources(list, false)
    expect(shown.map((e) => e.id)).toEqual(['l1', 'w1', 'l2', 'w2', 'w3', 'w4'])
  })

  it('本机证据本身超过上限：不硬塞，截断规则照旧', () => {
    const list = Array.from({ length: 9 }, (_, i) => local(i))
    const { shown, hidden } = visibleSources(list, false)
    expect(shown).toHaveLength(SOURCE_PREVIEW)
    expect(hidden).toBe(9 - SOURCE_PREVIEW)
  })

  it('空列表不炸', () => {
    expect(visibleSources([], false)).toEqual({ shown: [], hidden: 0 })
  })
})
