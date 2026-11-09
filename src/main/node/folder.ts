import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 打开文件夹：在资源管理器里把那个文件夹摆到用户面前。
 *
 * 边界（和「打开程序」是两回事，别混）：
 * - **只开目录**。同一个外壳接口对文件会"打开"（exe 就是执行、docx 就是拉起 Office），
 *   所以这个工具在解析阶段就要求 isDirectory()。用户说"打开文件夹"，不是让我们执行东西
 * - **不认 UNC 路径**（`\\主机\共享`）。连上去就是一次 SMB 登录，会把本机的 NTLM 哈希
 *   连同用户名一起交出去；这是"打开一个文件夹"完全不需要付的代价
 * - 名字对不上唯一一个就列候选，不猜（和打开程序、卸载同一个口径）
 *
 * 为什么用户会觉得"文件夹打不开"：文件夹不在开始菜单里，也不是快捷方式。
 * 桌面上的文件夹是目录，之前只按快捷方式扫，自然找不到。
 *
 * 名字从哪来，分两层：
 *   1. **快层**（每次现算，约 1ms）：桌面/下载/文档/图片/音乐/视频/用户目录这几个系统目录、
 *      桌面上的文件夹、各磁盘根。用户随手新建的文件夹就在这一层，所以它不能缓存
 *   2. **深索引**（首次扫约 200~300ms，之后缓存 60 秒）：盘根往下三层、用户目录往下四层。
 *      没有它，"打开 D 盘里那个 项目"就永远只能靠用户自己敲完整路径
 */

/** 这些后缀说明"这东西不是文件夹"，哪怕它碰巧是个目录也要拒绝 */
const NOT_A_FOLDER_RE = /\.(exe|com|scr|msi|lnk|url|bat|cmd|ps1|vbs|js|jse|wsf|hta|reg|jar)$/i

/**
 * 深索引不要进去的目录。
 *
 * 这些目录下面的东西不是"用户的文件夹"（是构建产物、包缓存、系统组件），
 * 而它们恰恰是最深最多的——真机上光 `node_modules` 一项就能把扫描预算吃光，
 * 让真正的用户目录被挤出索引。
 */
const SKIP_DIR_RE =
  /^(node_modules|windows|winsxs|winstore|appdata|windowsapps|program files|program files \(x86\)|programdata|perflogs|msocache|recovery|installer|system volume information|\$recycle\.bin|\.git|\.svn|\.hg|__pycache__|venv|dist|out|build|target)$/i

/** 一个目录里并排放着好几个这种文件 → 它是程序装出来的目录，不是用户自己建的 */
const PROGRAM_FILE_RE = /\.(exe|dll|pak|asar|node)$/i
const PROGRAM_DIR_MIN_FILES = 3

/**
 * 深索引和文件索引都不进去的目录：小写比对，点开头的一律跳过。
 * 导出是为了让文件那份索引和行为跟目录一致——两处各写一份清单，
 * 迟早会出现"文件夹扫到了、文件没扫到"这种说不清的不一致。
 */
export function shouldSkipDirName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_RE.test(name)
}

/** 深索引的预算是给"会挡住别人"的目录留的：超了宁可截断，也不让一次查询跑几秒 */
const INDEX_MAX_DIRS = 8000
/** 盘根往下三层：`D:\工作\2026\周报` 正好在第三层 */
const DRIVE_DEPTH = 3
/** 用户目录再深一层：`文档\财务\2026\一季度` 也得能找到（它离盘根有五六层） */
const HOME_DEPTH = 4
/** 60 秒。文件夹建得没那么勤，而重建一次要 200 多毫秒 */
const INDEX_TTL_MS = 60_000

export interface FolderCandidate {
  /** 用户在对话里会怎么称呼它 */
  name: string
  path: string
  /** 从哪来的：给人看的定位线索，也决定同名时谁优先 */
  source: 'known' | 'desktop' | 'drive' | 'index' | 'given'
}

/**
 * 系统目录和磁盘根的名字有确定含义，优先级高于深索引里随手起的同名目录。
 * 「打开图片」指的是图片库，不该因为 D 盘深处也有个叫「图片」的文件夹就变成
 * "有 3 个像图片的文件夹，你说是哪个"——那是把系统的确定性丢掉，换来了噪音。
 */
const SYSTEM_SOURCES: ReadonlySet<FolderCandidate['source']> = new Set(['known', 'drive'])

/** 比较用：大小写、空格、连字符、下划线都不该影响"是不是同一个文件夹" */
export function normalizeFolderName(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.·]+/g, '')
}

export function isUncPath(input: string): boolean {
  return /^\\\\/.test(input.trim())
}

/** 像路径（而不是一个名字）：有盘符，或者带路径分隔符 */
export function looksLikeFolderPath(input: string): boolean {
  const text = input.trim()
  return /^[a-zA-Z]:[\\/]/.test(text) || /[\\/]/.test(text)
}

function uncRejectReason(input: string): string {
  return `不打开网络路径「${input.trim()}」：连共享目录会向对方提交本机的登录凭据，而"打开文件夹"用不着付这个代价。要访问网络共享请自己在资源管理器里打开`
}

export type FolderPlan =
  | { ok: true; folder: FolderCandidate }
  | { ok: false; reason: string; candidates?: FolderCandidate[] }

export type FolderReject = { ok: false; reason: string }

/**
 * 校验一个具体路径能不能拿来"打开"。
 *
 * 这里不看"用户是什么意思"，只看"这个路径本身安不安全"：绝对路径、本地盘、
 * 真的存在、真的、是目录。四条全过才放行。
 */
export function validateFolderPath(target: string): FolderReject | { ok: true; path: string } {
  const text = target.trim()
  if (!text) return { ok: false, reason: '没有给出要打开的文件夹' }
  if (isUncPath(text)) return { ok: false, reason: uncRejectReason(text) }
  if (!/^[a-zA-Z]:[\\/]/.test(text)) {
    return { ok: false, reason: `「${text}」不是本机绝对路径。只打开本机磁盘上的文件夹（形如 D:\\资料）` }
  }
  const resolved = path.resolve(text)
  if (NOT_A_FOLDER_RE.test(resolved)) {
    return { ok: false, reason: `不把「${path.basename(resolved)}」当文件夹打开：这类后缀是会执行的东西，走"打开程序"那条路才需要主人确认` }
  }
  let isDir = false
  try {
    isDir = statSync(resolved).isDirectory()
  } catch {
    return { ok: false, reason: `这台机器上没有「${text}」这个文件夹（或当前账号读不到它）` }
  }
  if (!isDir) return { ok: false, reason: `「${text}」是个文件，不是文件夹` }
  return { ok: true, path: resolved }
}

/* ------------------------------------------------------------------ *
 * 深索引
 * ------------------------------------------------------------------ */

let indexCache: { at: number; items: FolderCandidate[] } | null = null
let indexRootsOverride: IndexRoot[] | null = null

/** 测试用：把缓存丢掉，让下一次查询重扫 */
export function resetFolderCache(): void {
  indexCache = null
}

/**
 * 测试用：把深索引限制在临时目录里。
 *
 * 不这么做就只能拿真机去测"深索引有没有收进来"——那样跑在别人机器上会红，
 * 跑在自己机器上会因为某个早就忘了的目录而绿，两种都不是证据。
 */
export function setFolderIndexRoots(roots: IndexRoot[] | null): void {
  indexRootsOverride = roots
  indexCache = null
}

function walkForFolders(
  dir: string,
  depth: number,
  maxDepth: number,
  state: { out: FolderCandidate[]; dirs: number; truncated: boolean }
): void {
  if (state.truncated) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // 权限不够 / 目录刚好被删：跳过，不让一个目录打断整趟扫描
    return
  }
  state.dirs++
  if (state.dirs > INDEX_MAX_DIRS) {
    state.truncated = true
    return
  }

  /**
   * 一个目录里并排放着好几个 exe/dll/pak → 这是某个程序装出来的目录，
   * 它底下的 `app` / `locales` / `resources` 是程序的零件而不是用户的文件夹。
   * 收进来只会稀释索引，还会让"打开 log 文件夹"变成"有 11 个像 log 的文件夹"。
   *
   * 门槛定在 3 个文件而不是 1 个：用户的资料夹里随手扔进一个安装包很常见，
   * 那不能算"这是程序目录"。
   */
  let programFiles = 0
  for (const entry of entries) {
    if (entry.isFile() && PROGRAM_FILE_RE.test(entry.name)) programFiles++
  }
  const isProgramDir = programFiles >= PROGRAM_DIR_MIN_FILES

  /**
   * 程序目录整个不展开：连它的直接子目录也不收。
   * 那些 `app` / `locales` / `resources` / `bin` 用户从来不会开口说"打开它"，
   * 收进来只会把索引撑大、把同名的东西变多。目录本身仍然在清单里
   * （"打开豆包文件夹"还是开得了）。
   */
  if (isProgramDir) return

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (shouldSkipDirName(entry.name)) continue
    if (NOT_A_FOLDER_RE.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    state.out.push({ name: entry.name, path: full, source: 'index' })
    if (depth + 1 < maxDepth) walkForFolders(full, depth + 1, maxDepth, state)
  }
}

export interface IndexRoot {
  dir: string
  /** 从这个目录往下走几层（1 = 只要它的直接子目录） */
  depth: number
}

/**
 * 默认扫哪些地方。
 *
 * C 盘只走两层：Windows / Program Files / AppData 已经排除，剩下的深处基本是
 * 各种软件的缓存目录，扫下去全是噪音还慢。其余盘走三层——用户的资料盘通常
 * 结构很浅（`D:\工作\2026\周报` 就是三层）。
 */
export function defaultIndexRoots(): IndexRoot[] {
  const roots: IndexRoot[] = []
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZAB') {
    const dir = `${letter}:\\`
    if (existsSync(dir)) roots.push({ dir, depth: DRIVE_DEPTH })
  }
  if (existsSync('C:\\')) roots.push({ dir: 'C:\\', depth: 2 })
  roots.push({ dir: os.homedir(), depth: HOME_DEPTH })
  return roots
}

/** 扫一遍给定范围，把"用户可能开口要的文件夹"建个索引 */
export function scanFolderIndex(roots: IndexRoot[] = defaultIndexRoots()): FolderCandidate[] {
  const state = { out: [] as FolderCandidate[], dirs: 0, truncated: false }
  for (const root of roots) walkForFolders(root.dir, 0, root.depth, state)
  return state.out
}

function folderIndex(): FolderCandidate[] {
  const now = Date.now()
  if (indexCache && now - indexCache.at < INDEX_TTL_MS) return indexCache.items
  const items = scanFolderIndex(indexRootsOverride ?? defaultIndexRoots())
  indexCache = { at: now, items }
  return items
}

/* ------------------------------------------------------------------ *
 * 候选集
 * ------------------------------------------------------------------ */

/** 快层：每次现算，用户刚建的文件夹必须立刻能找到 */
function quickCandidates(): FolderCandidate[] {
  const out: FolderCandidate[] = []
  const home = os.homedir()
  const knownDirs: Array<[string, string]> = [
    ['桌面', path.join(home, 'Desktop')],
    ['下载', path.join(home, 'Downloads')],
    ['文档', path.join(home, 'Documents')],
    ['图片', path.join(home, 'Pictures')],
    ['音乐', path.join(home, 'Music')],
    ['视频', path.join(home, 'Videos')],
    ['用户目录', home]
  ]
  for (const [name, dir] of knownDirs) {
    if (existsSync(dir)) out.push({ name, path: dir, source: 'known' })
  }

  // 桌面上的文件夹：用户说的「应用软件」就是桌面上那个目录
  const desktopRoots = [process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '', path.join(home, 'Desktop')].filter(
    Boolean
  )
  for (const root of desktopRoots) {
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (NOT_A_FOLDER_RE.test(entry.name)) continue
      out.push({ name: entry.name, path: path.join(root, entry.name), source: 'desktop' })
    }
  }

  // 磁盘根目录：用户可能说"打开 D 盘"，也可能说"D盘\工作"
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    const root = `${letter}:\\`
    if (existsSync(root)) out.push({ name: `${letter} 盘`, path: root, source: 'drive' })
  }
  return out
}

/**
 * 能"按名字"打开的文件夹全集 = 快层 + 深索引。
 *
 * **只按路径去重，不按名字去重**。深索引一上线，同名的目录遍地都是
 * （`D:\log` 和 `D:\baoleiji\Bastion\log` 都叫 log）——按名字去重等于
 * 替用户挑了一个，而他完全无从知道挑的是哪个。按名字挑的唯一命中才算数，
 * 是这套工具一以贯之的口径；同名多了就报歧义，让他补一截路径。
 *
 * 快层排在前面：同名但不在系统目录里的时候，先列出来的更贴身。
 */
export function listFolderCandidates(): FolderCandidate[] {
  const seenPaths = new Set<string>()
  const out: FolderCandidate[] = []
  for (const item of [...quickCandidates(), ...folderIndex()]) {
    const key = normalizeFolderName(item.name)
    if (!key) continue
    const byPath = item.path.toLowerCase()
    if (seenPaths.has(byPath)) continue
    seenPaths.add(byPath)
    out.push(item)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 名字 → 唯一一个文件夹
 * ------------------------------------------------------------------ */

export type FolderMatch =
  | { ok: true; folder: FolderCandidate }
  | { ok: false; reason: string; candidates?: FolderCandidate[] }

function ambiguousReason(query: string, pool: FolderCandidate[]): string {
  // 同名的一堆（真机上 `log`、`locales` 这种遍地都是）光念名字等于没说：
  // 用户看到的是"有 3 个像 log 的文件夹：log、log、log"。同名的补上路径
  const nameCounts = new Map<string, number>()
  for (const c of pool) {
    const key = normalizeFolderName(c.name)
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
  }
  const label = (c: FolderCandidate): string =>
    (nameCounts.get(normalizeFolderName(c.name)) ?? 0) > 1 ? `${c.name}（${c.path}）` : c.name
  const shown = pool.slice(0, 6).map(label).join('、')
  return `有 ${pool.length} 个像「${query}」的文件夹：${shown}。要打开哪一个，需要用户指定`
}

/** 路径有多深（按分隔符数）：用来把用户自己的目录排在程序零件目录前面 */
function pathDepth(p: string): number {
  return p.split(/[\\/]+/).filter(Boolean).length
}

/**
 * 名字匹配的阶梯：完全相同 > 前缀 > 包含。
 *
 * **唯一命中就到此为止**——这一级只认唯一命中，所以"名字完全相同的那个"永远优先，
 * 不会因为旁边还有个「文件备份」就变成要用户挑。
 *
 * **一级里命中多个时，把后几级也一并列出来**：用户说「kcareone」时，机器上有两个
 * 埋在 `D:\KCareOne-ALL\KCareOne-MAIN\kcareone` 这种深处、恰好就叫 kcareone 的目录，
 * 而他要的多半是`D:\KCareOne-ALL`——只报"完全相同"那一级，卡片上就只剩那两个他
 * 根本没听说过的目录。反正最后是用户在卡片上点，多给几个选项比给错了强。
 */
function matchInPool(key: string, query: string, pool: FolderCandidate[]): FolderMatch | null {
  const exact = pool.filter((c) => normalizeFolderName(c.name) === key)
  const prefix = pool.filter((c) => normalizeFolderName(c.name).startsWith(key))
  const loose = pool.filter((c) => normalizeFolderName(c.name).includes(key))
  const tier = exact.length > 0 ? exact : prefix.length > 0 ? prefix : loose
  if (tier.length === 0) return null
  if (tier.length === 1) return { ok: true, folder: tier[0] }

  /**
   * 候选卡上的顺序是有含义的：越靠前越像用户说的那个。
   * 先按深浅——用户的目录在浅层，软件装出来的零件目录在深处；再按名字长短
   * （「kcareone」→ KCareOne-ALL 该在 KCareOne-ALL-frontend-v2 之前）；
   * 最后按路径。排序必须稳定，否则同一句话两次调出来的卡片顺序都不一样。
   */
  const seen = new Set<string>()
  const ranked = [...tier, ...prefix, ...loose]
    .filter((c) => {
      const k = c.path.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort(
      (a, b) =>
        pathDepth(a.path) - pathDepth(b.path) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path)
    )
  return { ok: false, reason: ambiguousReason(query, ranked), candidates: ranked }
}

function notFoundReason(query: string): string {
  return `没找到叫「${query}」的文件夹。我认得的是：桌面、下载、文档、图片、音乐、视频、各磁盘根目录，桌面上的文件夹，以及各盘往下三层、用户目录往下四层的目录。要开别的地方，直接给完整路径（形如 D:\\资料\\项目），或者从认得的目录往下写一级（形如 文档\\报告）`
}

/**
 * 只做"这个名字指哪一个"的判断，不碰磁盘。
 *
 * 和下面的 planFolder 拆开是因为两件事该分别验：名字匹配的阶梯（完全相同 > 前缀 > 包含，
 * 每级只认唯一命中）是纯逻辑；"这个路径现在还在不在、是不是目录"是事实。
 * 混在一起就只能拿真目录去测名字逻辑，等于没法测。
 */
export function matchFolder(query: string, candidates: FolderCandidate[]): FolderMatch {
  const key = normalizeFolderName(query)
  if (!key) return { ok: false, reason: '没有给出要打开的文件夹' }

  const system = candidates.filter((c) => SYSTEM_SOURCES.has(c.source))
  const rest = candidates.filter((c) => !SYSTEM_SOURCES.has(c.source))
  return matchInPool(key, query, system) ?? matchInPool(key, query, rest) ?? { ok: false, reason: notFoundReason(query) }
}

/**
 * 把"从认得的目录往下写一级"的写法补成绝对路径：`文档\报告` → `C:\Users\x\Documents\报告`。
 *
 * 解不出来（头一段既不是盘符也不是认得的目录）就返回空串，让调用方退回按名字找最后一段——
 * 用户说「工作\周报」时，头一段"工作"可能是有歧义的，末段"周报"反而能唯一定位。
 */
export function absolutizeFolderPath(input: string, candidates: FolderCandidate[]): string {
  const text = input.trim()
  if (/^[a-zA-Z]:[\\/]/.test(text)) return path.resolve(text)
  // 「D:」在 Windows 里严格说指"D 盘的当前目录"，但用户嘴里它就是 D 盘
  if (/^[a-zA-Z]:$/.test(text)) return `${text.toUpperCase()}\\`

  const parts = text.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2) return ''
  const [head, ...rest] = parts
  const matched = matchFolder(head, candidates)
  if (!matched.ok) return ''
  return path.join(matched.folder.path, ...rest)
}

/**
 * 解析出**唯一**要打开的文件夹。
 *
 * 三种说法都认：完整路径（`D:\资料`）、从认得的目录往下写（`文档\报告`）、
 * 光一个名字（`周报`，交给 matchFolder 在快层和深索引里找）。
 * 无论走哪条，最后都落到 validateFolderPath：真的在、真的是目录，才放行。
 */
export function planFolder(
  query: string,
  candidates: FolderCandidate[] = listFolderCandidates()
): FolderPlan {
  const text = query.trim()
  if (!text) return { ok: false, reason: '没有给出要打开的文件夹' }
  if (isUncPath(text)) return { ok: false, reason: uncRejectReason(text) }

  if (looksLikeFolderPath(text) || /^[a-zA-Z]:$/.test(text)) {
    const absolute = absolutizeFolderPath(text, candidates)
    if (absolute) {
      const checked = validateFolderPath(absolute)
      if (!checked.ok) return { ok: false, reason: checked.reason }
      return {
        ok: true,
        folder: { name: path.basename(checked.path) || checked.path, path: checked.path, source: 'given' }
      }
    }
    // 补不成绝对路径：退回按名字找最后一段
  }

  const bare = text.split(/[\\/]+/).filter(Boolean).pop() ?? text
  const matched = matchFolder(bare, candidates)
  // 歧义要把候选原样带上去：上层据此做成可点的候选卡，让用户自己挑
  if (!matched.ok) return { ok: false, reason: matched.reason, candidates: matched.candidates }

  const checked = validateFolderPath(matched.folder.path)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  return { ok: true, folder: { ...matched.folder, path: checked.path } }
}
