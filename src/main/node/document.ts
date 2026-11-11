import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildDocx } from './docx'
import { buildPptx } from './pptx'

/**
 * 把一段内容写成文件（`write_document` 的全部路径与格式规则都在这里）。
 *
 * 为什么规则都压在代码里而不是提示词里：这是长庚**第一个真实用户目录里的写入**，
 * 而写什么、写到哪、要不要覆盖，全部来自模型给的参数。参数是不可信的——
 * 提示词里写一句"不要写到别处"拦不住一个写错名字的调用，所以路径在解析阶段就定死：
 *
 * 1. **落点唯一**：只写 `<桌面>\长庚产出\`，模型给不了目录。没有"随便写到哪"的能力，
 *    也就没有"帮你把桌面上那份覆盖掉"的事故。
 * 2. **只写能看的文件**：文本类 `.md/.txt/.csv/.json/.html`，加上 Office 的
 *    `.docx/.pptx`。`.bat/.ps1/.lnk/.exe` 这类就算落在这个目录里也是"双击就执行"，不给这条路。
 * 3. **永不覆盖**：同一路径已经存在时换一个名字（`周报 (2).md`），并在结果里报出
 *    最终路径。覆盖别人的文件是不可撤回的，而"多一个文件"最多是收拾一下。
 * 4. **写完要能核对**：`writeDocumentOnce` 用 `wx` 独占创建，`inspectDocument`
 *    回读同一个路径算 sha——那句"存好了"必须是读回来的事实。
 *
 * 关于老格式：用户说".doc / .ppt"时，落盘的是 `.docx / .pptx`。
 * 原因见 `LEGACY_SWAP`——不是"差不多"，是两代完全不同的文件格式。
 */

/**
 * 产出目录名：固定挂在**桌面**下面，用户一眼能找到。
 *
 * 为什么是桌面而不是「文档」：写出来的东西是给用户当场用的（一份周报、一套幻灯片），
 * 落在「文档」里他得先想起来去那儿找。挂在桌面根目录而不是直接铺在桌面上——
 * 直接散在图标堆里，写多几次桌面就没法看了。
 */
export const OUTPUT_FOLDER = '长庚产出'

/** 一次最多写多少字。工具参数来自模型，不设上限等于允许它把整段上下文倒进一个文件 */
export const MAX_DOC_CHARS = 100_000

/** 直接照原文写出去的文本类后缀。全是"文本语料"，没有一个是双击就执行的东西 */
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.html', '.htm'])

/** 需要按 Markdown 解析、再生成 OOXML 的后缀 */
const OFFICE_EXT = new Set(['.docx', '.pptx'])

/**
 * 老格式 → 新格式。
 *
 * `.doc` / `.ppt` 是 1997 年的 OLE 复合文档（FAT 表 + FIB + 记录树），
 * 和 `.docx` / `.pptx`（ZIP + XML）**不是同一代东西**，改个后缀不会让它变成另一种。
 * 直接把 XML 包写成 `.doc`，Word 打开会报"文件已损坏或格式不符"——那比不给写更糟，
 * 用户会以为文件存下来了、以后打不开了才发现。
 *
 * 所以这里**明确换名**而不是照写：落盘 `.docx`，回执里如实说"你要的 .doc 我写不了，
 * 已经存成 .docx，Word 能直接打开"。这一条对应的是"宁可说清楚，也不给一个假的"。
 */
const LEGACY_SWAP: Record<string, string> = { '.doc': '.docx', '.ppt': '.pptx' }

const DEFAULT_EXT = '.md'

/** 文件名主体最多多长（不含后缀）。Windows 单段 255，留出 ` (99)` 和中文多字节的余量 */
const MAX_STEM_CHARS = 60

/** Windows 保留设备名：叫这些名字的文件建不出来，不如提前说清楚 */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 文件名里 Windows 不接受的字符（含控制字符） */
const ILLEGAL_RE = /[<>:"|?*\u0000-\u001f]/g

/** 文件的产出方式，决定 `write_document` 拿什么去写 */
export type DocFormat = 'text' | 'docx' | 'pptx'

export type NameCheck =
  | {
      ok: true
      name: string
      format: DocFormat
      /** 用户要的后缀被换成了什么（`.doc` → `.docx`）。null = 没换过 */
      swappedFrom: string | null
    }
  | { ok: false; reason: string }

/** 后缀 → 产出方式。文本类返回 'text'，Office 返回对应格式；不认识返回 null */
export function formatOf(ext: string): DocFormat | null {
  if (TEXT_EXT.has(ext)) return 'text'
  if (ext === '.docx') return 'docx'
  if (ext === '.pptx') return 'pptx'
  return null
}

/**
 * 把模型给的名字归一成一个能落盘的文件名。
 *
 * 认不出来的**一律拒绝**，不做"我猜你其实想写 XX"——猜出来的名字写下去，
 * 用户拿到的是一个他没要的文件。唯一会静默改写的是非法字符（换成 `_`），
 * 因为卡片上展示的就是改写后的最终名字，他在点通过之前看得见。
 */
export function sanitizeDocumentName(raw: unknown): NameCheck {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: '没有给出文件名' }
  // 带目录的一律拒绝，而不是切掉目录：切掉之后"写 A"变成了"写 B"，卡片上写着 B，
  // 模型却以为写的是 A。宁可拒一次，让它换个名字重来
  if (/[\\/]/.test(text) || /^[a-zA-Z]:/.test(text)) {
    return { ok: false, reason: '只给文件名，不要带目录——文件只会写到「桌面\\长庚产出」里' }
  }
  if (text.includes('..') || text === '.' || text === '..') {
    return { ok: false, reason: '文件名里不能有「..」' }
  }

  let name = text.replace(ILLEGAL_RE, '_').replace(/[. ]+$/, '').trim()
  if (!name) return { ok: false, reason: '文件名清洗之后是空的，换个名字' }
  // 以点开头的是隐藏文件（`.md` 这种连名字都没有）：用户想存东西，不是想藏东西
  if (name.startsWith('.')) return { ok: false, reason: '文件名不能以「.」开头，先给个名字' }

  let ext = path.extname(name).toLowerCase()
  let swappedFrom: string | null = null
  if (!ext) {
    name += DEFAULT_EXT
    ext = DEFAULT_EXT
  } else if (LEGACY_SWAP[ext]) {
    // 老二进制格式换名存：见 LEGACY_SWAP 上面的说明
    swappedFrom = ext
    ext = LEGACY_SWAP[ext]!
    name = name.slice(0, name.length - swappedFrom.length) + ext
  } else if (!formatOf(ext)) {
    return {
      ok: false,
      reason: `不能写 ${ext} 文件（只能写 ${[...TEXT_EXT, ...OFFICE_EXT].join(' / ')}，另外 .doc/.ppt 会存成 .docx/.pptx）——会执行的后缀一律不给写`
    }
  }

  let stem = name.slice(0, name.length - ext.length).trim()
  if (!stem) return { ok: false, reason: '文件名不能只有后缀' }
  if (RESERVED_RE.test(stem)) {
    return { ok: false, reason: `「${stem}」是 Windows 的保留设备名，建不出文件，换个名字` }
  }
  if (stem.length > MAX_STEM_CHARS) stem = stem.slice(0, MAX_STEM_CHARS)

  const format = formatOf(ext)
  if (!format) return { ok: false, reason: `不能写 ${ext} 文件` }
  return { ok: true, name: `${stem}${ext}`, format, swappedFrom }
}

export interface DocumentTarget {
  ok: true
  /** 产出目录（不存在时写入前才创建） */
  dir: string
  /** 最终文件完整路径 */
  path: string
  name: string
  /** 是否因为同名已存在而换了名字 */
  renamed: boolean
  /** 这份文件是怎么生成的：照原文写 / 生成 docx / 生成 pptx */
  format: DocFormat
  /** 用户要的后缀被换成了什么（`.doc` → `.docx`）。null = 没换过 */
  swappedFrom: string | null
}

export type DocumentPlan = DocumentTarget | { ok: false; reason: string }

export function outputFolderOf(outputRoot: string): string {
  return path.join(outputRoot, OUTPUT_FOLDER)
}

/**
 * 这个路径是不是长庚自己写出来的产出。
 *
 * 给 `shell:reveal` 用：那是渲染层唯一一处能指挥系统去定位文件的地方，
 * 而"传个任意路径就能让资源管理器把它标出来"等于把本机文件系统交出去了。
 * 只认产出目录里的东西，别处一律 false。
 *
 * 用 path.relative 而不是 startsWith：`C:\桌面\长庚产出2\x.txt` 以同一个前缀开头，
 * 但它不在这个目录里。
 */
export function isInsideOutput(outputRoot: string, filePath: string): boolean {
  const root = path.resolve(outputFolderOf(String(outputRoot ?? '')))
  const target = path.resolve(String(filePath ?? ''))
  const rel = path.relative(root, target)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 只认 ENOENT：读不到（权限、路径坏了）要当作"可能有"，不能当成"空着可以写" */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * 解析出这次要写的文件（解析与执行分开，卡片上的路径就是真正写下的那个）。
 *
 * 同名已存在时换 ` (2)`、` (3)`…：覆盖是不可撤回的，"多一个文件"不是。
 */
export async function resolveDocument(outputRoot: string, rawName: unknown): Promise<DocumentPlan> {
  const dir = String(outputRoot ?? '').trim()
  if (!dir) return { ok: false, reason: '当前环境没有可写的文档目录' }

  const checked = sanitizeDocumentName(rawName)
  if (!checked.ok) return checked

  const folder = outputFolderOf(dir)
  const ext = path.extname(checked.name)
  const stem = checked.name.slice(0, checked.name.length - ext.length)

  for (let i = 1; i <= 99; i += 1) {
    const name = i === 1 ? checked.name : `${stem} (${i})${ext}`
    const full = path.join(folder, name)
    if (!(await exists(full))) {
      // 兜底：明确要求仍在产出目录之内（改名逻辑不该有机会跳出去）
      const rel = path.relative(path.resolve(folder), path.resolve(full))
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: '解析出的路径跑出了产出目录，这次不写' }
      }
      return {
        ok: true,
        dir: folder,
        path: full,
        name,
        renamed: i > 1,
        format: checked.format,
        swappedFrom: checked.swappedFrom
      }
    }
  }
  return { ok: false, reason: '同名文件已经有 99 个了，换个名字再写' }
}

export interface WrittenDocument {
  ok: true
  path: string
  name: string
  bytes: number
  /** 写进去的内容的 sha256（回读核对拿它比） */
  sha256: string
}

export type WriteOutcome = WrittenDocument | { ok: false; reason: string; exists?: boolean }

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 独占创建 + 写入。
 *
 * `wx` 是这里的关键：解析时"这个名字空着"和真正创建之间隔着一次授权卡（用户可能
 * 想了半分钟），这期间冒出来的同名文件不该被覆盖。`wx` 撞上就如实失败，不退回默认覆盖。
 *
 * 收 Buffer 而不是 string：.docx/.pptx 是 ZIP 二进制，用 utf8 写出去就是一份坏文件。
 */
export async function writeDocumentOnce(
  target: DocumentTarget,
  content: string | Buffer
): Promise<WriteOutcome> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  try {
    await fs.mkdir(target.dir, { recursive: true })
    const handle = await fs.open(target.path, 'wx')
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, exists: true, reason: '等你点授权卡的这段时间里，同名文件出现了，这次没有写，也没有覆盖它' }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  await fs.chmod(target.path, 0o666).catch(() => {})
  return { ok: true, path: target.path, name: target.name, bytes: data.length, sha256: sha256(data) }
}

/**
 * 回读一个文件，算它现在到底是什么。
 *
 * 事后核对专用：写成功之后就靠这个回答"文件真的在、内容真的对"，
 * 而不是把刚才那句回执再说一遍。
 */
export async function inspectDocument(
  filePath: string
): Promise<{ ok: true; bytes: number; sha256: string } | { ok: false; reason: string }> {
  try {
    const buf = await fs.readFile(filePath)
    return { ok: true, bytes: buf.length, sha256: sha256(buf) }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export { sha256 as documentSha256 }

/** 生成好的产出：字节已经是最终形态，写入只做落盘 */
export interface BuiltDocument {
  buffer: Buffer
  /** 给人看的一句话（"共 12 页"），卡片和回执都用得上 */
  detail?: string
}

/**
 * 按格式生成最终字节。
 *
 * 放在这里而不是工具里，是为了让"生成"和"落盘"两件事分开：生成在 plan 阶段就做完
 * （所以卡片上能写清"共几页"，而且生成失败**不会弹卡**），落盘在用户点完之后才发生。
 * 两边用的是**同一份**字节，不存在"卡片上说的是 A、写下去的是 B"。
 */
export function buildDocument(format: DocFormat, content: string, title: string): BuiltDocument {
  if (format === 'docx') {
    const built = buildDocx(content, title)
    return { buffer: built.buffer, detail: `${built.blocks} 段、约 ${built.chars} 字` }
  }
  if (format === 'pptx') {
    const built = buildPptx(content, title)
    return { buffer: built.buffer, detail: `共 ${built.slides} 页、约 ${built.chars} 字` }
  }
  return { buffer: Buffer.from(content, 'utf8') }
}
