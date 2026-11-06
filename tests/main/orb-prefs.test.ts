import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORB_PREFS,
  ORB_SIZE,
  clampToDisplay,
  defaultOrbPosition,
  orbPrefsOf
} from '../../src/shared/orb'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * 悬浮助手的偏好与落点。
 *
 * 落点这一块必须测：拔掉外接显示器之后，存在副屏上的坐标会落到不存在的区域里，
 * 窗口照建但谁也看不见——用户只能去设置里归位，或者干脆以为程序没起来。
 */

const base = {
  baseUrl: '',
  apiKey: '',
  model: '',
  stream: true,
  temperature: 0,
  searchProvider: 'none',
  searchKey: ''
} as ButlerConfig

describe('orbPrefsOf', () => {
  it('配置里没有 orb 时全部走默认值', () => {
    expect(orbPrefsOf(base)).toEqual(DEFAULT_ORB_PREFS)
  })

  it('配置整体缺失也按默认值，不抛错', () => {
    expect(orbPrefsOf(null)).toEqual(DEFAULT_ORB_PREFS)
    expect(orbPrefsOf(undefined)).toEqual(DEFAULT_ORB_PREFS)
  })

  it('默认显示、有动效、带快捷键', () => {
    expect(DEFAULT_ORB_PREFS.enabled).toBe(true)
    expect(DEFAULT_ORB_PREFS.idleAnimation).toBe(true)
    expect(DEFAULT_ORB_PREFS.hotkey).toBe('CommandOrControl+Shift+K')
  })

  it('只写了一部分字段时，缺的字段各自补默认值', () => {
    const config = { ...base, orb: { enabled: false } } as ButlerConfig
    expect(orbPrefsOf(config)).toEqual({ ...DEFAULT_ORB_PREFS, enabled: false })
  })

  it('坐标为 null 表示「没存过」，与 0 区分开', () => {
    const config = { ...base, orb: { x: 0, y: 0 } } as ButlerConfig
    expect(orbPrefsOf(config).x).toBe(0)
    expect(orbPrefsOf({ ...base, orb: { x: null, y: null } } as ButlerConfig).x).toBeNull()
  })

  it('坐标是 NaN/Infinity 时当作没存过', () => {
    const config = { ...base, orb: { x: Number.NaN, y: Number.POSITIVE_INFINITY } } as ButlerConfig
    const prefs = orbPrefsOf(config)
    expect(prefs.x).toBeNull()
    expect(prefs.y).toBeNull()
  })

  it('非布尔值按默认值处理', () => {
    const config = { ...base, orb: { enabled: 'yes', idleAnimation: 1 } } as unknown as ButlerConfig
    const prefs = orbPrefsOf(config)
    expect(prefs.enabled).toBe(true)
    expect(prefs.idleAnimation).toBe(true)
  })
})

describe('clampToDisplay', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }

  it('在可见区域内时原样返回', () => {
    expect(clampToDisplay(800, 500, ORB_SIZE, area)).toEqual({ x: 800, y: 500 })
  })

  it('负坐标被夹回左上角', () => {
    expect(clampToDisplay(-300, -50, ORB_SIZE, area)).toEqual({ x: 0, y: 0 })
  })

  it('超出右下角时留出窗口自身大小', () => {
    const pos = clampToDisplay(9999, 9999, ORB_SIZE, area)
    expect(pos.x).toBe(area.width - ORB_SIZE)
    expect(pos.y).toBe(area.height - ORB_SIZE)
  })

  it('副屏拔掉后的坐标会被夹回主屏', () => {
    // 曾经存在第二块屏（起点 1920），现在只剩主屏：坐标必须落回主屏可见区
    const pos = clampToDisplay(2400, 300, ORB_SIZE, area)
    expect(pos.x).toBeLessThanOrEqual(area.width - ORB_SIZE)
    expect(pos.x).toBeGreaterThanOrEqual(0)
  })

  it('屏幕比窗口还小时不会算出负数', () => {
    const tiny = { x: 0, y: 0, width: 40, height: 40 }
    const pos = clampToDisplay(10, 10, ORB_SIZE, tiny)
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
  })
})

describe('defaultOrbPosition', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }

  it('落在右下角且留出边距', () => {
    const pos = defaultOrbPosition(ORB_SIZE, area)
    expect(pos.x).toBe(area.width - ORB_SIZE - 28)
    expect(pos.y).toBe(area.height - ORB_SIZE - 28)
  })

  it('带偏移的工作区（副屏）也按同一规则落点', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 }
    const pos = defaultOrbPosition(ORB_SIZE, second)
    expect(pos.x).toBeGreaterThanOrEqual(second.x)
    expect(pos.x + ORB_SIZE).toBeLessThanOrEqual(second.x + second.width)
  })
})
