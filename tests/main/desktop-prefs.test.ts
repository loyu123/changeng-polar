import { describe, expect, it } from 'vitest'
import { DEFAULT_DESKTOP_PREFS, desktopPrefsOf } from '../../src/shared/desktop'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * 桌面常驻偏好。
 *
 * 重点在「旧配置」这一侧：store.getConfig 是浅合并，盘上没有 desktop 这一段时
 * 整个对象都是缺的，不能指望它被补全。归一化要是漏了默认值，用户升级后
 * 会突然发现关窗变成了直接退出。
 */

const base = { baseUrl: '', apiKey: '', model: '', stream: true, temperature: 0, searchProvider: 'none', searchKey: '' } as ButlerConfig

describe('desktopPrefsOf', () => {
  it('配置里没有 desktop 时全部走默认值', () => {
    expect(desktopPrefsOf(base)).toEqual(DEFAULT_DESKTOP_PREFS)
  })

  it('配置整体缺失也按默认值，不抛错', () => {
    expect(desktopPrefsOf(null)).toEqual(DEFAULT_DESKTOP_PREFS)
    expect(desktopPrefsOf(undefined)).toEqual(DEFAULT_DESKTOP_PREFS)
  })

  it('默认是「关窗收进托盘」与「任务完成通知」都开、开机自启关', () => {
    expect(DEFAULT_DESKTOP_PREFS).toEqual({
      closeToTray: true,
      launchAtLogin: false,
      notifyOnTask: true
    })
  })

  it('只写了一部分字段时，缺的字段各自补默认值', () => {
    const config = { ...base, desktop: { closeToTray: false } } as ButlerConfig
    expect(desktopPrefsOf(config)).toEqual({
      closeToTray: false,
      launchAtLogin: false,
      notifyOnTask: true
    })
  })

  it('显式关掉的两项不会被默认值盖回来', () => {
    const config = { ...base, desktop: { closeToTray: false, launchAtLogin: true, notifyOnTask: false } } as ButlerConfig
    expect(desktopPrefsOf(config)).toEqual({
      closeToTray: false,
      launchAtLogin: true,
      notifyOnTask: false
    })
  })

  it('非布尔值按默认值处理，不被当成真', () => {
    const config = { ...base, desktop: { closeToTray: 'no', launchAtLogin: 1, notifyOnTask: null } } as unknown as ButlerConfig
    expect(desktopPrefsOf(config)).toEqual(DEFAULT_DESKTOP_PREFS)
  })
})
