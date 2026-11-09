import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * 安装：只走 winget（Windows 官方包管理器）。
 *
 * 边界（改之前先看这几条）：
 * - 来源固定 winget 官方仓库：包经过微软审核、哈希由 winget 校验，
 *   不做"抓官网直链下载 exe"——那条路等于执行任意下载物
 * - **一律拉起软件自己的安装向导**（`--interactive`），不替用户静默安装。
 *   安装位置、桌面快捷方式、开机自启都在那个向导里由用户自己定；
 *   我们不拼各厂商的安装器开关，也不假装知道它支持哪个参数
 * - 不留安装包：winget 下到 `%TEMP%\WinGet\` 校验后调用，用完自己清掉
 * - 安装是改动机器的动作：工具层标 install 档，必须过授权卡
 */

/**
 * 超时。交互式安装要长得多：用户要点完安装器、可能还要选路径、看许可协议。
 *
 * 这个数字不是"性能参数"，是"什么时候替用户把它正在做的事掐掉"。
 * 静默安装那种没有人在操作、纯粹防卡死的 10 分钟在这里完全不合适——
 * 掐早了等于把安装器从用户手里抢走。
 */
const WINGET_INSTALL_TIMEOUT_MS = 30 * 60 * 1000
const SEARCH_TIMEOUT_MS = 45 * 1000

export interface WingetPackage {
  id: string
  name: string
  version: string
  /**
   * winget 标出的"匹配在哪"：`Tag: kimi` / `Command: kimi` / `Moniker: xxx`，名称命中时为空。
   *
   * 必须留着：搜 kimi 会返回 10 条，其中只有 3 条名字里有 kimi，其余是别人在清单里
   * 打了 kimi 标签（Chatbox、LM Studio……）。按名字排在前、标签排在后，
   * 候选卡才不会把用户真要的那个挤到看不见的地方。
   */
  match?: string
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
/**
 * 单空格分隔的"超宽行"。
 *
 * winget 的表格是按列宽补空格的，但**「名称」超出列宽时它不补**，name 与 Id 之间
 * 只剩一个空格，于是一个整行被 `split(/\s{2,}/)` 切成 1 段、`cols.length < 3` 丢掉。
 *
 * 真机症状（2026-11-09，装哔哩哔哩来回两轮装不上）：
 *   winget search --id Bilibili.Bilibili --exact
 *   哔哩哔哩 Bilibili.Bilibili 1.20.0        ← 全是单空格
 * 解析出 0 条 → 报"仓库里没有找到「Bilibili.Bilibili」"→ 模型改用中文名重试
 * → 又是多条匹配 → 再被拒 → 死循环。
 *
 * 靠空格宽度切列本身不可靠（同一份输出里多空格行和单空格行并存），所以这里改用
 * **Id 的形态**定位：Id 是 ASCII 且形如 `Publisher.Package`（含点），把它当锚点切开。
 * name 用 lazy 匹配，这样 name 里带空格（`Microsoft .NET Host …`）也能切对。
 *
 * 那个 `(?=…[A-Za-z])` 是必须的：名称里经常带版本号（`Microsoft .NET Host - 7.0.20 (x64)`），
 * 而 `7.0.20` 同样满足「数字+点+数字」的形态，会把 name 截断在版本号前。
 * 真 Id 的发布者段几乎总含字母（`7zip.7zip`、`davidchiu66.TubeUltimatePlayer` 都算），
 * 纯数字的点分串则只可能是版本号。
 */
const WIDE_ROW_RE =
  /^(.+?)\s+(?=[A-Za-z0-9._+-]*[A-Za-z])([A-Za-z0-9][A-Za-z0-9._+-]*\.[A-Za-z0-9][A-Za-z0-9._+-]*)\s+(\S+)(?:\s+(.*))?$/

/** 从一行里切出 name / id / version（+匹配列）；切不出返回 null */
function parseRow(line: string): WingetPackage | null {
  // 先走正常的"多空格对齐"路径——绝大多数行是这种
  const cols = line.split(/\s{2,}/)
  if (cols.length >= 3) {
    const [name, id, rawVersion, rawMatch] = cols
    // 版本列可能与「匹配」列粘连（单空格分隔），只取开头的版本号本体
    const version = rawVersion.match(/^[0-9][A-Za-z0-9.+]*/)?.[0] ?? rawVersion
    // Id 是 winget 的包标识（ASCII，形如 Publisher.Package），靠它排除误切
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id.includes('.') && name && version) {
      return { name, id, version, match: rawMatch?.trim() || undefined }
    }
  }
  // 兜底：名称超宽导致整行单空格，用 Id 形态当锚点
  const m = WIDE_ROW_RE.exec(line)
  if (!m) return null
  const [, name, id, version, match] = m
  return { name: name.trim(), id, version, match: match?.trim() || undefined }
}

export function parseWingetTable(text: string): WingetPackage[] {
  const lines = text.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => /^(Name|名称)\s+(Id|ID)\s+(Version|版本)/i.test(l))
  if (headerIdx < 0) return []
  const pkgs: WingetPackage[] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || /^-+$/.test(line)) continue
    const pkg = parseRow(line)
    if (pkg) pkgs.push(pkg)
  }
  return pkgs
}

/** winget 明确表示"仓库里没有这个东西"（不同版本/语言不同） */
const NO_SUCH_PACKAGE_RE =
  /找不到与输入条件匹配|找不到与输入条件相符|No package found matching input criteria/i

/**
 * 退出码 20 = APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND。
 *
 * 这个码必须当成"0 条结果"而不是"检索失败"：用户报的名字口语化（bibib、阿B）
 * 时 winget 只会字面匹配，必然走到这里。报成 `winget search 失败：退出码 20`
 * 的话，模型看到的是"检索出错了"，于是重试同一个词——真机上就是这么转两轮
 * 之后放弃的。说成"仓库里没有这个词"，它才会去换成官方名称再搜。
 */
const NO_APPLICATIONS_FOUND = 20

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
    if (r.code === NO_APPLICATIONS_FOUND || NO_SUCH_PACKAGE_RE.test(r.output)) return []
    throw new Error(r.missing ? '这台机器上没有 winget（需要 Windows 包管理器）' : `winget search 失败：${wingetFailText(r.code)}`)
  }
  return parseWingetTable(r.output)
}

/**
 * 比名字之前先把标点归一：`7-Zip` 与用户敲的 `7zip` 是同一个东西，
 * 但按原字符串比，"7-zip" 既不以 "7zip" 开头也不含它，于是真正的 7-Zip
 * 排在 Dark7zip、Py7Zip 后面——候选卡第一条指向别人，正是最糟的排法。
 */
function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.·]+/g, '')
}

/**
 * Id 里的某一段是不是以检索词开头。
 *
 * 不能对 Id 直接做子串匹配：`XINGInc.AkasakiMinato` 的 "akasak**imi**nato"
 * 里就藏着 kimi，会把「赤咲 湊」这种毫不相干的包塞进候选卡（真机踩到过）。
 * Id 是 `Publisher.Package`，按点/连字符分段后逐段比前缀，误伤面小得多。
 */
function idSegmentMatches(id: string, q: string): boolean {
  return id
    .toLowerCase()
    .split(/[.\-_]/)
    .some((seg) => seg.startsWith(q))
}

/**
 * 候选排序：不改变"有哪些候选"，只决定先给用户看哪几个。
 *
 * winget 的输出大致按相关度排，但同名包和"只是在清单里打了这个标签"的包混在一起。
 * 搜 kimi 前排是 Kimi / Kimi CLI / Kimi Code CLI，后面是 ChatALL、
 * LM Studio 这类标签命中——直接截前 8 条，用户真正要的那个还在，但噪声把卡塞满了。
 *
 * 排序：名称相同 > 名称以它开头 > 名称含它 > Id 段以它开头 > 只靠标签/命令命中。
 * 同分保持 winget 原序（sort 是稳定的），因为它的顺序里有我们算不出来的相关度信号。
 */
export function rankCandidates(pkgs: WingetPackage[], query: string): WingetPackage[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...pkgs]
  const nq = normalizeName(q)
  const score = (p: WingetPackage): number => {
    const name = p.name.toLowerCase()
    const nn = normalizeName(p.name)
    if (nn === nq) return 0
    if (nn.startsWith(nq)) return 1
    if (name.includes(q) || nn.includes(nq)) return 2
    if (p.id.toLowerCase() === q) return 3
    if (idSegmentMatches(p.id, q)) return 4
    return 5
  }
  return [...pkgs].sort((a, b) => score(a) - score(b))
}

/**
 * 这个包是"名字像"还是"只是打了标签"。
 *
 * 名字命中是硬信号：名字里带检索词，用户看到名字就能确认是不是它。
 * Tag/Command/Moniker 命中是软信号——Chatbox 的清单里打了 kimi 标签，
 * 但它不是 Kimi 客户端。候选卡上有名字命中的时候，软信号那些就不该占位置。
 */
export function matchedByName(pkg: WingetPackage, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return pkg.name.toLowerCase().includes(q) || normalizeName(pkg.name).includes(normalizeName(q)) || idSegmentMatches(pkg.id, q)
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
  /** 用户在安装器里点了取消（不是失败，别当成错误念给用户） */
  cancelled?: boolean
  /**
   * 机器上本来就有、winget 什么都没装（没有可升级版本时它会直接放弃安装）。
   *
   * 这一栏必须和 ok:true 分开：以前这里返回 ok:true，上层就照"装完了"的流程走一遍
   * 装后核对，核对当然通过（它本来就在），于是对用户宣布「已安装成功」——
   * 而这一轮实际上一个字节都没装。报成功比报失败更糟，用户会以为刚装上了新版本。
   */
  alreadyInstalled?: boolean
}

/** winget / 各厂商安装器表示"用户取消"的措辞 */
const CANCELLED_RE =
  /已取消|cancelled|canceled|用户取消|安装被取消|The installer was cancelled|Installation abandoned/i

/**
 * 安装指定 Id；等待用户在安装器里点完（可能几十分钟），失败带输出尾部。
 *
 * **一律交互式**：winget 会原样拉起厂商安装器，用户看得见界面、可以改安装位置、
 * 可以取消掉默认勾选。这里曾经有一个 `--silent` 模式，已经删掉了——
 * 那等于让用户批准一张"全程看不见"的卡，安装器默认勾上的东西全都会生效，
 * 连装到哪个盘都替他决定了，而他批准时一个字都没看到。
 *
 * `--location` 没有一起用：那个参数只对清单里声明支持自定义路径的包（便携版、MSIX）生效，
 * 对 NSIS 这类"厂商安装器自己画界面"的包传了也没用，反而给人"我指定了路径"的错觉。
 * 走交互式让安装器自己问，比我们猜它支不支持可靠。
 */
export async function installWinget(id: string, signal?: AbortSignal): Promise<InstallOutcome> {
  assertPackageId(id)
  const r = await runWinget(
    [
      'install',
      '--id',
      id,
      '--exact',
      // 不传 --silent：安装器照常弹窗，位置与勾选由用户自己定
      '--interactive',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
      // 这个必须留：它管的是 winget 自己的交互询问（是否同意源协议等），
      // 不是安装器的界面。去掉它会在命令行里等一个看不见的 y/n。
      '--disable-interactivity'
    ],
    WINGET_INSTALL_TIMEOUT_MS,
    signal
  )
  // 台账登记：从输出里抓安装包的真实下载地址（"正在下载 https://..."）
  const urlMatch = r.output.match(/https?:\/\/[^\s"]+\.(?:exe|msi|msix|appinstaller|zip)/i)
  const sourceUrl = urlMatch?.[0]
  const tail = r.output.trim().split(/\r?\n/).slice(-6).join(' / ').slice(0, 400)
  if (r.code === -2) return { ok: false, cancelled: true, detail: '安装被中止（用户停止）' }
  if (r.code === -1) {
    return { ok: false, detail: '安装器开了 30 分钟还没结束，已终止；可以稍后在「设置 → 应用」里确认装到哪一步' }
  }
  // "找到已安装的现有包 / 找不到可用的升级" = 目标本来就已经装着（0x8A15002B 真机踩过）。
  // 这不是成功：装前查重是主路（tools.ts 的 plan 会先查一遍），但查重和这条之间
  // 有窗口（清单缓存、用户自己刚装过），所以这里必须再兜一次，且不能算"装好了"
  if (r.code !== 0 && /找到已安装的现有包|no applicable upgrade|没有可用的较新/.test(r.output)) {
    return { ok: false, alreadyInstalled: true, detail: '这台机器上本来就有这个软件，winget 没有执行安装', sourceUrl }
  }
  /**
   * 交互式安装里"用户点了取消"很常见，而 winget 只给一个失败退出码。
   * 不区分的话，模型会把用户自己的取消当成"安装失败"念给他听。
   */
  if (r.code !== 0 && CANCELLED_RE.test(r.output)) {
    return { ok: false, cancelled: true, detail: '你在安装器里取消了安装，什么都没有装上', sourceUrl }
  }
  if (r.code !== 0) return { ok: false, detail: `winget 安装失败：${wingetFailText(r.code)} · ${tail}` }
  return { ok: true, detail: tail || 'winget 报告安装成功', sourceUrl }
}

/**
 * 装完核对：winget 自己说成功不算数。
 *
 * 为什么必须单独查一遍：`--interactive` 拉起的是厂商安装器，网易云这类是外壳程序，
 * 外壳退出码与"真的装上了"不一定一致；网络断了、UAC 被拒、用户中途关掉安装器，
 * winget 都可能报成功。台账上写"已安装"而机器上什么都没有，比装不上更糟。
 */
const LIST_TIMEOUT_MS = 60_000

/** winget 明确表示"没装"的措辞（不同版本/语言不同） */
const NOT_INSTALLED_RE =
  /找不到与输入条件匹配|找不到与输入条件相符|No installed package found|No package found matching input criteria/i

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface InstalledCheck {
  found: boolean
  /** winget 报的显示名（注册表 DisplayName 通常与它一致，但不是保证） */
  name?: string
  version?: string
  detail: string
}

/**
 * 从 winget list 的输出里取「显示名 / 版本」。
 *
 * 不能复用 parseWingetTable：那个按 2+ 空格切列，对 search 的输出成立，
 * 而 list 在名称超过列宽时列间只剩**一个**空格（真机实测整行是
 * `7-Zip 26.05 (x64) 7zip.7zip 26.05 26.06 winget`），按 2+ 空格一条都切不出来。
 * 改成"按已知的 Id 反切"：Id 左边是显示名，右边第一个词是版本——
 * 与列宽、语言、对齐方式都无关。
 */
export function parseListedRow(text: string, id: string): { name: string; version: string } | null {
  const needle = id.toLowerCase()
  const isIdChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9._+-]/.test(ch)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // 表头、分隔线都不是数据行
    if (!line || /^(名称|Name)\s+/i.test(line) || /^-+$/.test(line)) continue
    const lower = line.toLowerCase()
    const at = lower.indexOf(needle)
    if (at < 0) continue
    // Id 必须自成一段，否则 NetEase.CloudMusic 会命中 NetEase.CloudMusic.Beta 那一行
    if (isIdChar(lower[at - 1]) || isIdChar(lower[at + needle.length])) continue
    const name = line.slice(0, at).trim()
    if (!name) continue
    const version = line.slice(at + id.length).trim().split(/\s+/)[0] ?? ''
    return { name, version }
  }
  return null
}

export async function checkInstalled(id: string, signal?: AbortSignal): Promise<InstalledCheck> {
  assertPackageId(id)
  const r = await runWinget(
    ['list', '--id', id, '--exact', '--accept-source-agreements', '--disable-interactivity'],
    LIST_TIMEOUT_MS,
    signal
  )
  if (r.missing) return { found: false, detail: '这台机器上没有 winget，无法核对安装结果' }
  if (r.code === -2) return { found: false, detail: '核对被中止（用户停止）' }
  if (r.code === -1) return { found: false, detail: 'winget list 超过 60 秒没有返回，未能核对' }

  const row = parseListedRow(r.output, id)
  if (row) {
    return {
      found: true,
      name: row.name,
      version: row.version,
      detail: `winget list 列出 ${id} ${row.version}`.trim()
    }
  }
  if (NOT_INSTALLED_RE.test(r.output)) return { found: false, detail: 'winget list 报告没有匹配的已安装程序' }
  // 输出格式将来变了也别误报"没装"：整份输出里逐字出现这个 Id 就算查到
  if (new RegExp(escapeRe(id), 'i').test(r.output)) {
    return { found: true, detail: `winget list 输出里出现了 ${id}` }
  }
  return { found: false, detail: `winget list 没有返回 ${id}（退出码 ${r.code}）` }
}
