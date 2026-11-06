import { describe, expect, it, vi } from 'vitest'
import { AuthBroker, machineEnv } from '../../src/main/runtime'
import type { AuthRequest } from '../../src/shared/types'

/**
 * 授权卡的登记簿。
 *
 * 拆出 AuthBroker 之后，这部分终于能不启动 Electron 就测——
 * 之前它藏在 index.ts 里，只能靠跑整个应用来验证。
 */

const req = (id: string): AuthRequest => ({
  id,
  tool: 'install_app',
  effect: 'install',
  title: `安装 ${id}`,
  target: `pkg-${id}`,
  impact: '会装东西',
  paramsPreview: '{}',
  requestedAt: new Date().toISOString(),
  allowAlways: true
})

describe('AuthBroker · 作答', () => {
  it('用户点「允许这一次」→ 闸门拿到 once', async () => {
    const broker = new AuthBroker()
    const emitted: unknown[] = []
    const waiting = broker.wait(req('a1'), 'req-1', (p) => emitted.push(p))
    expect(broker.answer('a1', 'once')).toBe(true)
    await expect(waiting).resolves.toBe('once')
    // 卡要先发给渲染层，否则用户看不见
    expect(emitted).toEqual([{ type: 'auth', request: expect.objectContaining({ id: 'a1' }) }])
  })

  it('畸形答案一律按拒绝处理', async () => {
    for (const bogus of ['yes', 'allow', 'maybe', undefined, null, 1]) {
      const broker = new AuthBroker()
      const waiting = broker.wait(req('a2'), 'req-2', () => {})
      broker.answer('a2', bogus as never)
      await expect(waiting, String(bogus)).resolves.toBe('deny')
    }
  })

  it('不认识或已作答的 authId 返回 false，不会误触发', () => {
    const broker = new AuthBroker()
    expect(broker.answer('nope', 'once')).toBe(false)
  })

  it('同一张卡只能作答一次', async () => {
    const broker = new AuthBroker()
    const waiting = broker.wait(req('a3'), 'req-3', () => {})
    expect(broker.answer('a3', 'once')).toBe(true)
    expect(broker.answer('a3', 'deny')).toBe(false)
    await expect(waiting).resolves.toBe('once')
  })
})

describe('AuthBroker · 按请求收口', () => {
  it('用户点停止 → 该请求名下所有未作答的卡一起按拒绝收口', async () => {
    const broker = new AuthBroker()
    const first = broker.wait(req('b1'), 'req-x', () => {})
    const second = broker.wait(req('b2'), 'req-x', () => {})
    broker.settleRequest('req-x', 'deny')
    await expect(first).resolves.toBe('deny')
    await expect(second).resolves.toBe('deny')
  })

  it('只收口指定请求的卡，别的不受影响', async () => {
    const broker = new AuthBroker()
    const one = broker.wait(req('c1'), 'req-a', () => {})
    const two = broker.wait(req('c2'), 'req-b', () => {})
    broker.settleRequest('req-a', 'deny')
    await expect(one).resolves.toBe('deny')
    // req-b 的卡还挂着，仍能正常作答
    expect(broker.answer('c2', 'once')).toBe(true)
    await expect(two).resolves.toBe('once')
  })

  it('对没有挂卡的请求收口是空操作', () => {
    const broker = new AuthBroker()
    expect(() => broker.settleRequest('req-none', 'deny')).not.toThrow()
  })

  it('收口后再作答返回 false（不会留下悬空回调）', async () => {
    const broker = new AuthBroker()
    const waiting = broker.wait(req('d1'), 'req-d', () => {})
    broker.settleRequest('req-d', 'deny')
    await waiting
    expect(broker.answer('d1', 'once')).toBe(false)
  })
})

describe('AuthBroker · 超时', () => {
  it('超时按 expired 返回，并通知渲染层把卡标成超时', async () => {
    vi.useFakeTimers()
    try {
      const broker = new AuthBroker()
      const events: Array<{ type: string; authId?: string }> = []
      const waiting = broker.wait(req('e1'), 'req-e', (p) => events.push(p as never))
      await vi.advanceTimersByTimeAsync(60_001)
      await expect(waiting).resolves.toBe('expired')
      expect(events.some((e) => e.type === 'authExpired' && e.authId === 'e1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('及时作答后不会再触发超时', async () => {
    vi.useFakeTimers()
    try {
      const broker = new AuthBroker()
      const events: Array<{ type: string }> = []
      const waiting = broker.wait(req('f1'), 'req-f', (p) => events.push(p as never))
      broker.answer('f1', 'once')
      await expect(waiting).resolves.toBe('once')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(events.some((e) => e.type === 'authExpired')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('machineEnv', () => {
  it('给出系统提示词需要的四项环境信息', () => {
    const env = machineEnv()
    expect(env.machineName).toBeTruthy()
    expect(env.userName).toBeTruthy()
    expect(env.osVersion).toMatch(/Windows/i)
    expect(env.today).toBeTruthy()
  })
})
