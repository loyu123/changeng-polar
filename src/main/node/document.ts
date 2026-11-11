import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 把一段文本写成文件（`write_document` 的全部路径与格式规则都在这里）。
 *
 * 为什么规则都压在代码里而不是提示词里：这是长庚**第一个真实用户目录里的写入**，
 * 而写什么、写到哪、要不要覆盖，全部来自模型给的参数。参数是不可信的——
 * 提示词里写一句"不要写到别处"拦不住一个写错名字的调用，所以路径在解析阶段就定死：
 *
 * 1. **落点唯一**：只写 `<文档>\长庚产出\`，模型给不了目录。没有"随便写到哪"的能力，
 *    也就没有"帮你把桌面上那份覆盖掉"的事故。
 * 2. **只写能看的文件**：`.md/.txt/.csv/.json/.html`。`.bat/.ps1/.lnk/.exe` 这类
 *    就算落在这个目录里也是"双击就执行"，不给这条路。
 * 3. **永不覆盖**：同一路径已经存在时换一个名字（`周报 (2).md`），并在结果里报出
 *    最终路径。覆盖别人的文件是不可撤回的，而"多一个文件"最多是收拾一下。
 * 4. **写完要能核对**：`writeDocumentOnce` 用 `wx` 独占创建，`inspectDocument`
 *    回读同一个路径算 sha——那句"存好了"必须是读回来的事实。
 */

/** 产出目录名：固定挂在系统「文档」下面，用户一眼能找到 */
export const OUTPUT_FOLDER = '长庚产出'

/** 一次最多写多少字。工具参数来自模型，不设上限等于允许它把整段上下文倒进一个文件 */
export const MAX_DOC_CHARS = 100_000

/** 允许写出的后缀。全是"文本语料"，没有一个是双击就执行的东西 */
const ALLOWED_EXT = new Set(['.md', '.txt', '.csv', '.json', '.html', '.htm'])

const DEFAULT_EXT = '.md'

/** 文件名主体最多多长（不含后缀）。Windows 单段 255，留出 ` (99)` 和中文多字节的余量 */
const MAX_STEM_CHARS = 60

/** Windows 保留设备名：叫这些名字的文件建不出来，不如提前说清楚 */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 文件名里 Windows 不接受的字符（含控制字符） */
const ILLEGAL_RE = /[<>:"|?*\u0000-\u001f]/g

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string }

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
    return { ok: false, reason: '只给文件名，不要带目录——文件只会写到「文档\\长庚产出」里' }
  }
  if (text.includes('..') || text === '.' || text === '..') {
    return { ok: false, reason: '文件名里不能有「..」' }
  }

  let name = text.replace(ILLEGAL_RE, '_').replace(/[. ]+$/, '').trim()
  if (!name) return { ok: false, reason: '文件名清洗之后是空的，换个名字' }
  // 以点开头的是隐藏文件（`.md` 这种连名字都没有）：用户想存东西，不是想藏东西
  if (name.startsWith('.')) return { ok: false, reason: '文件名不能以「.」开头，先给个名字' }

  let ext = path.extname(name).toLowerCase()
  if (!ext) {
    name += DEFAULT_EXT
    ext = DEFAULT_EXT
  } else if (!ALLOWED_EXT.has(ext)) {
    return {
      ok: false,
      reason: `不能写 ${ext} 文件（只能写 ${[...ALLOWED_EXT].join(' / ')}）——会执行的后缀一律不给写`
    }
  }

  let stem = name.slice(0, name.length - ext.length).trim()
  if (!stem) return { ok: false, reason: '文件名不能只有后缀' }
  if (RESERVED_RE.test(stem)) {
    return { ok: false, reason: `「${stem}」是 Windows 的保留设备名，建不出文件，换个名字` }
  }
  if (stem.length > MAX_STEM_CHARS) stem = stem.slice(0, MAX_STEM_CHARS)

  return { ok: true, name: `${stem}${ext}` }
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
}

export type DocumentPlan = DocumentTarget | { ok: false; reason: string }

export function outputFolderOf(documentsDir: string): string {
  return path.join(documentsDir, OUTPUT_FOLDER)
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
export async function resolveDocument(documentsDir: string, rawName: unknown): Promise<DocumentPlan> {
  const dir = String(documentsDir ?? '').trim()
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
      return { ok: true, dir: folder, path: full, name, renamed: i > 1 }
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
 */
export async function writeDocumentOnce(
  target: DocumentTarget,
  content: string
): Promise<WriteOutcome> {
  const data = Buffer.from(content, 'utf8')
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
