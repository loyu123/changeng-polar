import { describe, expect, it } from 'vitest'
import { appIdentity, findOpenWindow, processHintFromAppId, type RunningProcess } from '../../src/main/node/running'

/**
 * 「已经开着就别再开一份」——apps-folder 条目也要认出来。
 *
 * 真机踩到的场景：模型为了"确保记事本开着"反复调 launch_app，
 * 每次都开一个新窗口，把真正输入了内容的那个挤没了。
 * 根因是 apps-folder 条目**整个跳过**了这道检查，因为 AppID
 * （`Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`）没法可靠地换算成进程名。
 *
 * 修法不是"硬猜"，而是：只对确知的那几个包名做映射，没有映射就照常启动——
 * 宁可多开一个窗口，也不要猜错后说"已经开着"而用户看不到任何窗口。
 */

const proc = (name: string, pid: number, handle = 123): RunningProcess => ({
  pid,
  name,
  windowTitle: `${name} 窗口`,
  windowHandle: handle,
  exePath: ''
})

describe('AppID 取进程名', () => {
  it('记事本：从包名映射到 notepad', () => {
    expect(processHintFromAppId('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App')).toEqual(['notepad'])
  })

  it('计算器、终端、画图也能映射', () => {
    expect(processHintFromAppId('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toEqual(['calculatorapp'])
    expect(processHintFromAppId('Microsoft.WindowsTerminal_8wekyb3d8bbwe!App')).toEqual(['windowsterminal'])
    expect(processHintFromAppId('Microsoft.Paint_8wekyb3d8bbwe!App')).toEqual(['mspaint'])
  })

  it('不认识的包名返回空——不猜', () => {
    // 猜错的代价是"用户想开却被告知已经开着"，比多开一个窗口重得多
    expect(processHintFromAppId('SomeVendor.MysteryApp_abc123!App')).toEqual([])
    expect(processHintFromAppId('')).toEqual([])
    expect(processHintFromAppId('!!!')).toEqual([])
  })

  it('不把 PublisherId（下划线后那串哈希）当成包名的一部分', () => {
    // 整串塞进去会得到一个永远匹配不上任何进程的键
    const hints = processHintFromAppId('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App')
    expect(hints.join('')).not.toContain('8wekyb3d8bbwe')
  })

  it('不会退化成 basename（那会得到 "microsoft" 这种能匹配一堆东西的键）', () => {
    const hints = processHintFromAppId('Microsoft.WindowsNotepad_8wekyb3d8bbwe!App')
    expect(hints).not.toContain('microsoft')
  })
})

describe('appIdentity 对 apps-folder 的行为', () => {
  it('现在会把映射出的进程名一起带上', () => {
    const keys = appIdentity(
      { name: '记事本', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', kind: 'apps-folder' },
      ''
    )
    expect(keys).toContain('notepad')
  })

  it('没有映射时只按显示名，不瞎猜', () => {
    const keys = appIdentity({ name: '某个程序', path: 'Vendor.X_app!App', kind: 'apps-folder' }, '')
    expect(keys).toEqual(['某个程序'])
  })

  it('仍然不用 AppID 的路径部分（避免 "microsoft" 这种宽键）', () => {
    const keys = appIdentity(
      { name: '记事本', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', kind: 'apps-folder' },
      ''
    )
    expect(keys).not.toContain('microsoft')
  })
})

describe('已经开着时能被认出来', () => {
  it('记事本开着（有可见窗口）→ 能找到，于是不再启动第二份', () => {
    const keys = appIdentity(
      { name: '记事本', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', kind: 'apps-folder' },
      ''
    )
    const open = findOpenWindow([proc('Notepad', 44216)], keys)
    expect(open?.pid).toBe(44216)
  })

  it('记事本只有后台残留进程（没有可见窗口）→ 不算开着', () => {
    // 这类进程开着并不等于用户"看见了"；把这种情况报成"已经打开"会让用户对着空屏幕找不到
    const keys = appIdentity(
      { name: '记事本', path: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', kind: 'apps-folder' },
      ''
    )
    const open = findOpenWindow([proc('Notepad', 1, 0)], keys)
    expect(open).toBeNull()
  })

  it('没有映射的程序仍认不出（宁可多开一个窗口）', () => {
    const keys = appIdentity({ name: '神秘程序', path: 'Vendor.Mystery_app!App', kind: 'apps-folder' }, '')
    expect(findOpenWindow([proc('Mystery', 99)], keys)).toBeNull()
  })
})
