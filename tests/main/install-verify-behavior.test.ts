import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/main/agent/tool-types'

/**
 * install_app 的装后核对。
 *
 * 锁的是这一条：**winget 报成功不等于装上了**。`--interactive` 拉起的是厂商安装器，
 * 外壳退出码、UAC 被拒、静默失败都可能让 winget 报成功而机器上什么都没有。
 * 台账上写"已安装"比装不上更糟，所以核对没对上时工具必须报失败。
 */

const hoisted = vi.hoisted(() => ({
  /** checkInstalled 说有没有查到（装完之后那次） */
  checkFound: true,
  /** 装前查重那一次：机器上本来就有 → plan 直接拒绝，根本走不到安装 */
  preInstalled: false,
  /** 装前查重直接抛错（winget 卡住 / 环境异常） */
  checkThrows: false,
  /** 装前查重漏了、winget 自己发现已装（清单缓存、用户刚装过） */
  wingetAlreadyInstalled: false,
  /** 注册表里的程序清单 */
  apps: [] as Array<Record<string, unknown>>,
  /** 两次启动项扫描之间的名字集合（安装前 / 安装后共用同一个数组，靠 mutate 模拟变化） */
  startupBefore: [] as string[],
  startupAfter: [] as string[]
}))

let checkCalls = 0

vi.mock('../../src/main/node/install', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/node/install')>()
  return {
    ...actual,
    wingetAvailable: async () => true,
    searchWinget: async () => [{ name: '网易云音乐', id: 'NetEase.CloudMusic', version: '2.10.6' }],
    installWinget: async () =>
      hoisted.wingetAlreadyInstalled
        ? { ok: false, alreadyInstalled: true, detail: '这台机器上本来就有这个软件，winget 没有执行安装' }
        : { ok: true, detail: 'ok', sourceUrl: 'https://example.com/cloudmusic.exe' },
    checkInstalled: async () => {
      // 第一次是装前查重，之后都是装后核对：两次问的是同一个函数但含义不同，
      // 混在一起会让"装完核对"的用例全被查重挡在 plan 阶段
      const isPreflight = checkCalls++ === 0
      if (isPreflight && hoisted.checkThrows) throw new Error('winget list 超时')
      const found = isPreflight ? hoisted.preInstalled : hoisted.checkFound
      if (!found) return { found: false, detail: 'winget list 报告没有匹配的已安装程序' }
      return { found: true, name: '网易云音乐', version: '2.10.6', detail: 'listed' }
    }
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
  hoisted.preInstalled = false
  hoisted.checkThrows = false
  hoisted.wingetAlreadyInstalled = false
  hoisted.apps = []
  hoisted.startupBefore = []
  hoisted.startupAfter = []
  startupPass = 0
  checkCalls = 0
})

describe('install_app 授权卡', () => {
  /**
   * 卡片「影响」栏是用户批准前唯一的信息来源。
   * 曾经这里写的是"全程没有界面、取消不了"（那时真的走 --silent），
   * 改成一律交互式之后那句话就成了假话——用户会看到安装器，而且能改安装位置。
   */
  it('说明会弹安装界面、位置与勾选由用户定，不再说「取消不了」', async () => {
    const planned = await planFor()
    expect(planned.target.impact).toContain('安装界面')
    expect(planned.target.impact).toContain('安装位置')
    expect(planned.target.impact).toContain('由你决定')
    // 静默模式已删除，这句警告不能再出现
    expect(planned.target.impact).not.toContain('取消不了')
    expect(planned.target.impact).not.toContain('静默')
  })

  it('卡上交代了装完会核对，并保留来源与不可撤回的口径', async () => {
    const planned = await planFor()
    expect(planned.target.impact).toContain('核对')
    expect(planned.target.target).toContain('NetEase.CloudMusic')
    expect(planned.target.undoHint).toContain('不可撤回')
  })
})

describe('install_app 装前查重（已经装过就别再装一遍）', () => {
  /**
   * 用户最容易踩的那一步：忘了自己装过，又说一次"帮我装哔哩哔哩"。
   * 以前这里会照常弹安装卡、拉起安装器，winget 发现没有可升级版本就什么都不做，
   * 我们却顺着"装完了"的流程宣布装好了。现在要在**弹卡之前**就拦住。
   */
  it('已经装着 → plan 直接拒绝，并指向 launch_app', async () => {
    hoisted.preInstalled = true
    const planned = await tool.plan!({ name: 'NetEase.CloudMusic' }, ctx)

    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toContain('已经装在')
    expect(planned.reason).toContain('2.10.6')
    // 拦住之后必须给出下一步：光说"不用装了"用户还是看不到东西
    expect(planned.reason).toContain('launch_app')
    // 不能顺口提"升级"——升级由软件自己提示，我们不掺和
    expect(planned.reason).toContain('不要劝他重装或升级')
  })

  it('被拦住时不弹候选卡也不弹授权卡（没得选、也没什么可批准）', async () => {
    hoisted.preInstalled = true
    const planned = await tool.plan!({ name: 'NetEase.CloudMusic' }, ctx)
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.choice).toBeUndefined()
  })

  it('用户明确说要重装 → force:true 放行（修复安装是正当需求）', async () => {
    hoisted.preInstalled = true
    const planned = await tool.plan!({ name: 'NetEase.CloudMusic', force: true }, ctx)
    expect(planned.ok).toBe(true)
  })

  it('查重没答上来（winget 卡住/报错）不拦：宁可多问一次卡，也别挡住真的要装', async () => {
    // checkInstalled 抛错 → 当作"不确定"，继续走安装
    hoisted.checkThrows = true
    const planned = await tool.plan!({ name: 'NetEase.CloudMusic' }, ctx)
    expect(planned.ok).toBe(true)
  })

  it('查重漏了、winget 自己发现已装 → 报"本来就在"，不能宣布安装成功', async () => {
    hoisted.wingetAlreadyInstalled = true
    const planned = await planFor()
    const result = await planned.execute()

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('本来就在')
    expect(result.summary).not.toContain('已通过 winget 安装')
    // 也不该登记成"管家装的"
    expect(result.installedName).toBeUndefined()
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

  it('装完新增的自启项会报出来（交互式安装没有任何机器可读的回执）', async () => {
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
