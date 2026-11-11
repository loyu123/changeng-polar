import { describe, expect, it } from 'vitest'
import { pickSnapshot } from '../../src/main/node/snapshot'
import { createTools } from '../../src/main/agent/tools'
import type { ToolContext } from '../../src/main/agent/tool-types'
import type { AppSnapshot } from '../../src/shared/types'

/**
 * 「卸干净了没」这条线：卸载当场核对不了（要等用户点完程序自己的卸载窗口），
 * 所以 `uninstall_app` 标的是 unavailable，并承诺"点完再问我"。
 * 这个承诺要能被兑现，靠的就是下面这两件东西：
 *   1. 之后能找到那份快照（pickSnapshot：先同名、再唯一包含，多条就不挑）
 *   2. 有个只读工具替模型去比（check_uninstall_state）
 */

function snap(over: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    id: 's1',
    appName: '网易云音乐',
    takenAt: '2026-11-10T10:00:00.000Z',
    startup: [],
    ...over
  } as AppSnapshot
}

describe('pickSnapshot · 挑哪一份', () => {
  it('不指定名字 → 最近一次卸载', () => {
    const list = [
      snap({ id: 'old', appName: '旧软件', takenAt: '2026-10-01T00:00:00.000Z' }),
      snap({ id: 'new', appName: '新软件', takenAt: '2026-11-10T00:00:00.000Z' })
    ]
    expect(pickSnapshot(list)?.id).toBe('new')
  })

  it('完全同名优先于包含匹配', () => {
    const list = [
      snap({ id: 'a', appName: 'Kimi CLI', takenAt: '2026-11-10T00:00:00.000Z' }),
      snap({ id: 'b', appName: 'Kimi', takenAt: '2026-11-01T00:00:00.000Z' })
    ]
    expect(pickSnapshot(list, 'kimi')?.id).toBe('b')
  })

  it('包含匹配只命中一条时就用它（用户不会把显示名打全）', () => {
    const list = [snap({ id: 'a', appName: '哔哩哔哩' }), snap({ id: 'b', appName: '网易云音乐' })]
    expect(pickSnapshot(list, '哔哩')?.id).toBe('a')
  })

  it('包含匹配命中多条 → 不挑（拿 A 的快照去核对 B，报出来的是别人的结论）', () => {
    const list = [
      snap({ id: 'a', appName: 'Kimi CLI 1.0' }),
      snap({ id: 'b', appName: 'Kimi Code CLI 2.0' })
    ]
    expect(pickSnapshot(list, 'Kimi')).toBeNull()
  })

  it('空列表 → null（不是抛错）', () => {
    expect(pickSnapshot([], '随便')).toBeNull()
  })
})

describe('check_uninstall_state · 查不到时说清是哪种查不到', () => {
  const ctx: ToolContext = {
    config: {} as ToolContext['config'],
    record: (entry) => ({ ...entry, id: '', ts: '' })
  }
  const find = (snapshots: AppSnapshot[]) =>
    createTools({ listSnapshots: async () => snapshots }).find((t) => t.name === 'check_uninstall_state')!

  it('从来没卸过 → 说没有快照，而不是说"已卸干净"', async () => {
    const result = await find([]).run({}, ctx)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('卸载程序')
    expect(result.summary).not.toContain('干净')
  })

  it('名字对不上唯一一份 → 把手上有哪些快照念出来，让人选', async () => {
    const list = [
      snap({ id: 'a', appName: 'Kimi CLI 1.0' }),
      snap({ id: 'b', appName: 'Kimi Code CLI 2.0' })
    ]
    const result = await find(list).run({ appName: 'Kimi' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('Kimi CLI 1.0')
    expect(result.summary).toContain('按名字告诉我')
  })

  it('指定的 id 不存在 → 如实说，不退回"最近一次"', async () => {
    const list = [snap({ id: 'a', appName: '网易云音乐' })]
    const result = await find(list).run({ snapshotId: 'no-such-id' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('没有 id 为 no-such-id 的快照')
  })

  it('没有注入快照来源 → 如实说读不到（不假装不知道就是"没有问题"）', async () => {
    const tool = createTools().find((t) => t.name === 'check_uninstall_state')!
    const result = await tool.run({}, ctx)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('读不到卸载快照')
  })

  it('是只读工具：不会因为它而弹授权卡', () => {
    const tool = createTools().find((t) => t.name === 'check_uninstall_state')!
    expect(tool.effect).toBe('read')
  })
})
