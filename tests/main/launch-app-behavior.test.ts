import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/main/agent/tool-types'

/**
 * launch_app 的两条行为，都在没有授权卡的情况下直接作用于桌面：
 *  1. 程序已经开着 → 不再启动一份（用户点两次是因为看不见窗口，不是因为想开两个）
 *  2. 进程表探不到 → 照常启动（宁可多开一个窗口，也不要把没开的程序说成已开）
 *
 * 快捷方式解析被 mock 掉：这段要锁的是"要不要按下去"，不是"能不能扫到快捷方式"。
 */

const hoisted = vi.hoisted(() => ({
  shortcut: { name: '微信', path: 'C:\\fake\\微信.lnk', source: 'start-menu' as const },
  targetPath: 'D:\\Weixin\\Weixin.exe',
  processes: [] as Array<Record<string, unknown>>,
  probeThrows: false,
  launchError: '',
  launchCalls: 0,
  focusCalls: [] as number[],
  focusResult: true
}))

vi.mock('../../src/main/node/launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/node/launch')>()
  return {
    ...actual,
    // 必须 mock resolveLaunch（工具真正调的那个），否则会去扫真机的开始菜单/桌面：
    // 这台机器上确实有微信快捷方式，用例会"碰巧通过"，换台机器就红
    resolveLaunch: () => ({ ok: true, shortcut: hoisted.shortcut })
  }
})

const { createTools } = await import('../../src/main/agent/tools')

const ctx: ToolContext = {
  config: {} as never,
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

function makeTool() {
  return createTools({
    launchShortcut: async () => {
      hoisted.launchCalls += 1
      return hoisted.launchError
    },
    probeLaunch: async () => {
      if (hoisted.probeThrows) throw new Error('PowerShell 超时')
      return { targetPath: hoisted.targetPath, processes: hoisted.processes as never }
    },
    focusApp: async (pid) => {
      hoisted.focusCalls.push(pid)
      return hoisted.focusResult
    }
  }).find((t) => t.name === 'launch_app')!
}

const visibleWindow = (over: Record<string, unknown> = {}) => ({
  pid: 4321,
  name: 'Weixin',
  windowTitle: '微信',
  windowHandle: 66,
  exePath: 'D:\\Weixin\\Weixin.exe',
  ...over
})

async function execute() {
  const tool = makeTool()
  const planned = await tool.plan!({ name: '微信' }, ctx)
  if (!planned.ok) throw new Error(`plan 应该成功：${planned.reason}`)
  return planned.execute()
}

beforeEach(() => {
  hoisted.processes = []
  hoisted.probeThrows = false
  hoisted.launchError = ''
  hoisted.launchCalls = 0
  hoisted.focusCalls = []
  hoisted.focusResult = true
})

describe('launch_app · 已经开着就别再开一份', () => {
  it('已经有窗口 → 不启动，把那个窗口叫到前面，并如实说"本来就开着"', async () => {
    hoisted.processes = [visibleWindow()]
    const result = await execute()

    expect(hoisted.launchCalls).toBe(0)
    expect(hoisted.focusCalls).toEqual([4321])
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('本来就开着')
    expect(result.summary).toContain('前面')
    // 不能说成"已经打开"——那是在替用户宣布一件不是我们做的事
    expect(result.summary).not.toContain('已经打开「微信」')
  })

  it('窗口叫不到前面也不能谎报：说清它开着、但没切过来', async () => {
    hoisted.processes = [visibleWindow()]
    hoisted.focusResult = false
    const result = await execute()

    expect(hoisted.launchCalls).toBe(0)
    expect(result.summary).toContain('本来就开着')
    expect(result.summary).toContain('没有')
    expect(result.ok).toBe(true)
  })

  it('只有后台进程、没有可见窗口 → 照常启动（用户看不见的东西不算开着）', async () => {
    hoisted.processes = [visibleWindow({ pid: 9, windowHandle: 0, windowTitle: '' })]
    await execute()

    expect(hoisted.launchCalls).toBe(1)
    expect(hoisted.focusCalls).toEqual([])
  })

  it('探不到进程表 → 照常启动，不因为侦察失败就不做事', async () => {
    hoisted.probeThrows = true
    await execute()
    expect(hoisted.launchCalls).toBe(1)
  })

  it('没开着 → 正常启动', async () => {
    const result = await execute()
    expect(hoisted.launchCalls).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('已经打开「微信」')
  })

  it('外壳报错 → 如实说没打开，不假装成功', async () => {
    hoisted.launchError = 'Failed to open path'
    const result = await execute()
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('没能打开')
  })
})
