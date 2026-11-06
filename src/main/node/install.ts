import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * 安装：只走 winget（Windows 官方包管理器）。
 *
 * 边界（改之前先看这几条）：
 * - 来源固定 winget 官方仓库：包经过微软审核、哈希由 winget 校验，
 *   不做"抓官网直链下载 exe"——那条路等于执行任意下载物
 * - 静默安装用 winget 统一参数，不自己拼各厂商的安装器开关
 * - 不留安装包：下载与缓存由 winget 管理，桌面与下载目录不会出现 exe
 * - 安装是改动机器的动作：工具层标 install 档，必须过授权卡
 */

const WINGET_TIMEOUT_MS = 10 * 60 * 1000
const SEARCH_TIMEOUT_MS = 45 * 1000

export interface WingetPackage {
  id: string
  name: string
  version: string
}

interface RunResult {
  code: number | null
  output: string
  missing: boolean
}

/**
 * winget 是 App Execution Alias，PATH 上的是 WindowsApps 里的重解析点；
 * 少数机器上 execFile 解析不到它，退回这个绝对路径再试一次。
 */
function wingetCandidates(): string[] {
  const local = process.env.LOCALAPPDATA
  return local ? ['winget.exe', path.join(local, 'Microsoft', 'WindowsApps', 'winget.exe')] : ['winget.exe']
}

/**
 * 执行一次 winget：**参数走数组，绝不经 shell**。
 *
 * 这里曾经是 `spawn('winget ' + argline, { shell: true })`。argline 里拼过模型生成的
 * 软件名，而 JSON.stringify 只把 `"` 转成 `\"`——cmd.exe 不认反斜杠转义，引号直接闭合，
 * `%VAR%` 在引号内也照常展开，于是「恶意网页 → 模型生成软件名 → 任意命令」这条链是通的。
 * execFile 直接 CreateProcess，参数是独立 argv，不存在拼接解析这一步。
 */
function runWingetOnce(
  exe: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const child = execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`
        if (!err) return finish({ code: 0, output, missing: false })
        // execFile 的 timeout 走的是 SIGTERM：记成 -1，与"进程异常退出"区分开
        if ((err as { killed?: boolean }).killed) return finish({ code: -1, output, missing: false })
        const code = err.code
        if (typeof code === 'string') {
          // ENOENT = 找不到 winget 本体；其余（EACCES 等）按普通失败处理
          return finish({ code: null, output: output || err.message, missing: code === 'ENOENT' })
        }
        finish({ code: typeof code === 'number' ? code : null, output: output || err.message, missing: false })
      }
    )
    const onAbort = (): void => {
      child.kill()
      finish({ code: -2, output: '', missing: false })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function runWinget(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  let last: RunResult = { code: null, output: '', missing: true }
  for (const exe of wingetCandidates()) {
    const result = await runWingetOnce(exe, args, timeoutMs, signal)
    if (!result.missing) return result
    last = result
  }
  return last
}

export async function wingetAvailable(signal?: AbortSignal): Promise<boolean> {
  const r = await runWinget(['--version'], 15_000, signal)
  return r.code === 0 && !r.missing
}


/** 把 winget 的退出码翻译成人话（真机踩过的码优先） */
function wingetFailText(code: number | null): string {
  if (code === null) return 'winget 进程异常退出'
  if (code === 2316632087) return 'winget 源连接失败（0x8A150017，多为网络或商店源问题）——检查网络后重试'
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`
  if ((code >>> 0) >= 0x8a150000 && (code >>> 0) <= 0x8a15ffff) {
    return `winget 源/安装器错误（${hex}）——多为网络或源配置问题，检查网络后重试`
  }
  return `winget 退出码 ${code}（${hex}）`
}

/**
 * 解析 winget search 的对齐文本表。
 * 不能按表头字符位置切列：中文系统表头是「名称 ID 版本」，而中文名（如
 * "网易云音乐"）显示宽度是字符数的两倍，位置切片必然错位（真机踩过，
 * 症状是检索有结果却永远匹配不到精确 Id）。改按 2+ 空格分列：
 * 行结构固定为「名称  Id  版本 [匹配]」，名称里的单空格不影响。
 */
export function parseWingetTable(text: string): WingetPackage[] {
  const lines = text.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => /^(Name|名称)\s+(Id|ID)\s+(Version|版本)/i.test(l))
  if (headerIdx < 0) return []
  const pkgs: WingetPackage[] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || /^-+$/.test(line)) continue
    const cols = line.split(/\s{2,}/)
    if (cols.length < 3) continue
    const [name, id, rawVersion] = cols
    // 版本列可能与「匹配」列粘连（单空格分隔），只取开头的版本号本体
    const version = rawVersion.match(/^[0-9][A-Za-z0-9.+]*/)?.[0] ?? rawVersion
    // Id 是 winget 的包标识（ASCII，形如 Publisher.Package），靠它排除误切
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !id.includes('.')) continue
    if (!name || !version) continue
    pkgs.push({ name, id, version })
  }
  return pkgs
}

/**
 * 按关键词搜 winget 仓库；返回原始列表，选择交给调用方。
 * 必须带 --source winget：默认还会查 msstore 商店源，那个源经常因
 * 区域/登录问题整个检索报错（真机 0x8A150017 踩过），社区仓库才是我们要的。
 */
export async function searchWinget(query: string, signal?: AbortSignal): Promise<WingetPackage[]> {
  // 检索词来自模型，可能是任意文本：换行/控制字符会让 winget 的表格输出错位
  const cleaned = query.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!cleaned) throw new Error('检索词为空')
  const r = await runWinget(
    ['search', cleaned, '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'],
    SEARCH_TIMEOUT_MS,
    signal
  )
  if (r.code !== 0) {
    throw new Error(r.missing ? '这台机器上没有 winget（需要 Windows 包管理器）' : `winget search 失败：${wingetFailText(r.code)}`)
  }
  return parseWingetTable(r.output)
}

/** winget 的包 Id 是 ASCII 标识（Publisher.Package）：出现别的字符一律不发出去 */
function assertPackageId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(id)) {
    throw new Error(`包 Id 含非法字符，已拒绝：${id.slice(0, 60)}`)
  }
}

export interface InstallOutcome {
  ok: boolean
  detail: string
  /** 安装包的实际下载地址（从 winget 输出里抓，台账登记用） */
  sourceUrl?: string
}

/** 静默安装指定 Id；等待 winget 退出（可能几分钟），失败带输出尾部 */
export async function installWinget(id: string, signal?: AbortSignal): Promise<InstallOutcome> {
  assertPackageId(id)
  const r = await runWinget(
    [
      'install',
      '--id',
      id,
      '--exact',
      '--silent',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity'
    ],
    WINGET_TIMEOUT_MS,
    signal
  )
  // 台账登记：从输出里抓安装包的真实下载地址（"正在下载 https://..."）
  const urlMatch = r.output.match(/https?:\/\/[^\s"]+\.(?:exe|msi|msix|appinstaller|zip)/i)
  const sourceUrl = urlMatch?.[0]
  const tail = r.output.trim().split(/\r?\n/).slice(-6).join(' / ').slice(0, 400)
  if (r.code === -2) return { ok: false, detail: '安装被中止（用户停止或超时）' }
  if (r.code === -1) return { ok: false, detail: 'winget 超过 10 分钟没有结束，已终止；可以稍后在「设置 → 应用」里确认装到哪一步' }
  // "找到已安装的现有包 / 找不到可用的升级" = 目标本来就已经装着（0x8A15002B 真机踩过）
  if (r.code !== 0 && /找到已安装的现有包|no applicable upgrade|没有可用的较新/.test(r.output)) {
    return { ok: true, detail: '该软件已经安装（winget 确认无可用升级）', sourceUrl }
  }
  if (r.code !== 0) return { ok: false, detail: `winget 安装失败：${wingetFailText(r.code)} · ${tail}` }
  return { ok: true, detail: tail || 'winget 报告安装成功', sourceUrl }
}
