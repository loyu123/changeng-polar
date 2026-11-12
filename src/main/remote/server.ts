import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AuthAnswer, ChatMessage } from '../../shared/types'
import { RemoteHub } from './hub'
import { MOBILE_PAGE } from './mobile-page'
import { PairingStore } from './pairing'

/**
 * 远程入口的 HTTP 服务。
 *
 * 三条硬约束，写死在代码里、不给配置项：
 *
 * 1. **只监听 127.0.0.1**。外面那层是 frpc，由它从本机转发出去。
 *    长庚自己永远不直接面对公网——暴露面只有隧道那一个口，且必须带 token。
 * 2. **除 /api/ping 与 /api/pair 外一律要 token**。配对码只在 2 分钟内有效、用一次作废。
 * 3. **不新建执行路径**。远程这一轮走的还是 `executeTurn` → agent → gate → tools，
 *    授权闸门、审计、只读模式、工具开关全都照旧生效。这里只是一个入口。
 */

const MAX_BODY_BYTES = 64 * 1024
const SSE_HEARTBEAT_MS = 20_000
export const DEFAULT_REMOTE_PORT = 7474

export interface RemoteTurnParams {
  requestId: string
  messages: ChatMessage[]
  controller: AbortController
  emit: (raw: unknown) => void
  uiAuth: boolean
  /** 审计里要能一眼看出「这条是外面发的」 */
  origin: 'remote'
}

export interface RemoteDeps {
  version: string
  executeTurn: (params: RemoteTurnParams) => Promise<unknown>
  auth: {
    answer: (authId: string, answer: AuthAnswer) => boolean
    choose: (choiceId: string, value: string) => boolean
    settleRequest: (requestId: string, answer: AuthAnswer) => void
  }
  inflight: Map<string, AbortController>
  /** 配对成功后通知调用方把设备白名单落盘 */
  onPaired?: () => void | Promise<void>
}

interface JsonBody {
  [key: string]: unknown
}

/** 读请求体并解析 JSON；超长直接掐断，不把内存交给对面 */
async function readJson(req: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

export class RemoteServer {
  readonly hub = new RemoteHub()
  private server: Server | null = null
  private readonly sseClients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: RemoteDeps,
    private readonly pairing: PairingStore
  ) {}

  get listening(): boolean {
    return this.server !== null
  }

  get address(): string {
    const addr = this.server?.address()
    if (!addr || typeof addr === 'string') return '—'
    return `${addr.address}:${addr.port}`
  }

  async listen(port: number = DEFAULT_REMOTE_PORT, host = '127.0.0.1'): Promise<number> {
    if (this.server) return this.port()
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        // 任何没接住的异常都要回一句，否则手机端只能干等超时
        if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : '服务端异常' })
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`端口 ${port} 已被占用，远程入口没起来`)
            : err
        )
      })
      server.listen(port, host, () => resolve())
    })
    this.server = server
    this.heartbeat = setInterval(() => this.tick(), SSE_HEARTBEAT_MS)
    // 心跳不该拖住进程退出
    this.heartbeat.unref?.()
    return this.port()
  }

  port(): number {
    const addr = this.server?.address()
    return addr && typeof addr !== 'string' ? addr.port : 0
  }

  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        /* 已经断了 */
      }
    }
    this.sseClients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private tick(): void {
    for (const client of this.sseClients) {
      try {
        client.write(': ping\n\n')
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  /** token 从 Authorization 头取；SSE 用不了自定义头，退回查询参数 */
  private tokenOf(req: IncomingMessage, url: URL): string | null {
    const auth = req.headers.authorization
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
    const fromQuery = url.searchParams.get('token')
    return fromQuery ? fromQuery.trim() : null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    /**
     * 页面本身：手机浏览器打开根路径就看到配对界面。
     *
     * 不需要 token——页面本身不含任何凭据，配对是页面里后续发起的请求。
     * 这样「手机浏览器直接打开」和「App 的 WebView 加载」是同一份东西。
     */
    if ((path === '/' || path === '/index.html') && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 这个页面不需要从别处加载任何东西（无 CDN、无外部字体），
        // 明确告诉浏览器不要往外发请求
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      })
      res.end(MOBILE_PAGE)
      return
    }

    // 这两个不需要 token：一个是探活，一个是配对本身
    if (path === '/api/ping' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        name: 'changeng-polar',
        version: this.deps.version,
        paired: this.pairing.listDevices().length
      })
      return
    }

    if (path === '/api/pair' && method === 'POST') {
      const body = await readJson(req)
      const result = this.pairing.redeem(String(body.code ?? ''), String(body.label ?? ''))
      if (!result.ok) {
        sendJson(res, 401, { error: result.reason })
        return
      }
      // token 只在这一刻出现一次，之后服务端只留哈希
      sendJson(res, 200, { token: result.token, deviceId: result.device.id, label: result.device.label })
      // 落盘失败不影响这次配对（内存里已经生效），但下一次重启会丢
      void this.deps.onPaired?.()
      return
    }

    const device = this.pairing.verify(this.tokenOf(req, url))
    if (!device) {
      sendJson(res, 401, { error: '未配对或 token 已失效，请在电脑上重新生成配对码' })
      return
    }

    if (path === '/api/state' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: this.deps.version,
        busy: [...this.deps.inflight.keys()],
        device: { id: device.id, label: device.label }
      })
      return
    }

    if (path === '/api/devices' && method === 'GET') {
      sendJson(res, 200, { devices: this.pairing.listDevices() })
      return
    }

    if (path === '/api/devices/revoke' && method === 'POST') {
      const body = await readJson(req)
      const ok = this.pairing.revoke(String(body.deviceId ?? ''))
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }

    if (path === '/api/events' && method === 'GET') {
      this.openStream(res)
      return
    }

    if (path === '/api/turn' && method === 'POST') {
      const body = await readJson(req)
      const text = String(body.text ?? '').trim()
      if (!text) {
        sendJson(res, 400, { error: 'text 不能为空' })
        return
      }
      const requestId = String(body.requestId ?? '') || randomUUID()
      this.startTurn(requestId, text)
      sendJson(res, 202, { requestId })
      return
    }

    if (path === '/api/auth' && method === 'POST') {
      const body = await readJson(req)
      const authId = String(body.authId ?? '')
      const answer = body.answer === 'always' ? 'always' : body.answer === 'once' ? 'once' : 'deny'
      // 与桌面走同一个 broker：谁先点算谁，后到的返回 false
      const ok = this.deps.auth.answer(authId, answer)
      sendJson(res, ok ? 200 : 409, { ok, answer })
      return
    }

    if (path === '/api/choose' && method === 'POST') {
      const body = await readJson(req)
      const ok = this.deps.auth.choose(String(body.choiceId ?? ''), String(body.value ?? ''))
      sendJson(res, ok ? 200 : 409, { ok })
      return
    }

    if (path === '/api/abort' && method === 'POST') {
      const body = await readJson(req)
      const requestId = String(body.requestId ?? '')
      // 与桌面停止同一套动作：打断网络请求 + 把还挂着的卡按拒绝收口
      this.deps.inflight.get(requestId)?.abort()
      this.deps.auth.settleRequest(requestId, 'deny')
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: '没有这个接口' })
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // 明确告诉中间层不要缓冲：frp 或反代缓冲 SSE 会让"实时"变成"最后一次性到达"
      'x-accel-buffering': 'no'
    })
    res.write('event: ready\ndata: {}\n\n')
    this.sseClients.add(res)

    const unsubscribe = this.hub.subscribe((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      } catch {
        this.sseClients.delete(res)
      }
    })

    const cleanup = (): void => {
      unsubscribe()
      this.sseClients.delete(res)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  private startTurn(requestId: string, text: string): void {
    const controller = new AbortController()
    this.deps.inflight.set(requestId, controller)
    const emit = (raw: unknown): void => {
      this.hub.publish({ requestId, ...(raw as Record<string, unknown>) })
    }
    void this.deps
      .executeTurn({
        requestId,
        messages: [{ role: 'user', content: text }],
        controller,
        emit,
        // 远程有人在看（就是手机前面那个人），所以卡要真的发出去
        uiAuth: true,
        origin: 'remote'
      })
      .then((result) => {
        emit({ type: 'done', result })
      })
      .catch((err) => {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        // 与桌面一致：这一轮没被回答的卡一律按拒绝收口
        this.deps.auth.settleRequest(requestId, 'deny')
        this.deps.inflight.delete(requestId)
      })
  }
}
