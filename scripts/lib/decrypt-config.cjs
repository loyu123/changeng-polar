/**
 * 在 Electron 里解开 config.json 的凭据，结果从 stdout 交给父进程。**只给命令行脚本用。**
 *
 * 为什么必须是 Electron：凭据是 safeStorage 加密的，Windows 上它的密钥躺在
 * `<userData>\Local State` 里，用当前用户的 DPAPI 包着。纯 Node 进程里没有 safeStorage
 * 这个 API，`node scripts/eval.ts` 无论怎么读都只能拿到 `enc:v1:...` 这串密文。
 *
 * 为什么不能省掉 app.setPath：Electron 默认的 userData 是 %APPDATA%\Electron，
 * 那里面的 Local State 是另一把密钥（或根本不存在），拿它去解 changeng-polar 的密文只会抛
 * "Error while decrypting the ciphertext provided"。踩过这个坑，症状是解密失败但看起来
 * 像凭据坏了。
 *
 * 为什么复制 Local State 而不是直接指到应用目录：应用可能正开着，两边同时读写同一份
 * profile 里的 Chromium 会话文件没有好处。复制到临时目录、用完删掉，应用那边一个字节
 * 都不动。复制的是 DPAPI 密文，不是明文。
 *
 * 输出协议：一行 `__BUTLER_CONFIG__{...}`。用标记而不是"整段 stdout 当 JSON"，
 * 是因为 Electron 在 Windows 上偶尔会往 stdout 掺别的行，掺进来就解析失败了。
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MARKER = '__BUTLER_CONFIG__'
const ENC_PREFIX = 'enc:v1:'

const appUserData = path.join(process.env.APPDATA || app.getPath('appData'), 'changeng-polar')
const configFile = path.join(appUserData, 'config.json')
const sourceState = path.join(appUserData, 'Local State')

// 临时 profile：只带一份 Local State 过去，别的一概不复制
// 临时 profile：只带一份 Local State 过去，别的一概不复制。
// 目录名由父进程给了就用父进程的——删这份副本要在子进程退干净之后做，
// 子进程自己删不掉（Chromium 收尾时会把 Local State 再从内存写一遍）。
const tempRoot = process.env.BUTLER_DECRYPT_TMP || path.join(os.tmpdir(), `butler-decrypt-${process.pid}`)

/**
 * 兜底清扫：父进程每次都删，这里只收拾被 kill / 崩溃打断的那几次。
 *
 * 为什么按时间而不是按 pid 判断死没死：目录名现在是父进程用 mkdtemp 生成的随机后缀，
 * 里面没有 pid。10 分钟足够任何一次解密跑完，比这还老的一定是残留。
 */
function sweepStale() {
  let entries = []
  try {
    entries = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const name of entries) {
    if (!name.startsWith('butler-decrypt-')) continue
    const full = path.join(os.tmpdir(), name)
    if (name === path.basename(tempRoot)) continue
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue
      fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* 删不掉就下次再说 */
    }
  }
}

sweepStale()

// 关掉 GPU：这个进程不画任何东西，开着只会把 ShaderCache 写进临时 profile
app.disableHardwareAcceleration()

let prepared = false
try {
  if (fs.existsSync(sourceState)) {
    fs.mkdirSync(tempRoot, { recursive: true })
    fs.copyFileSync(sourceState, path.join(tempRoot, 'Local State'))
    prepared = true
  }
} catch {
  /* 复制不了就当没有密钥，下面会走"解不开"的分支并如实上报 */
}

app.setPath('userData', tempRoot)

/** 递归把每个 enc:v1: 字符串换成明文；只碰这个前缀，其他值原样带过 */
function unwrap(node, stats) {
  if (typeof node === 'string') {
    if (!node.startsWith(ENC_PREFIX)) return node
    try {
      const plain = safeStorage.decryptString(Buffer.from(node.slice(ENC_PREFIX.length), 'base64'))
      stats.decrypted += 1
      return plain
    } catch {
      // 换了机器 / 换了用户：DPAPI 解不开。**原样返回密文**，不清成空串——
      // 清成空串的话，下游就分不清"本来没配"和"解不开"，会静默跳过缺项提示。
      // 留着 enc:v1: 前缀，下游的 resolveSecret 认得它、会报进 missing。
      stats.failed += 1
      return node
    }
  }
  if (Array.isArray(node)) return node.map((item) => unwrap(item, stats))
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(node)) out[key] = unwrap(value, stats)
    return out
  }
  return node
}

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* 删不掉就留着，里面只有 DPAPI 密文；下次启动 sweepStale 再收 */
  }
}

// 'quit' 比 app.exit() 晚：Chromium 收尾时会再写一遍 Local State，
// 早删的话那份副本会留在 %TEMP% 里
app.on('quit', cleanup)

app.whenReady().then(() => {
  const out = { ok: false, reason: '', config: null, decrypted: 0, failed: 0, keyFile: false }
  const stats = { decrypted: 0, failed: 0 }
  try {
    out.keyFile = prepared && safeStorage.isEncryptionAvailable()
    if (!fs.existsSync(configFile)) {
      out.reason = `找不到 ${configFile}`
    } else {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, ''))
      out.config = unwrap(raw, stats)
      out.decrypted = stats.decrypted
      out.failed = stats.failed
      // 有配置就算成功：解不开的那几个键由父进程按 missing 报出来，
      // 比整次调用失败更好定位
      out.ok = true
      // reason 只说原因、不说数量：数量由父进程和"解开了几个"一起组织成一句话
      if (stats.failed > 0) {
        out.reason = out.keyFile ? '不是这台机器/这个用户加密的' : '没找到可用的 safeStorage 密钥'
      }
    }
  } catch (err) {
    out.reason = err instanceof Error ? err.message : String(err)
  }
  // 回调里再退：直接 app.quit() 有可能把 stdout 截断在管道里
  process.stdout.write(`${MARKER}${JSON.stringify(out)}\n`, () => app.quit())
})
