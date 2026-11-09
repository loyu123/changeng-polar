import { describe, expect, it, vi } from 'vitest'
import { AuthBroker, machineEnv } from '../../src/main/runtime'
import type { AuthRequest, ToolChoiceRequest } from '../../src/shared/types'

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

describe('AuthBroker · 候选卡', () => {
  const choiceReq = (id: string): ToolChoiceRequest => ({
    id,
    tool: 'install_app',
    title: '你要装哪一个「kimi」？',
    hint: '选定后还会再弹一次安装确认卡',
    options: [
      { value: 'MoonshotAI.Kimi', label: 'Kimi', detail: 'MoonshotAI.Kimi · 3.2.24' },
      { value: 'MoonshotAI.KimiCLI', label: 'Kimi CLI', detail: 'MoonshotAI.KimiCLI · 1.52.0' }
    ],
    requestedAt: new Date().toISOString()
  })

  it('用户点了某一项 → 闸门拿到那个值', async () => {
    const broker = new AuthBroker()
    const events: Array<{ type: string }> = []
    const waiting = broker.waitChoice(choiceReq('g1'), 'req-g', (p) => events.push(p as never))
    expect(broker.choose('g1', 'MoonshotAI.KimiCLI')).toBe(true)
    await expect(waiting).resolves.toBe('MoonshotAI.KimiCLI')
    expect(events[0]?.type).toBe('choice')
  })

  /**
   * 渲染层传来的 value 是不可信输入：它会被写回工具参数、再拿去解析执行。
   * 只认卡上真列出的值，才守得住「用户点了 A、实际装 B」那条缝。
   */
  it('不在候选集里的值一律按「没选」处理（挡住伪造的 Id）', async () => {
    const broker = new AuthBroker()
    const waiting = broker.waitChoice(choiceReq('g2'), 'req-g2', () => {})
    expect(broker.choose('g2', 'Evil.Package')).toBe(true) // 卡确实在等，返回 true
    await expect(waiting).resolves.toBeNull() // 但值没被采纳
  })

  it('认识/已作答过的 choiceId 返回 false', () => {
    const broker = new AuthBroker()
    expect(broker.choose('nope', 'MoonshotAI.Kimi')).toBe(false)
  })

  it('同一张卡只能作答一次', async () => {
    const broker = new AuthBroker()
    const waiting = broker.waitChoice(choiceReq('g3'), 'req-g3', () => {})
    expect(broker.choose('g3', 'MoonshotAI.Kimi')).toBe(true)
    expect(broker.choose('g3', 'MoonshotAI.KimiCLI')).toBe(false)
    await expect(waiting).resolves.toBe('MoonshotAI.Kimi')
  })

  it('用户点停止 → 候选卡按「没选」收口（不替用户挑一个）', async () => {
    const broker = new AuthBroker()
    const waiting = broker.waitChoice(choiceReq('g4'), 'req-g4', () => {})
    broker.settleRequest('req-g4', 'deny')
    await expect(waiting).resolves.toBeNull()
    expect(broker.choose('g4', 'MoonshotAI.Kimi')).toBe(false)
  })

  it('授权卡与候选卡挂在同一请求下，收口时一起清掉', async () => {
    const broker = new AuthBroker()
    const auth = broker.wait(req('g5'), 'req-g5', () => {})
    const choice = broker.waitChoice(choiceReq('g6'), 'req-g5', () => {})
    broker.settleRequest('req-g5', 'deny')
    await expect(auth).resolves.toBe('deny')
    await expect(choice).resolves.toBeNull()
  })

  it('超时按「取消」返回并通知渲染层，不会自动选一个', async () => {
    vi.useFakeTimers()
    try {
      const broker = new AuthBroker()
      const events: Array<{ type: string; choiceId?: string }> = []
      const waiting = broker.waitChoice(choiceReq('g7'), 'req-g7', (p) => events.push(p as never))
      await vi.advanceTimersByTimeAsync(60_001)
      await expect(waiting).resolves.toBeNull()
      expect(events.some((e) => e.type === 'choiceExpired' && e.choiceId === 'g7')).toBe(true)
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
