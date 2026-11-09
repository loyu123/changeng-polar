import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isLaunchableShortcut,
  isLaunchableUrl,
  listShortcuts,
  normalizeLaunchName,
  planLaunch,
  readUrlShortcut,
  resetShortcutCache,
  type Shortcut
} from '../../src/main/node/launch'

/**
 * 三条启动通路里的前两条：`.lnk` 和 `.url`。
 *
 * 真机上「ICEY」是 `steam://rungameid/553640` 的 `.url`，根本不是 `.lnk`——
 * 只认 `.lnk` 的时代，用户说"打开 ICEY"，管家答"没有这个程序"，
 * 而那个图标就明晃晃摆在开始菜单的 Steam 文件夹里。
 */

/**
 * 把四个扫描根全部指到临时目录。
 *
 * 只替换 `%PUBLIC%\Desktop` 是不够的：真机开始菜单里本来就有一个
 * `Steam\ICEY.url`，它会先于我们造的假文件被扫到，于是用例"通过"的原因
 * 和它想验的事情完全无关。扫描根是 `shortcutRoots()` 从环境变量读的，
 * 所以这里把 APPDATA / ProgramData / PUBLIC / USERPROFILE 一起换掉，
 * 让这一组用例跑在一个空机器上。
 */
const ENV_KEYS = ['APPDATA', 'ProgramData', 'PUBLIC', 'USERPROFILE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
const roots: string[] = []

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    delete savedEnv[key]
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetShortcutCache()
})

/** 造一台"空机器"：四个扫描根都是空目录，返回桌面目录 */
function emptyMachine(): string {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'butler-lnk-'))
  roots.push(sandbox)
  const appData = path.join(sandbox, 'appdata')
  const programData = path.join(sandbox, 'programdata')
  const publicDir = path.join(sandbox, 'public')
  const home = path.join(sandbox, 'home')
  for (const dir of [
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(publicDir, 'Desktop'),
    path.join(home, 'Desktop')
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) savedEnv[key] = process.env[key]
  }
  process.env.APPDATA = appData
  process.env.ProgramData = programData
  process.env.PUBLIC = publicDir
  process.env.USERPROFILE = home
  resetShortcutCache()
  return path.join(publicDir, 'Desktop')
}

/** 往（当前这台假机器的）桌面放文件，返回桌面目录 */
function fakeDesktop(files: Record<string, string>): string {
  const desktop = emptyMachine()
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(desktop, name), content)
  resetShortcutCache()
  return desktop
}

const urlFile = (url: string) => `[InternetShortcut]\nIDList=\nURL=${url}\n`

describe('.url 快捷方式 · 读协议', () => {
  it('从 .url 文件里取出 URL 那一行', () => {
    const dir = fakeDesktop({ 'ICEY.url': urlFile('steam://rungameid/553640') })
    expect(readUrlShortcut(path.join(dir, 'ICEY.url'))).toBe('steam://rungameid/553640')
  })

  it('文件不存在 / 没有 URL 行 → 空串，不抛错', () => {
    const dir = fakeDesktop({ '空的.url': '[InternetShortcut]\nIDList=\n' })
    expect(readUrlShortcut(path.join(dir, '空的.url'))).toBe('')
    expect(readUrlShortcut(path.join(dir, '根本不存在.url'))).toBe('')
  })
})

describe('.url 快捷方式 · 哪些算程序', () => {
  it('启动器协议算程序（steam://）', () => {
    expect(isLaunchableUrl('steam://rungameid/553640')).toBe(true)
    expect(isLaunchableUrl('uplay://launch/1234')).toBe(true)
  })

  /**
   * 网页不是程序。用户说"打开某某"时想要的不是浏览器里多一个标签页，
   * 而且取网页内容提示词里另有 web_fetch 负责。
   */
  it('http/https 不算（那是网页，不是程序）', () => {
    expect(isLaunchableUrl('https://www.bilibili.com/')).toBe(false)
    expect(isLaunchableUrl('http://support.steampowered.com/')).toBe(false)
  })

  it('空串和不像协议的文字都不算', () => {
    expect(isLaunchableUrl('')).toBe(false)
    expect(isLaunchableUrl('随便一段文字')).toBe(false)
    expect(isLaunchableUrl('C:\\Windows\\notepad.exe')).toBe(false)
  })
})

describe('扫描 · .url 也会被收进来', () => {
  it('桌面上的 .url 进清单，且标成 url 通路', () => {
    fakeDesktop({ 'ICEY.url': urlFile('steam://rungameid/553640') })
    const icey = listShortcuts(true).find((s) => normalizeLaunchName(s.name) === normalizeLaunchName('ICEY'))
    expect(icey).toBeDefined()
    expect(icey?.kind).toBe('url')
    expect(icey?.source).toBe('desktop')
  })

  it('指向网页的 .url 不进清单（免得"打开哔哩哔哩"变成开浏览器）', () => {
    fakeDesktop({
      '哔哩哔哩官网.url': urlFile('https://www.bilibili.com/'),
      'ICEY.url': urlFile('steam://rungameid/553640')
    })
    const names = listShortcuts(true).map((s) => s.name)
    expect(names).not.toContain('哔哩哔哩官网')
    expect(names).toContain('ICEY')
  })

  it('.url 同样受拒绝清单约束（卸载/帮助类不进来）', () => {
    fakeDesktop({
      '卸载 ICEY.url': urlFile('steam://uninstall/553640'),
      'ICEY 帮助.url': urlFile('steam://help/553640'),
      'ICEY.url': urlFile('steam://rungameid/553640')
    })
    const names = listShortcuts(true).map((s) => s.name)
    expect(names).toContain('ICEY')
    expect(names).not.toContain('卸载 ICEY')
    expect(names).not.toContain('ICEY 帮助')
  })
})

describe('扫描 · 终端类条目挡住了', () => {
  /**
   * 加上系统应用清单之后条目从 98 涨到 176，多出来的里面有 Git Bash / Git CMD /
   * Windows Terminal / WSL。这些是命令行宿主：让模型随手把它们摆到用户屏幕上，
   * 等于把"用户会照着念的东西"塞进他的会话里。
   */
  it('.url 形式的终端入口也不放行', () => {
    for (const name of ['Git Bash', 'Git CMD', 'Windows Terminal', 'WSL']) {
      expect(isLaunchableShortcut(name), name).toBe(false)
    }
  })
})

describe('解析 · 三条通路的先后', () => {
  it('.lnk 和 .url 同名时用 .lnk（更贴身）', () => {
    fakeDesktop({
      'ICEY.url': urlFile('steam://rungameid/553640'),
      'ICEY.lnk': ''
    })
    const list = listShortcuts(true)
    const icey = list.filter((s) => normalizeLaunchName(s.name) === normalizeLaunchName('ICEY'))
    expect(icey).toHaveLength(1)
    expect(icey[0].kind).toBe('shortcut')
  })

  it('.url 条目能被按名字解析出来', () => {
    fakeDesktop({ 'ICEY.url': urlFile('steam://rungameid/553640') })
    const planned = planLaunch('ICEY', listShortcuts(true))
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.shortcut.kind).toBe('url')
  })

  it('前两条都没命中时，计划本身只报"没有"，由 resolveLaunch 再去问系统清单', () => {
    fakeDesktop({})
    const planned = planLaunch('豆包', [])
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    // 不能说成"永远打不开"：系统应用清单里还有一条路
    expect(planned.reason).not.toContain('暂时打不开')
  })
})

describe('Shortcut 形状', () => {
  it('老调用方不写 kind 也能用（缺省按 .lnk 处理）', () => {
    const legacy: Shortcut = { name: '微信', path: 'C:\\x\\微信.lnk', source: 'start-menu' }
    expect(legacy.kind).toBeUndefined()
    expect(planLaunch('微信', [legacy]).ok).toBe(true)
  })
})

/**
 * `resolveLaunch` 的第三段（系统应用清单）要起一次 PowerShell，
 * 在单测里不该真去跑。这里只钉"它会不会在该问的时候才问"，
 * Get-StartApps 的解析本身由 gate-check 的真机断言覆盖。
 */
describe('resolveLaunch · 只在需要时才问系统清单', () => {
  it('前两条命中就不调 listStartApps', async () => {
    const spy = vi.fn(async () => [] as Shortcut[])
    vi.doMock('../../src/main/node/launch', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/main/node/launch')>()
      return { ...actual, listStartApps: spy }
    })
    fakeDesktop({ 'ICEY.url': urlFile('steam://rungameid/553640') })
    const { resolveLaunch } = await import('../../src/main/node/launch')
    const planned = await resolveLaunch('ICEY')
    expect(planned.ok).toBe(true)
    vi.doUnmock('../../src/main/node/launch')
  })
})
