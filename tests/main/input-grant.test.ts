import { describe, expect, it } from 'vitest'
import { INPUT_GRANT_MAX_ACTIONS, INPUT_GRANT_MS, InputGrant } from '../../src/main/node/input-grant'

/**
 * 时间窗授权。
 *
 * 这是「模拟键鼠」唯一的安全闸：没有它，一次批准就等于把整块屏幕永久交出去。
 * 所以这里逐条钉死——过期、额度、撤销、重复批准，任何一条漏了，
 * 用户在手机上点的那个「允许」就罩不住后面的动作。
 */

/** 可控时钟：过期必须能精确断言，不能靠 sleep */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('输入授权窗口', () => {
  it('没批准过时一律拒绝，并说明要去批准', () => {
    const g = new InputGrant()
    const r = g.consume()
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('还没有授权')
    expect(g.active).toBe(false)
  })

  it('批准后可以动作，额度按次递减', () => {
    const c = clock()
    const g = new InputGrant(c.now)
    g.open('要在浏览器里点保存')
    expect(g.consume().ok).toBe(true)
    expect(g.state().remaining).toBe(INPUT_GRANT_MAX_ACTIONS - 1)
  })

  it('额度用完就失效，必须重新批准', () => {
    const c = clock()
    const g = new InputGrant(c.now)
    g.open()
    for (let i = 0; i < INPUT_GRANT_MAX_ACTIONS; i++) expect(g.consume().ok).toBe(true)
    const r = g.consume()
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('额度已用完')
    expect(g.active).toBe(false)
  })

  it('60 秒后自动过期（59.999 秒还能用，60 秒不能）', () => {
    const c = clock()
    const g = new InputGrant(c.now)
    g.open()
    c.advance(INPUT_GRANT_MS - 1)
    expect(g.consume().ok).toBe(true)

    g.open() // 重新批一次拿满额度
    c.advance(INPUT_GRANT_MS)
    const r = g.consume()
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('过期')
  })

  it('用户撤销后立刻失效', () => {
    const g = new InputGrant()
    g.open()
    expect(g.active).toBe(true)
    g.close()
    expect(g.active).toBe(false)
    expect(g.consume().ok).toBe(false)
  })

  it('重新批准会重置额度和时间，而不是在原余量上叠加', () => {
    // 否则有效期会越来越长，和"每次都要批"的初衷相反
    const c = clock()
    const g = new InputGrant(c.now)
    g.open()
    g.consume()
    g.consume()
    expect(g.state().remaining).toBe(INPUT_GRANT_MAX_ACTIONS - 2)

    c.advance(30_000)
    g.open()
    expect(g.state().remaining).toBe(INPUT_GRANT_MAX_ACTIONS)
    // 到期时间也要跟着往后推满 60 秒
    expect(g.state().expiresAt).toBe(c.now() + INPUT_GRANT_MS)
  })

  it('state 在失效时不泄露到期时间（避免界面显示一个过期的倒计时）', () => {
    const c = clock()
    const g = new InputGrant(c.now)
    g.open()
    c.advance(INPUT_GRANT_MS + 1)
    const s = g.state()
    expect(s.active).toBe(false)
    expect(s.expiresAt).toBeNull()
    expect(s.remaining).toBe(0)
  })

  it('理由会带出来（授权卡上显示过的那句，界面要能回看）', () => {
    const g = new InputGrant()
    g.open('在记事本里粘贴一段文字')
    expect(g.state().reason).toBe('在记事本里粘贴一段文字')
  })
})
