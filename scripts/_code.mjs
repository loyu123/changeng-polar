const CDP = process.argv[2] ?? '9231'
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
const page = list.find((p) => p.type === 'page' && /index\.html/.test(p.url))
if (!page) throw new Error('没找到主窗口（应用可能已关闭）')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const p = pend.get(m.id)
  if (p) { pend.delete(m.id); p(m.result?.result?.value) }
}
await new Promise((r) => (ws.onopen = r))
const ev = (expr) => new Promise((resolve) => {
  const i = ++id
  pend.set(i, resolve)
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
})
const st = await ev('window.butler.remote.state()')
console.log('服务:', st.enabled ? '开' : '关', '| 监听:', st.address, '| 局域网:', st.lanAccess)
if (!st.enabled || !st.lanAccess) {
  const on = await ev('window.butler.remote.enable(true, true)')
  console.log('已重新开启 →', on.address, on.lanAccess)
}
const issued = await ev('window.butler.remote.issuePairingCode()')
if (issued.ok) {
  console.log('配对码:', issued.code)
  const left = Math.round((issued.expiresAt - Date.now()) / 1000)
  console.log('有效期:', left, '秒')
} else console.log('生成失败:', issued.error)
ws.close()
