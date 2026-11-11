import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  absolutizeFolderPath,
  isUncPath,
  listFolderCandidates,
  normalizeFolderName,
  shouldSkipDirName
} from './folder'
import { officeText, type OfficeKind } from './office'
import { pdfText, pdfWarningsNote } from './pdf'
import { legacyOfficeText } from './legacy-office'

/**
 * 打开 / 阅读一个具体文件。
 *
 * 和「打开文件夹」分开：那个只开目录，这个才是"把一个文件摆到用户面前"或者
 * "把文件里的字读出来"。两件事的边界完全不同——读操作要防的是"读到不该读的"和
 * "读出一个乱码然后煞有介事地总结"，打开操作要防的是"点一下就执行了"。
 *
 * 三条硬边界：
 * 1. **`open_file` 不执行东西**。外壳接口对 `.exe/.bat/.ps1` 这类文件是"运行"不是"打开"，
 *    所以这些后缀在解析阶段就拒掉，要开程序走 launch_app（那条路有自己的门槛）。
 * 2. **不认 UNC 路径**，理由和打开文件夹一样：连共享目录是一次 SMB 登录，
 *    会把本机凭据交出去，而"看一个文件"用不着付这个代价。
 * 3. **读不了就说读不了**。加密文档、图片、压缩包一律如实拒绝；
 *    PDF 的扫描件、老式 .doc/.xls 里加密的文件也会明说读不出——
 *    绝不吐一段乱码让模型去总结。这条最重要：读错比不读糟得多，
 *    因为错的内容会被当成事实讲给用户。
 */

/** 能读的文件：纯文本 + Office 三类（ZIP）+ PDF（文字层）+ 老式 .doc/.xls（OLE）*/
export type FileKind = 'text' | OfficeKind | 'pdf' | 'doc' | 'xls' | 'unsupported'

const OFFICE_EXT: Record<string, OfficeKind> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx'
}

/**
 * 纯文本按后缀认定，而不是"试着解一下"。后者会把一张 jpg 解成
 * 几十 KB 的替换字符，然后模型拿着它编出"这张图看起来是…"。
 */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.json', '.jsonl', '.csv', '.tsv',
  '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.properties', '.env',
  '.html', '.htm', '.css', '.scss', '.less',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.java', '.kt', '.go', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.lua', '.pl', '.r', '.m',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.gradle', '.dockerfile',
  '.gitignore', '.editorconfig', '.srt', '.ass', '.vtt'
])

/**
 * 这些后缀是"会执行的东西"：可以读（读源码是正常的），但**不能当"打开文件"**。
 * `.ps1/.bat` 双击就是运行；`.lnk/.url` 会顺着它跳到别处；`.msi/.reg` 直接改系统。
 */
const EXECUTABLE_EXT_RE =
  /\.(exe|com|scr|msi|msix|appx|msixbundle|lnk|url|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|reg|jar|application|gadget|scf|inf)$/i

/** 一张 jpg 解出来是几十 MB 的乱码，读之前先把上限摆出来 */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** 一次交给模型的上限。agent.ts 那边整包 JSON 封顶 6000 字符，留足元数据的余量 */
export const DEFAULT_MAX_CHARS = 3200
export const HARD_MAX_CHARS = 4000

/** 按名字找文件时扫哪些地方：只扫用户自己放东西的地方，不扫整块盘 */
const FILE_INDEX_CAP = 3000
const FILE_INDEX_DEPTH = 3
const FILE_INDEX_TTL_MS = 60_000

export function fileKindOf(filePath: string): FileKind {
  const ext = path.extname(filePath).toLowerCase()
  if (OFFICE_EXT[ext]) return OFFICE_EXT[ext]
  if (ext === '.pdf') return 'pdf'
  if (ext === '.doc') return 'doc'
  if (ext === '.xls') return 'xls'
  if (TEXT_EXT.has(ext)) return 'text'
  // 没有后缀的文本（README、Makefile 之类）：common case，按文本试一次
  if (!ext) return 'text'
  return 'unsupported'
}

/** 读不了时给用户的实话：说清是什么格式、为什么读不了、该怎么办 */
export function unsupportedReason(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const name = path.basename(filePath)
  const what =
    ext === '.ppt'
      ? '这是 2003 那种老格式的幻灯片（OLE 二进制），这一版只做得了 .doc 和 .xls'
      : /\.(jpg|jpeg|png|gif|webp|bmp|heic|tiff?|svg)$/i.test(ext)
        ? '这是一张图片，里面没有可以直接读的文字'
        : /\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(ext)
          ? '这是个压缩包，得先解开才知道里面有什么'
          : /\.(mp3|wav|flac|m4a|mp4|mkv|avi|mov|wmv)$/i.test(ext)
            ? '这是音视频文件，里面没有文字'
            : ext === '.exe' || ext === '.dll'
              ? '这是程序文件，不是文档'
              : '这个格式没有可提取的文字'
  return `读不了「${name}」：${what}。能读的是纯文本（txt/md/csv/代码等）、.docx/.xlsx/.pptx、PDF 和老的 .doc/.xls。要看内容我可以帮你用系统默认程序打开它`
}

export type FileReject = { ok: false; reason: string }

/**
 * 校验一个具体路径能不能拿来"打开"或"读"。
 *
 * 只看路径本身：本机绝对路径、真的存在、真的是文件、不是网络路径。
 * 后缀的取舍由调用方决定——读源码是正常的，双击 .ps1 就不是。
 */
export function validateFilePath(target: string): FileReject | { ok: true; path: string } {
  const text = target.trim()
  if (!text) return { ok: false, reason: '没有给出要操作的文件' }
  if (isUncPath(text)) {
    return {
      ok: false,
      reason: `不打开网络路径「${text}」：连共享目录会向对方提交本机的登录凭据，而"看一个文件"用不着付这个代价。要访问网络共享请自己在资源管理器里打开`
    }
  }
  if (!/^[a-zA-Z]:[\\/]/.test(text)) {
    return { ok: false, reason: `「${text}」不是本机绝对路径。只处理本机磁盘上的文件（形如 D:\\资料\\报告.docx）` }
  }
  const resolved = path.resolve(text)
  let stat: Stats
  try {
    stat = statSync(resolved)
  } catch {
    return { ok: false, reason: `这台机器上没有「${text}」这个文件（或当前账号读不到它）` }
  }
  if (stat.isDirectory()) return { ok: false, reason: `「${text}」是个文件夹，不是文件；要打开文件夹用 open_folder` }
  if (!stat.isFile()) return { ok: false, reason: `「${text}」不是普通文件` }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: `「${path.basename(resolved)}」有 ${Math.round(stat.size / 1024 / 1024)}MB，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的上限。太大了，读进来也没法认真看——要不开它自己看看`
    }
  }
  return { ok: true, path: resolved }
}

/** 双击就执行的东西：可以让用户自己开，但不替他去"打开" */
export function isExecutableFile(filePath: string): boolean {
  return EXECUTABLE_EXT_RE.test(filePath)
}

/* ------------------------------------------------------------------ *
 * 按名字找文件
 * ------------------------------------------------------------------ */

export interface FileCandidate {
  name: string
  path: string
  source: 'known' | 'index' | 'given'
}

let fileIndexCache: { at: number; items: FileCandidate[] } | null = null
let fileIndexRootsOverride: string[] | null = null

export function resetFileIndex(): void {
  fileIndexCache = null
}

/** 测试用：把文件索引限制在临时目录里（理由同 folder.ts 的深索引） */
export function setFileIndexRoots(roots: string[] | null): void {
  fileIndexRootsOverride = roots
  fileIndexCache = null
}

/**
 * 按名字找文件扫的地方。
 *
 * 只有用户自己放东西的三个目录 + 桌面上的文件夹。不扫整块盘：
 * 一份 D 盘的文件索引动辄几万个文件，扫一次要好几秒，而用户说
 * 「打开那个报告」时，文件几乎总在这三个地方。
 */
export function defaultFileRoots(): string[] {
  const home = os.homedir()
  const roots = [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents')].filter(
    (dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    }
  )
  return roots
}

function walkForFiles(
  dir: string,
  depth: number,
  maxDepth: number,
  state: { out: FileCandidate[]; files: number; truncated: boolean }
): void {
  if (state.truncated) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.truncated) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // 点开头 / 构建产物 / 系统目录：和文件夹索引同一套跳过规则
      if (shouldSkipDirName(entry.name)) continue
      if (depth + 1 < maxDepth) walkForFiles(full, depth + 1, maxDepth, state)
      continue
    }
    if (!entry.isFile()) continue
    state.files++
    if (state.files > FILE_INDEX_CAP) {
      state.truncated = true
      return
    }
    state.out.push({ name: entry.name, path: full, source: 'index' })
  }
}

export function scanFileIndex(roots: string[] = defaultFileRoots()): FileCandidate[] {
  const state = { out: [] as FileCandidate[], files: 0, truncated: false }
  for (const root of roots) walkForFiles(root, 0, FILE_INDEX_DEPTH, state)
  return state.out
}

function fileIndex(): FileCandidate[] {
  const now = Date.now()
  if (fileIndexCache && now - fileIndexCache.at < FILE_INDEX_TTL_MS) return fileIndexCache.items
  const items = scanFileIndex(fileIndexRootsOverride ?? defaultFileRoots())
  fileIndexCache = { at: now, items }
  return items
}

/* ------------------------------------------------------------------ *
 * 解析：一句话 → 唯一一个文件
 * ------------------------------------------------------------------ */

export type FilePlan =
  | { ok: true; file: FileCandidate }
  | { ok: false; reason: string; candidates?: FileCandidate[] }

/** 带后缀的才当文件名看：用户说「打开报告」时那是文件夹的可能更大 */
const HAS_EXT_RE = /^.+\.(?!\.)[a-z0-9]{1,8}$/i

function matchFiles(query: string, pool: FileCandidate[]): FilePlan | null {
  const key = normalizeFolderName(query)
  const exact = pool.filter((c) => normalizeFolderName(c.name) === key)
  const prefix = pool.filter((c) => normalizeFolderName(c.name).startsWith(key) && !exact.includes(c))
  const loose = pool.filter(
    (c) => normalizeFolderName(c.name).includes(key) && !exact.includes(c) && !prefix.includes(c)
  )
  const tier = exact.length > 0 ? exact : prefix.length > 0 ? prefix : loose
  if (tier.length === 0) return null
  if (tier.length === 1) return { ok: true, file: tier[0] }

  // 同名多个：浅的排前面（用户自己的文件比构建产物更可能是他要的），其余按路径稳定排序
  const ranked = [...tier, ...prefix, ...loose]
    .filter((c, i, arr) => arr.findIndex((x) => x.path.toLowerCase() === c.path.toLowerCase()) === i)
    .sort(
      (a, b) =>
        a.path.split(/[\\/]+/).filter(Boolean).length - b.path.split(/[\\/]+/).filter(Boolean).length ||
        a.name.length - b.name.length ||
        a.path.localeCompare(b.path)
    )
  return { ok: false, reason: `有 ${ranked.length} 个像「${query}」的文件，要哪一个需要用户指定`, candidates: ranked }
}

/**
 * 一句话 → 唯一一个文件。三种说法都认：
 *   1. 完整路径（`D:\资料\报告.docx`）
 *   2. 从认得的目录往下写（`文档\报告.docx`）——复用文件夹那套补全
 *   3. 光一个文件名（`报告.docx`）——在桌面/下载/文档里找
 *
 * 最后一定落到 validateFilePath：真的在、真的是文件，才放行。
 */
export function planFile(query: string, candidates: FileCandidate[] = fileIndex()): FilePlan {
  const text = query.trim()
  if (!text) return { ok: false, reason: '没有给出要操作的文件' }
  if (isUncPath(text)) return { ok: false, reason: unsupportedUnc(text) }

  // 1/2：看起来像路径就走路径，补全的头一段复用文件夹候选（用户可能说「下载\报表.xlsx」）
  if (/^[a-zA-Z]:[\\/]/.test(text) || /[\\/]/.test(text)) {
    const absolute = absolutizeFolderPath(text, listFolderCandidates())
    if (absolute) {
      const checked = validateFilePath(absolute)
      if (!checked.ok) return { ok: false, reason: checked.reason }
      return { ok: true, file: { name: path.basename(checked.path), path: checked.path, source: 'given' } }
    }
    // 补不出来（头一段认不得）：退回用最后一段名字找
  }

  // 3：按名字找。带了后缀才当文件名，免得「打开报告」被理解成找叫"报告"的文件
  const bare = text.split(/[\\/]+/).filter(Boolean).pop() ?? text
  if (!HAS_EXT_RE.test(bare)) {
    return {
      ok: false,
      reason: `「${query}」看起来不是一个文件名（没有后缀）。说清是哪个文件，比如「打开 会议纪要.docx」；如果你要开的是文件夹，用 open_folder`
    }
  }
  const matched = matchFiles(bare, candidates)
  if (!matched) {
    return {
      ok: false,
      reason: `没找到叫「${bare}」的文件。我只在桌面、下载、文档这三处按名字找；别的位置请给完整路径（形如 D:\\资料\\报告.docx），或者从这三个目录往下写（形如 文档\\报告.docx）`
    }
  }
  if (!matched.ok) return matched

  const checked = validateFilePath(matched.file.path)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  return { ok: true, file: { ...matched.file, path: checked.path } }
}

function unsupportedUnc(text: string): string {
  return `不打开网络路径「${text}」：连共享目录会向对方提交本机的登录凭据，而"看一个文件"用不着付这个代价`
}

/* ------------------------------------------------------------------ *
 * 把文件读成字
 * ------------------------------------------------------------------ */

export interface DecodedText {
  text: string
  /** 解出来用的是哪个编码：GBK 的文件读对了要靠它，读错了也要靠它说明原因 */
  encoding: string
}

/**
 * 解码。顺序是有讲究的：
 *   1. BOM 说了算（最确定）
 *   2. 空字节的分布像 UTF-16 就先按 UTF-16 解——**这一步必须在 UTF-8 之前**：
 *      没有 BOM 的 UTF-16 里每个 ASCII 字符后面跟一个 0x00，而 0x00 是合法 UTF-8，
 *      先试 UTF-8 会"成功"解出一串 `a\u0000b\u0000`，然后当成普通文本读下去
 *   3. 再当 UTF-8 严格解一次——失败就说明不是 UTF-8
 *   4. 最后当 GB18030 解（中文 Windows 记事本的老默认编码，覆盖 GBK/GB2312）
 *
 * 为什么 UTF-8 要用 fatal:true：不严格的话 Node 会把坏字节变成 U+FFFD，
 * "看起来解成功了"，于是 GBK 文件全体变成一串问号，而调用方毫不知情。
 */
export function decodeText(buffer: Buffer): DecodedText {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' }
  }
  if (looksUtf16(buffer)) {
    return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le（无 BOM）' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' }
  } catch {
    // 不是合法 UTF-8：中文环境里多半是 GBK
  }
  return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' }
}

/**
 * UTF-16（无 BOM）的签名：空字节几乎全落在同一个奇偶位上。
 *
 * 只看"有没有空字节"是不够的——二进制文件也一堆空字节，而且把它们当 UTF-16
 * 解出来的是一串看着挺像字的东西，比乱码更难被发现。奇偶一致这一条能把它区分开。
 */
function looksUtf16(buffer: Buffer): boolean {
  const n = Math.min(buffer.length, 4096)
  if (n < 16) return false
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i++) {
    if (buffer[i] !== 0) continue
    if (i % 2 === 0) even++
    else odd++
  }
  const nulls = even + odd
  if (nulls / n < 0.25) return false
  // 英文为主的 UTF-16LE：空字节全在奇数位；UTF-16BE：全在偶数位
  return even === 0 || odd === 0
}

/** 解出来一堆控制字符 → 这其实是二进制（比如把 zip 改名成 .txt） */
export function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 4096)
  if (n === 0) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i)
    if (code === 0xfffd) bad += 2
    else if (code < 9 || (code > 13 && code < 32)) bad++
  }
  return bad / n > 0.05
}

export interface FileRead {
  path: string
  name: string
  ext: string
  kind: FileKind
  sizeBytes: number
  encoding: string
  /** 这一次从 offset 开始读到的那一段 */
  text: string
  /** 全文长度（字符数） */
  totalChars: number
  offset: number
  /** 还有下一段就读它的偏移，读完是 null */
  nextOffset: number | null
  modifiedAt: string
}

export type ReadOutcome = { ok: true; read: FileRead } | FileReject

/**
 * 读一段。`offset`/`maxChars` 是为了"读得完"和"读得准"这两件事：
 *
 * 一次性把 20 万字的文件塞给模型，它只会看着前 3000 字编完后半段的结论；
 * 分段读至少能让"读到哪儿了"变成一个说得清的事实。所以这里返回 totalChars
 * 和 nextOffset，调用方（工具）据此在回答里说明"只读了前一部分"。
 */
export function readFileSlice(
  filePath: string,
  options: { offset?: number; maxChars?: number } = {}
): ReadOutcome {
  const checked = validateFilePath(filePath)
  if (!checked.ok) return checked
  const target = checked.path

  const kind = fileKindOf(target)
  if (kind === 'unsupported') return { ok: false, reason: unsupportedReason(target) }

  const maxChars = Math.min(Math.max(Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS), 200), HARD_MAX_CHARS)
  const offset = Math.max(0, Math.floor(options.offset ?? 0))

  let buffer: Buffer
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(target)
    buffer = readFileSync(target)
  } catch (err) {
    return { ok: false, reason: `读不了「${path.basename(target)}」：${err instanceof Error ? err.message : String(err)}` }
  }

  let full: string
  let encoding: string
  if (kind === 'text') {
    const decoded = decodeText(buffer)
    if (looksBinary(decoded.text)) {
      return {
        ok: false,
        reason: `「${path.basename(target)}」的内容不像文字（后缀是文本但内容不是）。读出来只会是乱码，不如打开它自己看`
      }
    }
    full = decoded.text
    encoding = decoded.encoding
  } else if (kind === 'pdf') {
    try {
      const pdf = pdfText(buffer)
      full = pdf.text
      // 缺字、扫描页这些必须跟着结论一起说出去，所以塞进 encoding 这一栏——
      // describeRead 会把它原样念给模型听
      encoding = `PDF 文字层（共 ${pdf.pages} 页${pdfWarningsNote(pdf.warnings)}）`
    } catch (err) {
      return {
        ok: false,
        reason: `读不了「${path.basename(target)}」：${err instanceof Error ? err.message : String(err)}`
      }
    }
  } else if (kind === 'doc' || kind === 'xls') {
    try {
      const legacy = legacyOfficeText(kind, buffer)
      full = legacy.text
      const what = kind === 'doc' ? 'Word 97 格式（OLE 二进制）' : 'Excel 97 格式（OLE 二进制）'
      encoding = `${what}${legacy.warnings.length > 0 ? `；注意：${legacy.warnings.join('；')}` : ''}`
    } catch (err) {
      return {
        ok: false,
        reason: `读不了「${path.basename(target)}」：${err instanceof Error ? err.message : String(err)}`
      }
    }
  } else {
    try {
      full = officeText(kind, buffer)
      encoding = `${kind}（内部 XML）`
    } catch (err) {
      return {
        ok: false,
        reason: `读不了「${path.basename(target)}」：${err instanceof Error ? err.message : String(err)}。要看内容可以让我用系统默认程序打开它`
      }
    }
  }

  const totalChars = full.length
  if (offset >= totalChars && totalChars > 0) {
    return {
      ok: false,
      reason: `offset=${offset} 已经超过「${path.basename(target)}」的总长度（${totalChars} 字），没东西可读了。从 0 开始重读，或者直接回答问题`
    }
  }
  const slice = full.slice(offset, offset + maxChars)
  const next = offset + slice.length
  return {
    ok: true,
    read: {
      path: target,
      name: path.basename(target),
      ext: path.extname(target).toLowerCase(),
      kind,
      sizeBytes: stat.size,
      encoding,
      text: slice,
      totalChars,
      offset,
      nextOffset: next < totalChars ? next : null,
      modifiedAt: stat.mtime.toISOString()
    }
  }
}
