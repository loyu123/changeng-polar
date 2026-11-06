import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORB_PREFS,
  DragAccumulator,
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

/**
 * 拖动位移的累加器。
 *
 * 这一组测试盯的是真机上那个「球越拖越偏、方向固定朝右下」的 bug。
 * 原先的绝对式算法（窗口位置 = 光标 − 抓取偏移）要求光标与窗口处在同一坐标系，
 * 一旦这个前提不成立，每帧都会重复同一个误差。增量式只用到「两次采样之差」，
 * 与原点无关，所以下面这些性质必须成立。
 */
describe('DragAccumulator', () => {
  const win = { x: 1607, y: 919 }
  const acc = (): DragAccumulator => {
    const a = new DragAccumulator()
    a.begin(win, { x: 1630, y: 940 })
    return a
  }

  it('没开始之前不动', () => {
    const a = new DragAccumulator()
    expect(a.step({ x: 1700, y: 1000 })).toBeNull()
  })

  it('光标不动就不返回新位置（调用方不必碰窗口）', () => {
    const a = acc()
    expect(a.step({ x: 1630, y: 940 })).toBeNull()
    expect(a.step({ x: 1630, y: 940 })).toBeNull()
  })

  it('窗口位移与光标位移一比一', () => {
    const a = acc()
    expect(a.step({ x: 1630 + 40, y: 940 + 25 })).toEqual({ x: win.x + 40, y: win.y + 25 })
  })

  it('分成很多小步累加，结果与一步到位相同', () => {
    const a = acc()
    let last = win
    for (let i = 1; i <= 100; i++) {
      const r = a.step({ x: 1630 + i * 3, y: 940 + i * 2 })
      if (r) last = r
    }
    expect(last).toEqual({ x: win.x + 300, y: win.y + 200 })
  })

  it('来回往返之后回到原点，不残留偏移', () => {
    const a = acc()
    a.step({ x: 1730, y: 1040 })
    a.step({ x: 1530, y: 840 })
    const r = a.step({ x: 1630, y: 940 })
    expect(r).toEqual(win)
  })

  /**
   * 关键一条：即便光标坐标整体平移了很大的量（模拟坐标系原点不同），
   * 窗口位置也只跟着「差值」走，不会被整体拖动。
   */
  it('光标坐标整体加一个大常数，窗口位置不受影响', () => {
    const a = new DragAccumulator()
    const shift = 100000
    a.begin(win, { x: 1630 + shift, y: 940 + shift })
    expect(a.step({ x: 1640 + shift, y: 950 + shift })).toEqual({ x: win.x + 10, y: win.y + 10 })
  })

  it('小数位移逐帧累加不丢精度', () => {
    const a = new DragAccumulator()
    a.begin({ x: 0, y: 0 }, { x: 0, y: 0 })
    let last = { x: 0, y: 0 }
    for (let i = 1; i <= 30; i++) {
      const r = a.step({ x: i * 0.34, y: i * 0.34 })
      if (r) last = r
    }
    // 30 * 0.34 = 10.2 → 取整 10，而不是逐帧取整后归零
    expect(last).toEqual({ x: 10, y: 10 })
  })

  /**
   * set() 只该在真的被夹边时调用。
   *
   * 这一条防的是实测踩到的坑：每帧都用取整后的位置回写累加器，会把小数部分
   * 丢掉；每帧丢 0.3px，60 帧就少走 20px，表现为「拖不到位」。
   */
  it('不调用 set() 时，小数精度可以跨很多帧累积', () => {
    const a = new DragAccumulator()
    a.begin({ x: 0, y: 0 }, { x: 0, y: 0 })
    let last = { x: 0, y: 0 }
    for (let i = 1; i <= 60; i++) {
      const r = a.step({ x: i * 5, y: i * 3.33 })
      if (r) last = r
    }
    // 60 * 3.33 = 199.8 → 200（若每帧回写取整值，这里会是 180）
    expect(last).toEqual({ x: 300, y: 200 })
  })

  it('set() 之后从新位置继续累加', () => {
    const a = new DragAccumulator()
    a.begin({ x: 100, y: 100 }, { x: 0, y: 0 })
    a.set({ x: 150, y: 150 })
    expect(a.step({ x: 10, y: 10 })).toEqual({ x: 160, y: 160 })
  })

  it('结束之后不再响应', () => {
    const a = acc()
    a.end()
    expect(a.step({ x: 1800, y: 1100 })).toBeNull()
    expect(a.active).toBe(false)
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
