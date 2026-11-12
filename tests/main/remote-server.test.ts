import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingStore } from '../../src/main/remote/pairing'
import { RemoteServer, type RemoteDeps, type RemoteTurnParams } from '../../src/main/remote/server'

/**
 * 远程 HTTP 入口的端到端行为（真的起服务、真的用 HTTP 打）。
 *
 * 这一层是"手机能不能遥控电脑"的全部界面。测试要回答的不是"路由写得对不对"，
 * 而是几条不能出错的事：没 token 什么都干不了、授权答案只有两种有效值、
 * 停止会把挂着的卡按拒绝收口、以及服务只绑回环地址。
 */

const servers: RemoteServer[] = []

async function boot(overrides: Partial<RemoteDeps> = {}) {
  const pairing = new PairingStore()
  const inflight = new Map<string, AbortController>()
  const deps: RemoteDeps = {
    version: 'test-1.0',
    executeTurn: vi.fn(async () => ({ text: 'ok' })),
    auth: {
      answer: vi.fn(() => true),
      choose: vi.fn(() => true),
      settleRequest: vi.fn()
    },
    inflight,
    ...overrides
  }
  const server = new RemoteServer(deps, pairing)
  const port = await server.listen(0, '127.0.0.1')
  servers.push(server)
  return { server, pairing, deps, inflight, base: `http://127.0.0.1:${port}` }
}

/** 配对一次，拿到 token */
async function pair(base: string, pairing: PairingStore): Promise<string> {
  const { code } = pairing.issueCode()
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label: '手机' })
  })
  const body = (await res.json()) as { token: string }
  return body.token
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

describe('远程入口 · 鉴权', () => {
  it('探活不需要 token', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/api/ping`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('changeng-polar')
  })

  it('没有 token 时，发指令被拒（401）', async () => {
    const { base, deps } = await boot()
    const res = await fetch(`${base}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '删掉桌面上的文件' })
    })
    expect(res.status).toBe(401)
    // 关键：不仅回 401，执行函数根本不该被调用
    expect(deps.executeTurn).not.toHaveBeenCalled()
  })

  it('伪造 token 被拒', async () => {
    const { base } = await boot()
    // 头里只能放 ASCII；伪造的是"结构正确但没配过对"的那一类
    const res = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer forged-token-000' } })
    expect(res.status).toBe(401)
  })

  it('配对码错误时不给 token', async () => {
    const { base, pairing } = await boot()
    pairing.issueCode()
    const res = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'xxxxxx', label: '手机' })
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { token?: string }).token).toBeUndefined()
  })

  it('配对成功后 onPaired 被调用（设备白名单要落盘）', async () => {
    const onPaired = vi.fn()
    const { base, pairing } = await boot({ onPaired })
    await pair(base, pairing)
    expect(onPaired).toHaveBeenCalledTimes(1)
  })
})

describe('远程入口 · 发指令', () => {
  it('带 token 发一句话 → 走 executeTurn，且标记来源为 remote、要真的弹卡', async () => {
    const { base, pairing, deps } = await boot()
    const token = await pair(base, pairing)

    const res = await fetch(`${base}/api/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '列一下桌面的文件', requestId: 'r1' })
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { requestId: string }).requestId).toBe('r1')

    // startTurn 是异步发起的，等它跑到 executeTurn
    await vi.waitFor(() => expect(deps.executeTurn).toHaveBeenCalledTimes(1))
    const params = (deps.executeTurn as ReturnType<typeof vi.fn>).mock.calls[0][0] as RemoteTurnParams
    expect(params.origin).toBe('remote')
    // uiAuth 必须是 true：远程那个人就在手机前，卡要真的发出去
    expect(params.uiAuth).toBe(true)
    expect(params.messages).toEqual([{ role: 'user', content: '列一下桌面的文件' }])
  })

  it('空 text 直接拒（不白白起一轮）', async () => {
    const { base, pairing, deps } = await boot()
    const token = await pair(base, pairing)
    const res = await fetch(`${base}/api/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' })
    })
    expect(res.status).toBe(400)
    expect(deps.executeTurn).not.toHaveBeenCalled()
  })

  it('一轮结束后把还没回答的卡按拒绝收口', async () => {
    const { base, pairing, deps } = await boot()
    const token = await pair(base, pairing)
    await fetch(`${base}/api/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '做点什么', requestId: 'r2' })
    })
    await vi.waitFor(() => expect(deps.auth.settleRequest).toHaveBeenCalledWith('r2', 'deny'))
  })
})

describe('远程入口 · 远程授权', () => {
  it('approve：把 once 交给同一个 broker（与桌面是同一份状态）', async () => {
    const { base, pairing, deps } = await boot()
    const token = await pair(base, pairing)
    const res = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ authId: 'a1', answer: 'once' })
    })
    expect(res.status).toBe(200)
    expect(deps.auth.answer).toHaveBeenCalledWith('a1', 'once')
  })

  it('畸形答案一律按拒绝，不允许"传个奇怪值就变成已授权"', async () => {
    const { base, pairing, deps } = await boot()
    const token = await pair(base, pairing)
    for (const bad of ['yes', 'true', 'ALLOW', '', 1, null, {}]) {
      await fetch(`${base}/api/auth`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ authId: 'a1', answer: bad })
      })
    }
    const answers = (deps.auth.answer as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(answers.every((a) => a === 'deny')).toBe(true)
  })

  it('卡已经失效时返回 409 而不是假装成功', async () => {
    const { base, pairing } = await boot({
      auth: { answer: () => false, choose: () => false, settleRequest: () => {} }
    })
    const token = await pair(base, pairing)
    const res = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ authId: 'a1', answer: 'once' })
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
  })
})

describe('远程入口 · 停止', () => {
  it('停止会打断请求并把卡按拒绝收口（与桌面停止同一套动作）', async () => {
    const { base, pairing, deps, inflight } = await boot()
    const token = await pair(base, pairing)
    const controller = new AbortController()
    inflight.set('r3', controller)

    const res = await fetch(`${base}/api/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r3' })
    })
    expect(res.status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
    expect(deps.auth.settleRequest).toHaveBeenCalledWith('r3', 'deny')
  })
})

describe('远程入口 · 监听范围', () => {
  it('只绑回环地址，公网看不到服务本身', async () => {
    const { server } = await boot()
    // 地址必须是 127.0.0.1：这是"长庚自己永远不直接面对公网"的唯一保证
    expect(server.address.startsWith('127.0.0.1:')).toBe(true)
  })
})

describe('远程入口 · 事件流', () => {
  it('SSE 能收到 ready，并把广播的事件推下来', async () => {
    const { base, pairing, server } = await boot()
    const token = await pair(base, pairing)

    const controller = new AbortController()
    const res = await fetch(`${base}/api/events?token=${token}`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // 先读掉 ready
    while (!text.includes('event: ready')) {
      const { value } = await reader.read()
      text += decoder.decode(value)
    }
    // 广播一条，看它有没有真的下来
    server.hub.publish({ type: 'auth', request: { id: 'a1', title: '删文件' } })
    while (!text.includes('"type":"auth"')) {
      const { value } = await reader.read()
      text += decoder.decode(value)
    }
    expect(text).toContain('删文件')
    controller.abort()
  })
})
