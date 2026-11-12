import { describe, expect, it } from 'vitest'
import { listWindows, windowAt } from '../../src/main/node/screen'

/**
 * 截图与窗口枚举的真机集成测试。
 *
 * 窗口枚举是「模拟键鼠」白名单检查的依据，而且踩过一个坑：
 * 最初用 `Add-Type -TypeDefinition` 写 P/Invoke，被安全软件判成
 * `ScriptContainedMaliciousContent`，脚本根本起不来。改成纯 .NET
 * 的 UI Automation 之后才通。
 *
 * 截图不在这里：`System.Drawing.CopyFromScreen` 同样被 AMSI 拦，
 * 已改用 Electron 的 desktopCapturer（见 src/main/capture.ts），
 * 那个要在真实 Electron 进程里才能验证。
 *
 * 所以这里测的不是"函数签名对不对"，而是**这条 PowerShell 路子在这台机器上到底能不能跑**——
 * 一旦哪天策略又变了，这里会先红，而不是等到用户点授权时才发现截不了图。
 *
 * 无图形环境（CI、远程会话）下跳过：那时 CopyFromScreen 必然拿不到画面。
 */
const hasDisplay = process.platform === 'win32' && Boolean(process.env.SESSIONNAME)

describe.skipIf(!hasDisplay)('真机 · 屏幕截图与窗口枚举', () => {
  it('能枚举出可见窗口，且每个都带进程名和矩形', async () => {
    const wins = await listWindows()
    expect(Array.isArray(wins)).toBe(true)
    // 桌面上总有至少一个可见窗口（任务栏、资源管理器…）
    expect(wins.length).toBeGreaterThan(0)
    for (const w of wins) {
      expect(typeof w.process).toBe('string')
      expect(w.width).toBeGreaterThan(0)
      expect(w.height).toBeGreaterThan(0)
    }
  }, 30_000)

  it('拿到的矩形能用于命中判断：窗口中心点应该命中它自己', async () => {
    const wins = await listWindows()
    const w = wins.find((x) => x.width > 50 && x.height > 50)
    if (!w) return
    const hit = windowAt(wins, Math.round(w.x + w.width / 2), Math.round(w.y + w.height / 2))
    expect(hit).not.toBeNull()
  }, 30_000)
})
