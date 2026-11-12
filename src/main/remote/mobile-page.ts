/**
 * 手机端页面（单文件，无框架、无构建步骤）。
 *
 * 为什么内联成一个字符串而不放在 public/ 里：
 * 这个页面必须跟着主进程一起进 app.asar，而打包配置只收 out/**。
 * 内联省掉一整条「构建时把静态文件拷到哪」的链路，也省掉一个可能配错的地方。
 *
 * 为什么不用 React：
 * 手机浏览器直接打开，首屏要快；而这个界面只有三个状态（配对 / 对话 / 断线），
 * 引入框架带来的构建步骤换不到什么。**这份 HTML 之后会原样塞进 APK 的 WebView**，
 * 所以它不能依赖任何外部 CDN——用户在外面可能连不上。
 *
 * 安全上要注意的两点：
 * 1. token 存在 localStorage，页面本身不含任何凭据；
 * 2. 页面显示的一切都来自服务端，不在前端拼 HTML（用 textContent，不用 innerHTML）。
 */
export const MOBILE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1F1F1D">
<title>长庚 · 远程</title>
<style>
  :root {
    --bg: #F7F6F3; --card: #fff; --ink: #1F1F1D; --sub: #6B6B63;
    --line: #E4E2DC; --brand: #3D3B33; --danger: #B4552D; --ok: #3F7A52;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#161614; --card:#1F1F1D; --ink:#EDEBE5; --sub:#9A988F; --line:#312F2B; --brand:#EDEBE5; }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 -apple-system, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
  }
  .wrap { max-width: 640px; margin: 0 auto; padding: 16px; }
  .hide { display: none !important; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--sub); font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
  input {
    flex: 1; min-width: 0; font-size: 17px; padding: 12px 14px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  }
  input:focus { outline: 2px solid var(--brand); outline-offset: -1px; }
  button {
    font: inherit; font-weight: 600; border-radius: 10px; border: 1px solid var(--line);
    background: var(--card); color: var(--ink); padding: 12px 16px; cursor: pointer;
  }
  button.primary { background: var(--brand); color: var(--bg); border-color: var(--brand); }
  button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
  button.ok { background: var(--ok); color: #fff; border-color: var(--ok); }
  button:disabled { opacity: .5; }
  .big { width: 100%; padding: 16px; font-size: 17px; }
  #code { letter-spacing: 8px; text-align: center; font-variant-numeric: tabular-nums; font-size: 24px; }
  #log { display: flex; flex-direction: column; gap: 10px; margin-bottom: 90px; }
  .msg { border-radius: 12px; padding: 10px 13px; white-space: pre-wrap; word-break: break-word; }
  .me { background: var(--brand); color: var(--bg); align-self: flex-end; max-width: 85%; }
  .bot { background: var(--card); border: 1px solid var(--line); }
  .tool { font-size: 12px; color: var(--sub); padding-left: 4px; }
  .err { color: var(--danger); font-size: 13px; }
  .composer {
    position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg);
    border-top: 1px solid var(--line); padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  }
  .composer .wrap { padding: 0; display: flex; gap: 8px; }
  /* 授权卡：手机上点得准比好看重要 */
  /* 卡片可能比屏幕高（长路径 + 长影响说明），所以限高并允许内部滚动，
     否则按钮会被挤出可视区域——和"被输入栏盖住"是同一类问题。 */
  #authWrap { max-height: 75vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  #authCard { border: 2px solid var(--danger); }
  #authCard .impact { font-size: 13px; color: var(--sub); margin: 8px 0 14px; }
  #authCard .target { font-size: 13px; word-break: break-all; background: var(--bg); padding: 8px; border-radius: 8px; margin: 8px 0; max-height: 22vh; overflow-y: auto; }
  #authCard .btns { display: flex; gap: 10px; }
  #authCard .btns button { flex: 1; padding: 18px; font-size: 17px; min-height: 56px; }
  /* 截图：卡片可能因此变高，所以图本身也限高——
     按钮必须始终能被看到，这和"允许被输入栏盖住"是同一类问题。 */
  #authShotWrap { margin: 4px 0 12px; }
  #authShotWrap .shotlabel { font-size: 12px; color: var(--sub); margin-bottom: 6px; }
  #authShotWrap img {
    width: 100%; max-height: 34vh; object-fit: contain;
    border-radius: 8px; border: 1px solid var(--line); background: #000;
  }
  .pill { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--line); }
</style>
</head>
<body>
<div class="wrap">

  <!-- 配对 -->
  <section id="pairView" class="hide">
    <h1>连接这台电脑</h1>
    <div class="sub" style="margin-bottom:16px">在电脑上打开「设置 → 远程访问」，生成配对码</div>
    <div class="card">
      <input id="code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
      <div style="height:12px"></div>
      <button id="pairBtn" class="primary big">配对</button>
      <div id="pairMsg" class="err" style="margin-top:10px"></div>
    </div>
  </section>

  <!-- 对话 -->
  <section id="chatView" class="hide">
    <h1>长庚</h1>
    <div class="sub" id="statusLine" style="margin-bottom:14px">已连接</div>
    <div id="log"></div>
  </section>

</div>

<!-- 授权卡：固定在下面，手指够得到 -->
<div id="authWrap" class="composer hide">
  <div class="wrap">
    <div id="authCard" class="card" style="margin:0">
      <div style="font-weight:600" id="authTitle"></div>
      <div class="target" id="authTarget"></div>
      <div class="impact" id="authImpact"></div>
      <!-- 屏幕截图：模拟键鼠的卡才有。手机上看不清就无法判断它要点什么 -->
      <div id="authShotWrap" class="hide">
        <div class="shotlabel">当前屏幕</div>
        <img id="authShot" alt="当前屏幕" />
      </div>
      <div class="btns">
        <button id="denyBtn" class="danger">拒绝</button>
        <button id="allowBtn" class="ok">允许</button>
      </div>
    </div>
  </div>
</div>

<div id="composerBar" class="composer hide">
  <div class="wrap">
    <input id="input" placeholder="说点什么…" autocomplete="off">
    <button id="sendBtn" class="primary">发送</button>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'changeng-token'
  var token = localStorage.getItem(TOKEN_KEY) || ''
  var es = null
  var requestId = null
  var busy = false

  var $ = function (id) { return document.getElementById(id) }

  function show(which) {
    $('pairView').classList.toggle('hide', which !== 'pair')
    $('chatView').classList.toggle('hide', which !== 'chat')
    $('composerBar').classList.toggle('hide', which !== 'chat')
    if (which !== 'chat') $('authWrap').classList.add('hide')
  }

  function api(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign({}, opts.headers, { authorization: 'Bearer ' + token })
    return fetch(path, opts)
  }

  function addMsg(text, kind) {
    var el = document.createElement('div')
    el.className = 'msg ' + (kind === 'me' ? 'me' : kind === 'tool' ? 'tool' : 'bot')
    // 一律用 textContent：服务端/模型的话里可能有尖括号，拼 HTML 会被当成标签
    el.textContent = text
    $('log').appendChild(el)
    window.scrollTo(0, document.body.scrollHeight)
    return el
  }

  // ---- 配对 ----
  $('pairBtn').onclick = async function () {
    var code = ($('code').value || '').trim()
    if (!/^\\d{6}$/.test(code)) { $('pairMsg').textContent = '请输入 6 位数字配对码'; return }
    $('pairBtn').disabled = true
    $('pairMsg').textContent = ''
    try {
      var r = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code, label: '手机' })
      })
      var body = await r.json()
      if (!r.ok) { $('pairMsg').textContent = body.error || '配对失败'; return }
      token = body.token
      localStorage.setItem(TOKEN_KEY, token)
      enterChat()
    } catch (e) {
      $('pairMsg').textContent = '连不上电脑：' + e.message
    } finally {
      $('pairBtn').disabled = false
    }
  }

  // ---- 事件流 ----
  function connectEvents() {
    if (es) es.close()
    es = new EventSource('/api/events?token=' + encodeURIComponent(token))
    es.onmessage = function (ev) {
      var d
      try { d = JSON.parse(ev.data) } catch (e) { return }
      if (d.type === 'auth') showAuth(d.request)
      else if (d.type === 'authExpired') hideAuth()
      else if (d.type === 'status') $('statusLine').textContent = d.text
      else if (d.type === 'tool') addMsg('· ' + (d.label || d.name), 'tool')
      else if (d.type === 'done') {
        hideAuth()
        var t = (d.result && d.result.text) || ''
        if (t) addMsg(t, 'bot')
        setBusy(false)
      } else if (d.type === 'error') {
        hideAuth(); addMsg('出错了：' + d.message, 'bot'); setBusy(false)
      }
    }
    es.onerror = function () {
      $('statusLine').textContent = '连接断开，重连中…'
    }
    es.onopen = function () {
      $('statusLine').textContent = '已连接'
    }
  }

  function enterChat() {
    show('chat')
    connectEvents()
    $('statusLine').textContent = '已连接'
  }

  // ---- 发消息 ----
  function setBusy(v) {
    busy = v
    $('sendBtn').disabled = v
    $('input').disabled = v
    if (!v) $('input').focus()
  }

  async function send() {
    var text = ($('input').value || '').trim()
    if (!text || busy) return
    $('input').value = ''
    addMsg(text, 'me')
    setBusy(true)
    requestId = 'r-' + Date.now()
    try {
      var r = await api('/api/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text, requestId: requestId })
      })
      if (r.status === 401) { logout(); return }
      if (!r.ok) {
        var b = await r.json().catch(function () { return {} })
        addMsg('发不出去：' + (b.error || r.status), 'bot')
        setBusy(false)
      }
    } catch (e) {
      addMsg('连不上电脑：' + e.message, 'bot')
      setBusy(false)
    }
  }

  $('sendBtn').onclick = send
  $('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })

  // ---- 授权卡 ----
  var currentAuth = null

  function showAuth(req) {
    currentAuth = req
    $('authTitle').textContent = req.title || '需要你确认'
    $('authTarget').textContent = req.target || ''
    $('authImpact').textContent = req.impact || ''
    /**
     * 截图：模拟键鼠的卡才有。
     *
     * 在手机上批准「点击 (1240, 460)」这种动作，如果没有画面，
     * 用户批准的是他自己看不见的东西——那里可能是保存，也可能是格式化。
     * 所以图必须显示出来，而且是这次判断的主要依据。
     */
    if (req.screenshot) {
      $('authShot').src = req.screenshot
      $('authShotWrap').classList.remove('hide')
    } else {
      $('authShot').removeAttribute('src')
      $('authShotWrap').classList.add('hide')
    }
    /**
     * 显示卡的时候把输入栏收起来。
     *
     * 原来两者都是 fixed bottom:0，卡片比输入栏高，于是「允许」正好被输入栏盖住——
     * 真机上点不到。卡还挂着的时候本来也不该继续打字：这一轮正等你答复，
     * 再发一句只会插队。收起输入栏既解决遮挡，也让「现在该点卡」这件事更明确。
     */
    $('composerBar').classList.add('hide')
    $('authWrap').classList.remove('hide')
    // 手机上可能没在看屏幕：震一下
    if (navigator.vibrate) navigator.vibrate(200)
  }
  function hideAuth() {
    currentAuth = null
    $('authWrap').classList.add('hide')
    // 只在对话页才把输入栏放回来（配对页本来就不该有它）
    if (!$('chatView').classList.contains('hide')) $('composerBar').classList.remove('hide')
  }

  async function answer(verdict) {
    if (!currentAuth) return
    var id = currentAuth.id
    hideAuth()
    try {
      var r = await api('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authId: id, answer: verdict })
      })
      // 409 = 这张卡已经在电脑上被点过了，不是错误
      if (r.status === 409) addMsg('这张卡已经在电脑上处理过了', 'tool')
      else if (r.status === 401) logout()
    } catch (e) {
      addMsg('答复没送出去：' + e.message, 'bot')
    }
  }
  $('allowBtn').onclick = function () { answer('once') }
  $('denyBtn').onclick = function () { answer('deny') }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    token = ''
    if (es) es.close()
    show('pair')
    $('pairMsg').textContent = '配对该设备已失效，请重新配对'
  }

  // ---- 启动 ----
  ;(async function () {
    if (!token) { show('pair'); return }
    try {
      var r = await api('/api/state')
      if (r.status === 401) { logout(); return }
      enterChat()
    } catch (e) {
      show('pair')
      $('pairMsg').textContent = '连不上电脑：' + e.message
    }
  })()
})()
</script>
</body>
</html>`
