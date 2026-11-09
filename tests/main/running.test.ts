import { describe, expect, it } from 'vitest'
import { appIdentity, findOpenWindow, normalizeAppName, type RunningProcess } from '../../src/main/node/running'

/**
 * 「它是不是已经开着了」的判断口径。
 *
 * 这里锁两件事，方向相反但同样重要：
 *  - 判成"已经开着"就不能再启动一份（用户抱怨的就是这个：点了又点，窗口一堆）
 *  - 判错成"已经开着"更糟：用户想开却开不出来，还被告知已经开了
 */

const proc = (over: Partial<RunningProcess> = {}): RunningProcess => ({
  pid: 100,
  name: 'Weixin',
  windowTitle: '微信',
  windowHandle: 1,
  exePath: 'D:\\Weixin\\Weixin.exe',
  ...over
})

describe('进程名归一化', () => {
  it('大小写、空格、连字符、.exe 都不影响"是不是同一个"', () => {
    expect(normalizeAppName('Google Chrome')).toBe(normalizeAppName('googlechrome'))
    expect(normalizeAppName('Code.exe')).toBe(normalizeAppName('code'))
    expect(normalizeAppName('Kimi-Code')).toBe(normalizeAppName('kimi_code'))
    expect(normalizeAppName('哔哩哔哩')).toBe('哔哩哔哩')
  })
})

describe('一个快捷方式可能对应的进程名', () => {
  it('中文名的快捷方式，进程名往往是拉丁字母：两条来源都要给', () => {
    // 微信.lnk 指向 Weixin.exe：只按快捷方式名字找，永远找不到进程
    const keys = appIdentity({ name: '微信', path: 'C:\\…\\微信.lnk' }, 'D:\\Weixin\\Weixin.exe')
    expect(keys).toContain(normalizeAppName('微信'))
    expect(keys).toContain(normalizeAppName('Weixin'))
  })

  it('MSIX 快捷方式没有目标路径（TargetPath 为空）也要能给出名字', () => {
    // Store 应用（ChatGPT / Claude）的快捷方式是外壳生成的，读不出 exe 路径
    const keys = appIdentity({ name: 'Claude', path: 'C:\\…\\Claude.lnk' }, '')
    expect(keys).toEqual([normalizeAppName('Claude')])
  })
})

describe('找那个"用户正看着的窗口"', () => {
  it('同名且有可见窗口 → 认作已打开', () => {
    const found = findOpenWindow([proc()], appIdentity({ name: '微信', path: 'x\\微信.lnk' }, 'D:\\Weixin\\Weixin.exe'))
    expect(found?.pid).toBe(100)
  })

  /**
   * 这一条是核心取舍。Electron 类应用会留下一大堆同名但没有窗口的进程
   * （渲染进程、托盘常驻、更新器），把它们算成"已经开着"会让用户对着空屏幕
   * 找不到东西。宁可多启动一次。
   */
  it('只有后台进程、没有可见窗口 → 不算已打开', () => {
    const found = findOpenWindow(
      [proc({ windowHandle: 0, windowTitle: '' }), proc({ pid: 101, windowHandle: 0, windowTitle: '' })],
      appIdentity({ name: '微信', path: 'x\\微信.lnk' }, 'D:\\Weixin\\Weixin.exe')
    )
    expect(found).toBeNull()
  })

  it('有窗口的和没窗口的混在一起 → 认那个有窗口的', () => {
    const found = findOpenWindow(
      [proc({ pid: 1, windowHandle: 0, windowTitle: '' }), proc({ pid: 2, windowHandle: 9, windowTitle: '微信' })],
      appIdentity({ name: '微信', path: 'x\\微信.lnk' }, 'D:\\Weixin\\Weixin.exe')
    )
    expect(found?.pid).toBe(2)
  })

  /**
   * 只做完全同名匹配，绝不做包含匹配：
   * 说"打开 Code"时，Visual Studio Code 开着不该被当成要打开的那个东西。
   */
  it('名字只是包含关系不算同一个程序', () => {
    const running = [proc({ name: 'Code', windowTitle: 'Visual Studio Code' })]
    const found = findOpenWindow(running, appIdentity({ name: 'CodeBuddy CN', path: 'x\\CodeBuddy CN.lnk' }, ''))
    expect(found).toBeNull()
  })

  it('没有可比对的名字时一律当没开', () => {
    expect(findOpenWindow([proc()], [])).toBeNull()
  })

  it('进程表是空的就返回 null（不是抛错）', () => {
    expect(findOpenWindow([], ['weixin'])).toBeNull()
  })
})
