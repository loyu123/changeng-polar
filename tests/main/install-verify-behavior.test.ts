import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/main/agent/tool-types'

/**
 * install_app 的装后核对。
 *
 * 锁的是这一条：**winget 报成功不等于装上了**。`--silent` 拉起的是厂商安装器，
 * 外壳退出码、UAC 被拒、静默失败都可能让 winget 报成功而机器上什么都没有。
 * 台账上写"已安装"比装不上更糟，所以核对没对上时工具必须报失败。
 */

const hoisted = vi.hoisted(() => ({
  /** checkInstalled 说有没有查到 */
  checkFound: true,
  /** 注册表里的程序清单 */
  apps: [] as Array<Record<string, unknown>>,
  /** 两次启动项扫描之间的名字集合（安装前 / 安装后共用同一个数组，靠 mutate 模拟变化） */
  startupBefore: [] as string[],
  startupAfter: [] as string[]
}))

vi.mock('../../src/main/node/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/node/install')>()
  return {
    ...actual,
    wingetAvailable: async () => true,
    searchWinget: async () => [{ name: '网易云音乐', id: 'NetEase.CloudMusic', version: '2.10.6' }],
    installWinget: async () => ({ ok: true, detail: 'ok', sourceUrl: 'https://example.com/cloudmusic.exe' }),
    checkInstalled: async () =>
      hoisted.checkFound
        ? { found: true, name: '网易云音乐', version: '2.10.6', detail: 'listed' }
        : { found: false, detail: 'winget list 报告没有匹配的已安装程序' }
  }
})

let startupPass = 0
vi.mock('../../src/main/node/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/node/registry')>()
  return {
    ...actual,
    listInstalledApps: async () => ({ apps: hoisted.apps, durationMs: 1 }),
    // 第一次调用是"装之前"的基准扫描，之后都是"装之后"
    listStartupItems: async () => {
      const names = startupPass === 0 ? hoisted.startupBefore : hoisted.startupAfter
      startupPass += 1
      return {
        items: names.map((name) => ({ name, command: `cmd /c ${name}`, source: 'HKCU', kind: 'registry', enabled: true })),
        durationMs: 1
      }
    }
  }
})

const { createTools } = await import('../../src/main/agent/tools')

const ctx: ToolContext = {
  config: {} as never,
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

const tool = createTools().find((t) => t.name === 'install_app')!

/** 走一遍 plan（解析出唯一 Id）。传包 Id 才能精确匹配 —— 中文名匹配不上是既定行为 */
async function planFor(name = 'NetEase.CloudMusic') {
  const planned = await tool.plan!({ name }, ctx)
  if (!planned.ok) throw new Error(`plan 应该成功：${planned.reason}`)
  return planned
}

beforeEach(() => {
  hoisted.checkFound = true
  hoisted.apps = []
  hoisted.startupBefore = []
  hoisted.startupAfter = []
  startupPass = 0
})

describe('install_app 授权卡', () => {
  it('卡上写明静默安装的代价：默认勾选会照原样生效、过程中取消不了', async () => {
    // 用户批准时看不到安装器界面，这句话是他唯一的信息来源。
    // 原来的文案是"不在桌面留安装包"，恰好说反了
    const planned = await planFor()
    expect(planned.target.impact).toContain('静默安装')
    expect(planned.target.impact).toContain('默认勾上')
    expect(planned.target.impact).toContain('取消不了')
  })

  it('卡上交代了装完会核对，并保留来源与不可撤回的口径', async () => {
    const planned = await planFor()
    expect(planned.target.impact).toContain('核对')
    expect(planned.target.target).toContain('NetEase.CloudMusic')
    expect(planned.target.undoHint).toContain('不可撤回')
  })
})

describe('install_app 装后核对', () => {
  it('核对对上了才报成功，并登记程序显示名', async () => {
    hoisted.apps = [
      {
        name: '网易云音乐',
        version: '2.10.6',
        publisher: 'NetEase',
        installLocation: 'C:\\Program Files\\NetEase\\CloudMusic',
        sizeKB: 1024,
        installDate: '20261106',
        systemComponent: 0
      }
    ]
    const planned = await planFor()
    const result = await planned.execute()

    expect(result.ok).toBe(true)
    expect(result.installedName).toBe('网易云音乐')
    expect(result.summary).toContain('C:\\Program Files\\NetEase\\CloudMusic')
    expect(result.summary).toContain('2026-11-06')
  })

  it('winget 说成功但核对自己查不到 → 报失败，不登记"管家装的"', async () => {
    // 这条是重点：宁可让模型说"没核实到装好了"，也不能让它替 winget 宣布成功
    hoisted.checkFound = false
    hoisted.apps = []
    const planned = await planFor()
    const result = await planned.execute()

    expect(result.ok).toBe(false)
    expect(result.installedName).toBeUndefined()
    expect(result.summary).toContain('核对没对上')
  })

  it('checkInstalled 没查到、但注册表有这一行 → 仍算核对通过', async () => {
    // winget list 可能因为源/缓存问题查不到，注册表是更权威的一侧
    hoisted.checkFound = false
    hoisted.apps = [
      {
        name: '网易云音乐',
        version: '2.10.6',
        publisher: 'NetEase',
        installLocation: '',
        sizeKB: 0,
        installDate: '',
        systemComponent: 0
      }
    ]
    const planned = await planFor()
    const result = await planned.execute()
    expect(result.ok).toBe(true)
    expect(result.installedName).toBe('网易云音乐')
  })

  it('装完新增的自启项会报出来（静默安装补回可观测性）', async () => {
    hoisted.startupBefore = ['OneDrive']
    hoisted.startupAfter = ['OneDrive', 'CloudMusic']
    hoisted.apps = [
      {
        name: '网易云音乐',
        version: '2.10.6',
        publisher: 'NetEase',
        installLocation: '',
        sizeKB: 0,
        installDate: '',
        systemComponent: 0
      }
    ]
    const planned = await planFor()
    const result = await planned.execute()
    expect(result.summary).toContain('新增 1 个开机自启项')
    expect(result.summary).toContain('CloudMusic')
  })

  it('自启项没变就直说没变，不含糊过去', async () => {
    hoisted.startupBefore = ['OneDrive']
    hoisted.startupAfter = ['OneDrive']
    hoisted.apps = [
      {
        name: '网易云音乐',
        version: '2.10.6',
        publisher: 'NetEase',
        installLocation: '',
        sizeKB: 0,
        installDate: '',
        systemComponent: 0
      }
    ]
    const planned = await planFor()
    const result = await planned.execute()
    expect(result.summary).toContain('没有变化')
  })

  it('包含匹配有多条命中时不硬挑一个，改报"没核实到"', async () => {
    // 查"网易云音乐"若同时命中"网易云音乐"和"网易云音乐内测版"，
    // 随便挑一个就会把别的程序的安装路径当成它的
    hoisted.checkFound = false
    hoisted.apps = [
      {
        name: '网易云音乐内测版',
        version: '3.0.0',
        publisher: 'NetEase',
        installLocation: 'D:\\beta',
        sizeKB: 0,
        installDate: '',
        systemComponent: 0
      },
      {
        name: '网易云音乐开发版',
        version: '3.1.0',
        publisher: 'NetEase',
        installLocation: 'D:\\dev',
        sizeKB: 0,
        installDate: '',
        systemComponent: 0
      }
    ]
    const planned = await planFor()
    const result = await planned.execute()
    expect(result.ok).toBe(false)
    expect(result.summary).not.toContain('D:\\\\')
  })
})
