import { describe, expect, it } from 'vitest'
import { windowAt, type WinInfo } from '../../src/main/node/screen'

/**
 * 命中哪个窗口 —— 白名单检查的依据。
 *
 * 这套「模拟键鼠」的安全模型是：模型说要点的坐标，**先算出它会落到哪个进程的窗口上**，
 * 不在白名单里就拒绝。所以这个判断一旦有偏差，白名单就是摆设：
 * 越界一格算错，模型就能点到白名单外的按钮。
 */

const win = (process: string, x: number, y: number, w: number, h: number, title = process): WinInfo => ({
  title,
  process,
  x,
  y,
  width: w,
  height: h
})

describe('windowAt 坐标命中', () => {
  it('落在窗口内返回那个窗口', () => {
    const wins = [win('chrome', 0, 0, 800, 600)]
    expect(windowAt(wins, 400, 300)?.process).toBe('chrome')
  })

  it('左上角算命中，右下角边界不算（半开区间，避免两个窗口交界处算两次）', () => {
    const wins = [win('chrome', 100, 100, 200, 200)]
    expect(windowAt(wins, 100, 100)?.process).toBe('chrome')
    // x = 300 已经出了 [100, 300) 这个区间
    expect(windowAt(wins, 300, 150)).toBeNull()
    expect(windowAt(wins, 299, 299)?.process).toBe('chrome')
  })

  it('窗口外的坐标返回 null（白名单检查据此拒绝）', () => {
    const wins = [win('chrome', 0, 0, 100, 100)]
    expect(windowAt(wins, 500, 500)).toBeNull()
    expect(windowAt(wins, -10, 50)).toBeNull()
  })

  it('多个窗口重叠时取前面那个（Z 序在前 = 实际看得见的）', () => {
    const wins = [win('chrome', 0, 0, 800, 600), win('notepad', 100, 100, 300, 300)]
    // (200,200) 两个都在，但 chrome 在前
    expect(windowAt(wins, 200, 200)?.process).toBe('chrome')
  })

  it('空列表不抛，返回 null（一个窗口都没有时不能崩）', () => {
    expect(windowAt([], 10, 10)).toBeNull()
  })

  it('负坐标窗口（副屏在左边）也能正确命中', () => {
    const wins = [win('code', -1920, 0, 1920, 1080)]
    expect(windowAt(wins, -1000, 500)?.process).toBe('code')
    expect(windowAt(wins, 100, 500)).toBeNull()
  })
})
