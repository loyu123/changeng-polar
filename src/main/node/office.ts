import { inflateRawSync } from 'node:zlib'

/**
 * 从 .docx / .xlsx / .pptx 里把文字抠出来。
 *
 * 这三种其实都是 ZIP 包着几段 XML——**不是**需要 Office 才能打开的东西。
 * 所以这里不调用 Word/Excel（那会拉起一个窗口，还可能卡在登录、激活、宏提示上），
 * 而是按 ZIP 结构自己拆、按标签自己剥。带来的好处是：快（几十毫秒）、不打扰用户、
 * 也不会因为机器上没装 Office 就读不了。
 *
 * 为什么值得为它单独写一个 ZIP 读取器：`install.ts` 那条路走的是 winget，
 * 整个仓库没有第三方 zip 依赖；为了读一个 Word 文档引一个依赖包，
 * 换来的攻击面和升级负担比这段代码大得多。ZIP 的中央目录结构是稳定的老格式。
 *
 * **做不到的事要说清楚**：PDF（尤其带 CID 字体的中文 PDF）、老式 .doc/.xls（OLE 二进制）、
 * 加密文档，这里都读不了。调用方据 kind 给出"读不了，但可以帮你打开"的回答，
 * 而不是吐一堆乱码让模型去总结。
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

export interface ZipEntry {
  name: string
  data: Buffer
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** 中央目录在文件末尾，后面最多跟 64KB 注释（ZIP 规范的上限） */
const EOCD_SCAN_BYTES = 66_000

/**
 * 读出 ZIP 里所有条目。读不懂就抛错，不做"尽量凑合"——
 * 一个损坏的包凑合解出来的字，会被模型当成文档内容去总结。
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（找不到目录结尾）')
  const total = buffer.readUInt16LE(eocd + 10)
  const cenOffset = buffer.readUInt32LE(eocd + 16)
  if (cenOffset === 0xffffffff) throw new Error('ZIP64 格式暂不支持')

  const entries = new Map<string, Buffer>()
  let cursor = cenOffset
  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CEN_SIG) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    // ZIP 里的名字是 UTF-8（Office 生成的包都是）。用 latin1 会毁掉中文文件名
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) continue
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOC_SIG) continue
    const locNameLen = buffer.readUInt16LE(localOffset + 26)
    const locExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + locNameLen + locExtraLen
    const raw = buffer.subarray(start, start + compressedSize)
    if (raw.length !== compressedSize) continue

    try {
      // 0 = 存储（不压缩），8 = deflate。Office 只用到这两种
      if (method === 0) entries.set(name, Buffer.from(raw))
      else if (method === 8) entries.set(name, inflateRawSync(raw))
    } catch {
      // 单个条目坏掉不该让整份文档变成"读不了"：跳过去，能读的照读
    }
  }
  return entries
}

function findEocd(buffer: Buffer): number {
  const from = Math.max(0, buffer.length - EOCD_SCAN_BYTES)
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' '
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 剥标签：先把"该换行/该断开"的闭合标签换成记号，再一次性去掉所有标签 */
function stripXml(xml: string): string {
  return decodeXmlEntities(
    xml
      /**
       * 表格格子里的最后一个段落不该断行——它后面紧跟的是 `</w:tc>`（换列）。
       * 先吃掉这个组合，否则一行表格会被拆成"姓名\n\t年龄"这种残句。
       */
      .replace(/<\/w:p>\s*(?=<\/w:tc>)/gi, '')
      .replace(/<w:br\b[^>]*\/>/gi, '\n')
      .replace(/<a:br\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<\/w:tc>/gi, '\t')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<\/a:p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
}

/** Word：正文都在 word/document.xml 里；脚注/页眉页脚不带，用户要的是正文 */
export function docxText(entries: Map<string, Buffer>): string {
  const body = entries.get('word/document.xml')
  if (!body) throw new Error('这个 .docx 里没有正文（可能不是 Word 文档，或被加密了）')
  return tidy(stripXml(body.toString('utf8')))
}

/** Excel：共享字符串表 + 每张表里的单元格，按行还原成制表符分隔的文本 */
export function xlsxText(entries: Map<string, Buffer>): string {
  const shared: string[] = []
  const sharedXml = entries.get('xl/sharedStrings.xml')
  if (sharedXml) {
    for (const si of sharedXml.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      // 一个 si 里可能有多个 <t>（富文本分段），拼起来才是这一格的内容
      const parts = [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((m) => decodeXmlEntities(m[1]))
      shared.push(parts.join(''))
    }
  }

  const sheetNames = [...entries.keys()]
    .map((name) => ({ name, m: /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => Boolean(x.m))
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
  if (sheetNames.length === 0) throw new Error('这个 .xlsx 里没有工作表')

  const blocks: string[] = []
  for (const [index, sheet] of sheetNames.entries()) {
    const xml = entries.get(sheet.name)!.toString('utf8')
    const rows: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cell[1]
        const inner = cell[2]
        // t="s" = 值是共享字符串表的下标；t="inlineStr" = 文字直接在 <is><t> 里
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)?.[1] ?? ''
        const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/i.exec(inner)?.[1] ?? ''
        if (/\bt="s"/i.test(attrs)) {
          cells.push(shared[Number(value)] ?? '')
        } else if (inline) {
          cells.push(decodeXmlEntities(inline))
        } else {
          cells.push(decodeXmlEntities(value))
        }
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join('\t'))
    }
    if (rows.length > 0) blocks.push(`[工作表 ${index + 1}]\n${rows.join('\n')}`)
  }
  return tidy(blocks.join('\n\n'))
}

/** PowerPoint：每页正文按段落拆行，页与页之间留标题行 */
export function pptxText(entries: Map<string, Buffer>): string {
  const slides = [...entries.keys()]
    .map((name) => ({ name, m: /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => Boolean(x.m))
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
  if (slides.length === 0) throw new Error('这个 .pptx 里没有幻灯片')

  const blocks: string[] = []
  for (const [index, slide] of slides.entries()) {
    const text = tidy(stripXml(entries.get(slide.name)!.toString('utf8')))
    if (text) blocks.push(`[第 ${index + 1} 页]\n${text}`)
  }
  return tidy(blocks.join('\n\n'))
}

/** 合并多余空行、去掉行尾空白：剥完标签的 XML 会留下大量空行 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[  ]+\n/g, '\n')
    // 行尾多出来的制表符（表格最后一列之后）不算内容
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
}

/** 统一入口：给包和格式，出正文。读不懂就抛错，由调用方翻成"读不了" */
export function officeText(kind: OfficeKind, buffer: Buffer): string {
  const entries = readZip(buffer)
  const text = kind === 'docx' ? docxText(entries) : kind === 'xlsx' ? xlsxText(entries) : pptxText(entries)
  if (!text.trim()) throw new Error('这份文档里没有可提取的文字（可能是扫描件、纯图片或空文档）')
  return text
}
