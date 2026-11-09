import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isLaunchableShortcut,
  listShortcuts,
  normalizeLaunchName,
  planLaunch,
  resetShortcutCache,
  type Shortcut
} from '../../src/main/node/launch'

/**
 * 打开程序的解析。
 *
 * 这里喂的是合成的快捷方式清单，不碰真机开始菜单/桌面：要锁的不是"能不能读到文件"，
 * 而是"选中的是不是用户说的那一个"。真机上最容易出事的几个样本都放进来了
 * （哔哩哔哩 / 卸载哔哩哔哩 并排放在同一个程序组里；只在桌面上有图标的程序）。
 */

const sm = (name: string, path = `C:\\ProgramData\\…\\${name}.lnk`): Shortcut => ({
  name,
  path,
  source: 'start-menu'
})
const desk = (name: string, path = `C:\\Users\\me\\Desktop\\${name}.lnk`): Shortcut => ({
  name,
  path,
  source: 'desktop'
})

const REAL_MACHINE: Shortcut[] = [sm('哔哩哔哩'), sm('Kimi'), sm('Kimi Code'), desk('Obsidian')]

describe('打开程序 · 快捷方式黑名单', () => {
  /**
   * 真机上 `哔哩哔哩.lnk` 和 `卸载哔哩哔哩.lnk` 就在同一个程序组里。
   * 如果只做名字包含匹配，用户说「打开哔哩哔哩」会弹出卸载确认框——
   * 这是把"打开"和"毁掉"混成一步，必须在这里钉死。
   */
  it('卸载 / 修复 / 更新 / 帮助这类快捷方式不算"打开程序"', () => {
    for (const name of ['卸载哔哩哔哩', '卸载 米哈游启动器', 'Uninstall Kimi', '修复 Obsidian', '检查更新', '帮助文档', 'ReadMe']) {
      expect(isLaunchableShortcut(name), name).toBe(false)
    }
  })

  it('不给模型留一条"打开命令行"的后门', () => {
    for (const name of ['命令提示符', 'Command Prompt', 'Windows PowerShell']) {
      expect(isLaunchableShortcut(name), name).toBe(false)
    }
  })

  it('正常程序名照常通过', () => {
    for (const name of ['哔哩哔哩', 'Kimi', 'Obsidian', '网易云音乐']) {
      expect(isLaunchableShortcut(name), name).toBe(true)
    }
  })
})

describe('打开程序 · 解析唯一目标', () => {
  it('名字完全相同就打它，哪怕还有以它开头的别的程序', () => {
    const planned = planLaunch('Kimi', REAL_MACHINE)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.shortcut.name).toBe('Kimi')
  })

  it('只给前缀、且只命中一个时也认（"哔哩哔哩"就是它）', () => {
    const planned = planLaunch('哔哩哔哩', REAL_MACHINE)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.shortcut.name).toBe('哔哩哔哩')
  })

  it('前缀命中多个 → 不猜，把候选念给用户', () => {
    const planned = planLaunch('Kimi Code C', [...REAL_MACHINE, sm('Kimi Code CLI')])
    expect(planned.ok).toBe(true) // 只有 Kimi Code CLI 以它开头
    const ambiguous = planLaunch('Kimi Co', [sm('Kimi Code', 'a'), sm('Kimi Code CLI', 'b')])
    expect(ambiguous.ok).toBe(false)
    if (ambiguous.ok) return
    expect(ambiguous.reason).toContain('Kimi Code')
    expect(ambiguous.reason).toContain('Kimi Code CLI')
  })

  it('完全找不到 → 说清可能是没装、也可能是 Store 应用，并给出核对办法', () => {
    const planned = planLaunch('绝对不存在的程序 Xyz', REAL_MACHINE)
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toContain('开始菜单和桌面上都没有')
    expect(planned.reason).toContain('list_installed_apps')
  })

  it('空名字不解析', () => {
    expect(planLaunch('   ', REAL_MACHINE).ok).toBe(false)
  })

  it('大小写和空格不影响匹配（用户不会照着快捷方式打字）', () => {
    for (const query of ['obsidian', 'OBSIDIAN', ' obsidian ', 'Obsidian.']) {
      const planned = planLaunch(query, REAL_MACHINE)
      expect(planned.ok, query).toBe(true)
      if (planned.ok) expect(planned.shortcut.name).toBe('Obsidian')
    }
  })
})

/**
 * 桌面为什么要一起扫：真机上「办公桌面助手」装完只在桌面留了快捷方式，
 * 开始菜单里一个入口都没有。只扫开始菜单的话，用户说"打开办公桌面助手"，
 * 管家明明看得见桌面那个图标却说没有。
 */
describe('打开程序 · 桌面上的程序也能开', () => {
  it('只在桌面有快捷方式的程序，照样解析得出来', () => {
    const planned = planLaunch('办公桌面助手', [sm('哔哩哔哩'), desk('办公桌面助手', 'C:\\Users\\me\\Desktop\\办公桌面助手.lnk')])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.shortcut.name).toBe('办公桌面助手')
    // 来源要标出来：审计里能回答"打开的是哪一份"
    expect(planned.shortcut.source).toBe('desktop')
  })

  it('开始菜单和桌面同一个程序时，用开始菜单那份', () => {
    // 开始菜单那份跟着程序一起更新；桌面那份常是用户拖出来的旧副本。
    // 这条由 listShortcuts 的去重顺序保证，这里直接验口径（顺序在前者胜出）
    const ordered = [sm('微信', 'C:\\ProgramData\\…\\微信.lnk'), desk('微信', 'C:\\Users\\me\\Desktop\\微信.lnk')]
    const seen = new Set<string>()
    const deduped = ordered.filter((s) => {
      const k = s.name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    expect(deduped).toHaveLength(1)
    expect(deduped[0].source).toBe('start-menu')
    const planned = planLaunch('微信', deduped)
    expect(planned.ok && planned.shortcut.source).toBe('start-menu')
  })
})

/**
 * 真实桌面上的文件夹是用户的资料，不是程序组。
 *
 * 用临时目录冒充 `%PUBLIC%\Desktop` 来验：顶层那份要找到，埋进子文件夹（尤其是
 * node_modules 那种深井）的那份找不到。这不是洁癖——扫描额度是开始菜单和桌面共享的，
 * 一旦被某个大文件夹吃光，后面的快捷方式会被静默跳过，表现成"装着却打不开"。
 */
describe('打开程序 · 不钻进桌面上的文件夹', () => {
  const roots: string[] = []
  const before = process.env.PUBLIC

  afterEach(() => {
    if (before === undefined) delete process.env.PUBLIC
    else process.env.PUBLIC = before
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
    resetShortcutCache()
  })

  it('桌面顶层的快捷方式找得到，子文件夹里那份不认', () => {
    const fakePublic = mkdtempSync(path.join(os.tmpdir(), 'butler-desk-'))
    roots.push(fakePublic)
    const desk = path.join(fakePublic, 'Desktop')
    const deep = path.join(desk, '某个项目', 'node_modules', '某个包')
    mkdirSync(deep, { recursive: true })
    writeFileSync(path.join(desk, '顶层程序.lnk'), '')
    writeFileSync(path.join(deep, '藏起来的.lnk'), '')

    process.env.PUBLIC = fakePublic
    resetShortcutCache()
    const names = listShortcuts(true).map((s) => normalizeLaunchName(s.name))

    expect(names).toContain(normalizeLaunchName('顶层程序'))
    expect(names).not.toContain(normalizeLaunchName('藏起来的'))
  })

  /**
   * 扫到不等于还在。
   *
   * MSIX（Store 应用）的快捷方式由外壳按需生成和回收，目录里留着条目、文件却已经没了
   * 是常态。真机上「Claude」就这么翻过车：开始菜单那一份被解析出来，点下去
   * `shell.openPath` 只会回一句 "Failed to open path"。
   */
  it('已经消失的快捷方式不会留在清单里', () => {
    const fakePublic = mkdtempSync(path.join(os.tmpdir(), 'butler-desk-'))
    roots.push(fakePublic)
    const desk = path.join(fakePublic, 'Desktop')
    mkdirSync(desk, { recursive: true })
    const lnk = path.join(desk, '会被删掉.lnk')
    writeFileSync(lnk, '')

    process.env.PUBLIC = fakePublic
    resetShortcutCache()
    expect(listShortcuts(true).map((s) => s.name)).toContain('会被删掉')
    expect(planLaunch('会被删掉', listShortcuts(true)).ok).toBe(true)

    rmSync(lnk)
    resetShortcutCache()
    expect(listShortcuts(true).map((s) => s.name)).not.toContain('会被删掉')
    expect(planLaunch('会被删掉', listShortcuts(true)).ok).toBe(false)
  })
})
