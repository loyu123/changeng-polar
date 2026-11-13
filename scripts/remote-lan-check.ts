/**
 * 远程入口的局域网自检：不用手机，也能确认「手机能不能连上来」。
 *
 * 用法：npx tsx scripts/remote-lan-check.ts
 *
 * 验的是什么：走的是应用里真实的那条装配（RemoteService → RemoteServer），
 * 真的绑到 0.0.0.0，然后**经本机的局域网 IP**（不是 127.0.0.1）把手机要走的
 * 每一步走一遍——探活、取页面、配对、带 token 访问、事件流、错的 token 被拒。
 * 127.0.0.1 能通不代表局域网 IP 能通：绑错地址、只绑回环、防火墙拦入站，
 * 这三种情况下回环测试全是绿的。
 *
 * 最后打印一遍设置页「自检」会给的那串结论，让脚本和界面说的是同一件事。
 *
 * 验不了的是什么：Windows 防火墙的入站放行。本机访问自己的局域网 IP 不经过
 * 那道入站过滤，所以「这里通了」+「防火墙规则存在」两件事都成立，手机仍可能
 * 被别的东西挡住。真机还是要用手机开一次。
 *
 * 不碰真实数据：RemoteDeps 全是假实现，数据目录是临时目录，退出即删。
 */
import { promises as fs } from 'node:fs'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_REMOTE_PORT, type RemoteDeps } from '../src/main/remote/server'
import { RemoteService } from '../src/main/remote/service'

const VERSION = 'remote-lan-check'

interface Reply {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

/** 最小 HTTP 客户端：指定 host，不跟随重定向 */
function call(opts: {
  host: string
  port: number
  path: string
  method?: string
  token?: string
  json?: unknown
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json)
    const req = request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {})
        },
        timeout: 5000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error('超时（5 秒）')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-check-'))
  const pairedCalls: number[] = []
  const deps: RemoteDeps = {
    version: VERSION,
    executeTurn: async () => ({ text: '（自检的假回答）' }),
    auth: { answer: () => false, choose: () => false, settleRequest: () => undefined },
    inflight: new Map(),
    onPaired: () => {
      pairedCalls.push(Date.now())
    }
  }
  const service = new RemoteService(deps, dataDir, DEFAULT_REMOTE_PORT)

  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`)
  }

  try {
    const started = await service.start(true)
    if (!started) {
      console.log(`❌ 服务起不来：${service.state().error ?? '未知原因'}`)
      process.exitCode = 1
      return
    }
    const port = service.state().port
    const lan = service.state().addresses.filter((a) => a.kind === 'lan')
    check('绑定 0.0.0.0（局域网模式）', service.state().lanAccess, `实际监听 ${service.state().address}`)

    if (lan.length === 0) {
      console.log('\n⚠️ 这台机器没有局域网 IPv4 地址，下面只能对回环测——手机那条路没被验证。')
    }
    const host = lan[0]?.ip ?? '127.0.0.1'
    const base = { host, port }
    const shown = `http://${host}:${port}`

    const ping = await call({ ...base, path: '/api/ping' })
    const pingBody = JSON.parse(ping.body) as { ok?: boolean }
    check('探活', ping.status === 200 && pingBody.ok === true, `GET ${shown}/api/ping → ${ping.status} ${ping.body}`)

    const page = await call({ ...base, path: '/' })
    check(
      '手机页面可取',
      page.status === 200 && page.body.includes('长庚 · 远程'),
      `${page.status} · ${page.body.length} 字节 · ${String(page.headers['content-type'])}`
    )

    const noToken = await call({ ...base, path: '/api/state' })
    check('没 token 被拒', noToken.status === 401, `${noToken.status} ${noToken.body}`)

    const badPair = await call({ ...base, path: '/api/pair', method: 'POST', json: { code: '000000', label: 'x' } })
    check('乱猜配对码被拒', badPair.status === 401, `${badPair.status} ${badPair.body}`)

    const code = service.pairing.issueCode().code
    const pair = await call({ ...base, path: '/api/pair', method: 'POST', json: { code, label: '自检手机' } })
    const token = (JSON.parse(pair.body) as { token?: string }).token
    check(
      '正确配对码换到 token',
      pair.status === 200 && typeof token === 'string' && token.length > 20,
      `${pair.status} · token ${token ? token.slice(0, 6) + '…（只在这一次出现）' : '缺失'}`
    )

    const again = await call({ ...base, path: '/api/pair', method: 'POST', json: { code, label: '第二台' } })
    check('同一个码不能再用第二次', again.status === 401, `${again.status} ${again.body}`)

    const state = await call({ ...base, path: '/api/state', token })
    check('带 token 能读到状态', state.status === 200 && state.body.includes('自检手机'), `${state.status} ${state.body}`)

    const wrong = await call({ ...base, path: '/api/state', token: 'deadbeef' })
    check('假 token 被拒', wrong.status === 401, `${wrong.status} ${wrong.body}`)

    // 事件流：手机的 SSE。只看响应头——连上后服务端会一直挂着，
    // 这里读到 headers 就算通，然后主动销毁（不等业务事件）
    const sse = await new Promise<{ status: number; type: string; ok: boolean }>((resolve) => {
      const req = request(
        {
          host,
          port,
          path: `/api/events?token=${encodeURIComponent(token ?? '')}`,
          headers: { accept: 'text/event-stream' },
          timeout: 5000
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            ok: res.statusCode === 200 && String(res.headers['content-type'] ?? '').includes('text/event-stream')
          })
          req.destroy()
        }
      )
      req.on('error', () => resolve({ status: 0, type: '', ok: false }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ status: 0, type: '', ok: false })
      })
      req.end()
    })
    check('事件流（SSE）能连上', sse.ok, `${sse.status} · content-type=${sse.type}`)

    check('配对成功回调被调用', pairedCalls.length === 1, `${pairedCalls.length} 次（供上层落盘设备白名单）`)

    // 设置页「自检」给的就是这一串，脚本和界面必须说同一件事
    console.log('\n—— 设置页「自检」会给出的结论 ——')
    for (const item of await service.diagnose()) {
      const mark = item.level === 'fail' ? '✕' : item.level === 'warn' ? '!' : item.level === 'unknown' ? '?' : '✓'
      console.log(`${mark} ${item.title}：${item.detail}`)
      if (item.action) console.log(`  → ${item.action}`)
      if (item.command) console.log(`    ${item.command}`)
    }
  } finally {
    await service.stop()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

void main().catch((err) => {
  console.error('自检中止：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
