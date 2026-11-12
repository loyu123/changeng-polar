import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAIR_CODE_MAX_ATTEMPTS, PAIR_CODE_TTL_MS, PairingStore, hashToken } from '../../src/main/remote/pairing'

const fspTmp = () => tmpdir()

/**
 * 远程入口的配对与设备白名单。
 *
 * 这一层是整条远程链路的门锁：配对码一旦能被猜、能被重复使用、能永不过期，
 * 后面所有"授权卡""审计""总闸"都是摆设——攻击者根本不需要走那些路径。
 * 所以这里逐条钉死，不靠"看着像对的"。
 */

/** 可控时钟：过期这类事必须能精确断言，不能靠 sleep */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('配对码', () => {
  it('生成的码是 6 位数字', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()
    expect(code).toMatch(/^\d{6}$/)
  })

  it('码在 2 分钟内有效，过期后用不了', () => {
    const c = clock()
    const store = new PairingStore(c.now)
    const { code } = store.issueCode()

    c.advance(PAIR_CODE_TTL_MS - 1)
    expect(store.codeRemainingMs()).toBeGreaterThan(0)

    c.advance(2)
    expect(store.codeRemainingMs()).toBe(0)
    const r = store.redeem(code, '手机')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('过期')
  })

  it('码用一次就作废：同一个码不能换两个 token', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()

    const first = store.redeem(code, '手机')
    expect(first.ok).toBe(true)

    const second = store.redeem(code, '手机')
    expect(second.ok).toBe(false)
  })

  it('码错了不会通过，并且试满 5 次后整个码作废（防爆破）', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()

    for (let i = 0; i < PAIR_CODE_MAX_ATTEMPTS; i++) {
      expect(store.redeem('000000' === code ? '111111' : '000000', '手机').ok).toBe(false)
    }
    // 次数用完：连正确的码也不再接受，必须重新生成
    const after = store.redeem(code, '手机')
    expect(after.ok).toBe(false)
    expect(after.ok === false && (after.reason.includes('试错') || after.reason.includes('过期'))).toBe(true)
    expect(store.peekCode()).toBeNull()
  })

  it('重新生成会顶掉旧码（同时只有一个有效码）', () => {
    const store = new PairingStore()
    const old = store.issueCode()
    const fresh = store.issueCode()
    expect(store.redeem(old.code, '手机').ok).toBe(false)
    expect(store.redeem(fresh.code, '手机').ok).toBe(true)
  })

  it('发码时把上一次的试错计数清零', () => {
    const store = new PairingStore()
    store.issueCode()
    store.redeem('000000', '手机')
    store.redeem('000000', '手机')
    const { code } = store.issueCode()
    // 计数清零后，正确码仍然可用
    expect(store.redeem(code, '手机').ok).toBe(true)
  })
})

describe('token 与设备白名单', () => {
  it('换到的 token 能用，伪造的不能用', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()
    const r = store.redeem(code, '手机')
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(store.verify(r.token)?.label).toBe('手机')
    expect(store.verify('伪造的')).toBeNull()
    expect(store.verify('')).toBeNull()
    expect(store.verify(null)).toBeNull()
  })

  it('落盘快照里没有明文 token，只有哈希', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()
    const r = store.redeem(code, '手机')
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const snap = store.snapshot()
    const serialized = JSON.stringify(snap)
    // 明文 token 不能出现在任何要落盘的地方
    expect(serialized).not.toContain(r.token)
    expect(snap[0]?.tokenHash).toBe(hashToken(r.token))
  })

  it('给界面看的设备清单不含 tokenHash', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()
    store.redeem(code, '手机')
    expect(JSON.stringify(store.listDevices())).not.toContain('tokenHash')
  })

  it('踢掉设备之后它的 token 立刻失效', () => {
    const store = new PairingStore()
    const { code } = store.issueCode()
    const r = store.redeem(code, '手机')
    if (!r.ok) throw new Error('配对应成功')

    expect(store.revoke(r.device.id)).toBe(true)
    expect(store.verify(r.token)).toBeNull()
    expect(store.revoke('不存在的')).toBe(false)
  })

  it('revokeAll 清空全部设备', () => {
    const store = new PairingStore()
    for (const label of ['手机A', '手机B']) {
      const { code } = store.issueCode()
      store.redeem(code, label)
    }
    expect(store.listDevices()).toHaveLength(2)
    expect(store.revokeAll()).toBe(2)
    expect(store.listDevices()).toHaveLength(0)
  })

  it('restore 只接结构完整的设备，坏数据直接丢掉而不是让进程崩', () => {
    const store = new PairingStore()
    store.restore([
      { id: 'a', label: '手机', tokenHash: 'h', createdAt: 1, lastSeenAt: null },
      { id: 'b' } as never,
      null as never
    ])
    expect(store.listDevices()).toHaveLength(1)
  })

  it('verify 会刷新 lastSeenAt（界面据此显示"上次连接"）', () => {
    const c = clock()
    const store = new PairingStore(c.now)
    const { code } = store.issueCode()
    const r = store.redeem(code, '手机')
    if (!r.ok) throw new Error('配对应成功')
    expect(store.listDevices()[0]?.lastSeenAt).toBeNull()

    c.advance(5000)
    store.verify(r.token)
    expect(store.listDevices()[0]?.lastSeenAt).toBe(1_005_000)
  })
})

describe('远程服务 · 重复启动不能冲掉已配对设备', () => {
  it('start() 只在第一次读磁盘，第二次不再覆盖内存里的设备', async () => {
    // 真机踩到过：先开总闸 → 配一部手机 → 关掉再打开，
    // 第二次 start 用磁盘上的旧列表（还可能因为落盘是异步的而是空的）
    // 覆盖了内存，表现是"刚配对完就提示 token 失效"。
    const dir = await fsp.mkdtemp(path.join(fspTmp(), 'remote-svc-'))
    const { RemoteService } = await import('../../src/main/remote/service')
    const svc = new RemoteService(
      {
        version: 't',
        executeTurn: async () => ({}),
        auth: { answer: () => true, choose: () => true, settleRequest: () => {} },
        inflight: new Map()
      },
      dir,
      0
    )
    try {
      await svc.start()
      const issued = await svc.issuePairingCode()
      if ('error' in issued) throw new Error(issued.error)
      const r = svc.pairing.redeem(issued.code, '手机')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      await svc.persistDevices()

      // 关掉再打开：设备必须还在
      await svc.stop()
      await svc.start()
      expect(svc.pairing.verify(r.token)).not.toBeNull()
      expect(svc.pairing.listDevices()).toHaveLength(1)
    } finally {
      await svc.stop()
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('远程服务 · 监听范围', () => {
  it('默认只监听回环；局域网模式才监听 0.0.0.0', async () => {
    const dir = await fsp.mkdtemp(path.join(fspTmp(), 'remote-lan-'))
    const { RemoteService } = await import('../../src/main/remote/service')
    const svc = new RemoteService(
      {
        version: 't',
        executeTurn: async () => ({}),
        auth: { answer: () => true, choose: () => true, settleRequest: () => {} },
        inflight: new Map()
      },
      dir,
      0
    )
    try {
      await svc.start()
      expect(svc.state().lanAccess).toBe(false)
      expect(svc.state().address.startsWith('127.0.0.1:')).toBe(true)
      // 回环模式下手机地址就只有本机那一个，不该把局域网 IP 也列出来骗人
      expect(svc.state().urls.every((u) => u.includes('127.0.0.1'))).toBe(true)

      await svc.stop()
      await svc.start(true)
      expect(svc.state().lanAccess).toBe(true)
      expect(svc.state().address.startsWith('0.0.0.0:')).toBe(true)
    } finally {
      await svc.stop()
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('关掉之后监听模式也复位：不能下次悄悄还开着 0.0.0.0', async () => {
    const dir = await fsp.mkdtemp(path.join(fspTmp(), 'remote-lan2-'))
    const { RemoteService } = await import('../../src/main/remote/service')
    const svc = new RemoteService(
      {
        version: 't',
        executeTurn: async () => ({}),
        auth: { answer: () => true, choose: () => true, settleRequest: () => {} },
        inflight: new Map()
      },
      dir,
      0
    )
    try {
      await svc.start(true)
      expect(svc.state().lanAccess).toBe(true)
      await svc.stop()
      expect(svc.state().lanAccess).toBe(false)
      expect(svc.state().enabled).toBe(false)
      expect(svc.state().urls).toEqual([])
    } finally {
      await svc.stop()
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('远程服务 · 换监听地址必须真的重新绑定', () => {
  it('先回环再开局域网：socket 真的切到 0.0.0.0，state 不许谎报', async () => {
    // 真机踩到过：服务先在 127.0.0.1 上跑着，再要求绑 0.0.0.0 时
    // listen() 直接 return（因为 this.server 已存在），什么也没做，
    // 而调用方以为切过去了——界面显示"已开启局域网"，手机连不上。
    const dir = await fsp.mkdtemp(path.join(fspTmp(), 'remote-rebind-'))
    const { RemoteService } = await import('../../src/main/remote/service')
    const svc = new RemoteService(
      {
        version: 't',
        executeTurn: async () => ({}),
        auth: { answer: () => true, choose: () => true, settleRequest: () => {} },
        inflight: new Map()
      },
      dir,
      0
    )
    try {
      await svc.start(false)
      expect(svc.state().lanAccess).toBe(false)
      expect(svc.state().address.startsWith('127.0.0.1:')).toBe(true)

      // 同一个服务对象上切换模式（不 stop，模拟界面上直接切开关）
      const portBefore = svc.state().port
      await svc.start(true)
      expect(svc.state().lanAccess).toBe(true)
      expect(svc.state().address.startsWith('0.0.0.0:')).toBe(true)
      // 端口要沿用，不能因为重绑就换一个
      expect(svc.state().port).toBe(portBefore)

      // 切回来也一样
      await svc.start(false)
      expect(svc.state().lanAccess).toBe(false)
      expect(svc.state().address.startsWith('127.0.0.1:')).toBe(true)
    } finally {
      await svc.stop()
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
