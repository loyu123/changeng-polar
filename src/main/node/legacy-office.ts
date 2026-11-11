import { isOle, oleStream, readOle, type OleFile } from './ole'

/**
 * 从老式 `.doc` / `.xls` / `.ppt`（Word / Excel / PowerPoint 97–2003）里把文字抠出来。
 *
 * 这几种不是 ZIP，所以 office.ts 那套解不开；它们是 OLE 容器里的一条流，
 * 流里面又是一层二进制记录表。这里的做法是：
 *   .doc → 读 `WordDocument` 流的 FIB，从 `0Table`/`1Table` 里取"片段表"（piece table），
 *          片段表告诉你正文的每一段在哪、是单字节还是 UTF-16
 *   .xls → 读 `Workbook` 流里的 BIFF 记录，共享字符串表 + 每格的数值
 *   .ppt → 读 `PowerPoint Document` 流里的记录树，文字在有页分隔的
 *          `SlideListWithText` 容器里（见下面 .ppt 那一节）
 *
 * 边界写在代码里，不靠调用方记得：
 * - 加密过的老文件读不了（`fEncrypted` 位 / `EncryptedSummary` 流），要如实说，不试密码
 * - 中文老文件里单字节片段的编码按 FIB 的语言 ID 判（中文走 GB18030），
 *   判错时得到的是错字而不是乱码——所以这一点写进返回的 warnings
 * - 只读文字，不还原格式、公式和批注
 */

/* ------------------------------------------------------------------ *
 * .doc
 * ------------------------------------------------------------------ */

/** Word 的 FIB 里，Word 97 及以后才有片段表 */
const FIB_FC_CLX = 0x01a2
const FIB_LCB_CLX = 0x01a6

function decodeSingleByte(bytes: Buffer, chinese: boolean): string {
  // 全是 ASCII 就是 ASCII，别去猜代码页
  let high = false
  for (const byte of bytes) {
    if (byte >= 0x80) {
      high = true
      break
    }
  }
  if (!high) return bytes.toString('latin1')
  if (chinese) return new TextDecoder('gb18030').decode(bytes)
  // 非中文老文档的单字节文本是 cp1252；Node 的 UTF-8 解不了它，退回 latin1
  // （只有 0x80–0x9F 那一段会差，而那一段在正文里极少出现）
  return bytes.toString('latin1')
}

/** Word 的正文里夹着一堆控制字符：段落符、单元格符、域标记 */
function cleanWordText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/[\x07\x0b\x0c]/g, '\n')
    .replace(/\x1e/g, '-')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface LegacyText {
  text: string
  warnings: string[]
}

export function docText(file: OleFile): LegacyText {
  const warnings: string[] = []
  const wd = oleStream(file, 'WordDocument')
  if (!wd || wd.length < 0x200) throw new Error('这个 .doc 里没有正文流（可能不是 Word 文档）')
  if (wd.readUInt16LE(0) !== 0xa5ec) throw new Error('这个 .doc 的文件头不对，可能不是 Word 文档')

  const nFib = wd.readUInt16LE(2)
  const flags = wd.readUInt16LE(0x0a)
  if ((flags & 0x0100) !== 0) throw new Error('这个 .doc 加了密（需要密码才能打开），里面的字读不了')
  const lid = wd.readUInt16LE(0x06)
  // 0x04 = 中文（0x0804 简体、0x0404 繁体、0x0C04 等）
  const chinese = (lid & 0xff) === 0x04

  // Word 6/95 没有片段表：正文就是 fcMin..fcMac 那一段
  if (nFib < 101) {
    const fcMin = wd.readUInt32LE(0x18)
    const fcMac = wd.readUInt32LE(0x1c)
    if (fcMac <= fcMin || fcMac > wd.length) throw new Error('这个 .doc 的正文范围不对，文件可能损坏了')
    warnings.push('这是 Word 95 及更早的格式，只能按单字节读，可能有个别字不对')
    return { text: cleanWordText(decodeSingleByte(wd.subarray(fcMin, fcMac), chinese)), warnings }
  }

  // fWhichTblStm：正文的辅助表在 0Table 还是 1Table
  const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table'
  const table = oleStream(file, tableName)
  if (!table) throw new Error(`这个 .doc 里找不到 ${tableName} 流，文件可能损坏了`)

  const fcClx = wd.readUInt32LE(FIB_FC_CLX)
  const lcbClx = wd.readUInt32LE(FIB_LCB_CLX)
  if (fcClx === 0 || lcbClx === 0 || fcClx + lcbClx > table.length) {
    throw new Error('这个 .doc 里找不到片段表，读不出正文')
  }

  // CLX 里先可能有若干 Prc（格式信息，跳过），最后是 Pcdt（包着片段表）
  const clx = table.subarray(fcClx, fcClx + lcbClx)
  let plc: Buffer | null = null
  for (let i = 0; i < clx.length; ) {
    const kind = clx[i]
    if (kind === 0x01) {
      if (i + 3 > clx.length) break
      i += 3 + clx.readUInt16LE(i + 1)
      continue
    }
    if (kind === 0x02) {
      const lcb = clx.readUInt32LE(i + 1)
      if (i + 5 + lcb > clx.length) throw new Error('这个 .doc 的片段表被截断了')
      plc = clx.subarray(i + 5, i + 5 + lcb)
    }
    break
  }
  if (!plc || plc.length < 4) throw new Error('这个 .doc 的结构里没有可用的片段表')

  // PlcPcd = (n+1) 个 u32 的字符位置 + n 个 8 字节的 PCD
  const n = Math.floor((plc.length - 4) / 12)
  if (n <= 0) throw new Error('这个 .doc 的片段表是空的')

  const parts: string[] = []
  let totalChars = 0
  for (let k = 0; k < n; k++) {
    const cpStart = plc.readUInt32LE(k * 4)
    const cpEnd = plc.readUInt32LE((k + 1) * 4)
    const count = cpEnd - cpStart
    if (count <= 0) continue
    totalChars += count
    const pcdAt = 4 * (n + 1) + k * 8
    const fcRaw = plc.readUInt32LE(pcdAt + 2)
    // bit30 是"单字节"标记，置位时真正的位置要右移一位
    const compressed = (fcRaw & 0x40000000) !== 0
    const fc = compressed ? (fcRaw & 0x3fffffff) >>> 1 : fcRaw
    if (compressed) {
      const slice = wd.subarray(fc, Math.min(fc + count, wd.length))
      parts.push(decodeSingleByte(slice, chinese))
    } else {
      const slice = wd.subarray(Math.min(fc, wd.length), Math.min(fc + count * 2, wd.length))
      parts.push(slice.toString('utf16le'))
    }
  }

  const text = cleanWordText(parts.join(''))
  if (!text) {
    throw new Error(
      `这份 .doc 里没有可提取的文字：片段表说有 ${n} 段、共 ${totalChars} 个字符，但去掉控制字符后什么都不剩（多半是空文档，或者正文全在图片里）`
    )
  }
  return { text, warnings }
}

/* ------------------------------------------------------------------ *
 * .xls（BIFF8）
 * ------------------------------------------------------------------ */

interface BiffRecord {
  type: number
  data: Buffer
  /** SST 这种跨 CONTINUE 的记录：第 0 段是本体，后面每段一条 */
  segments: Buffer[]
  /** 在流里的起始位置，用来判断"现在进到哪张表了" */
  pos: number
}

function readRecords(book: Buffer): BiffRecord[] {
  const out: BiffRecord[] = []
  let pos = 0
  while (pos + 4 <= book.length) {
    const type = book.readUInt16LE(pos)
    const len = book.readUInt16LE(pos + 2)
    const start = pos + 4
    if (start + len > book.length) break
    const data = book.subarray(start, start + len)
    if (type === 0x003c && out.length > 0) {
      // CONTINUE：接着上一条记录写
      const prev = out[out.length - 1]
      prev.segments.push(data)
      pos = start + len
      continue
    }
    out.push({ type, data, segments: [data], pos })
    pos = start + len
  }
  return out
}

/**
 * 共享字符串表。字符串可以跨 CONTINUE，跨过去时下一段开头会重新给一个选项字节。
 *
 * 这里用一个能**跨段**的游标，而不是"读不够就停"：
 * 一条字符串正好结束在段尾是最常见的情况，那时下一段还要接着读它的头部；
 * 一个"刚好读满就 break"的实现会在这里停住，把后面几万条全丢了——
 * 而且丢得悄无声息（取不到的索引会变成空字符串）。
 */
function readSst(record: BiffRecord): string[] {
  const strings: string[] = []
  if (record.data.length < 8) return strings
  const unique = record.data.readUInt32LE(4)
  const segments = record.segments
  let seg = 0
  let pos = 8

  const exhausted = (): boolean => pos >= segments[seg].length
  const advance = (): boolean => {
    if (seg + 1 >= segments.length) return false
    seg++
    pos = 0
    return true
  }
  /** 读 n 个字节，允许跨段（不消费选项字节：那是字符数据专用的） */
  const read = (n: number): Buffer | null => {
    const parts: Buffer[] = []
    let left = n
    while (left > 0) {
      if (exhausted() && !advance()) return null
      const take = Math.min(left, segments[seg].length - pos)
      parts.push(segments[seg].subarray(pos, pos + take))
      pos += take
      left -= take
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }

  for (let index = 0; index < unique; index++) {
    if (exhausted() && !advance()) break
    const head = read(3)
    if (!head) break
    const cch = head.readUInt16LE(0)
    let high = (head.readUInt8(2) & 0x01) !== 0
    const rich = (head.readUInt8(2) & 0x08) !== 0
    const ext = (head.readUInt8(2) & 0x04) !== 0
    let runs = 0
    let extBytes = 0
    if (rich) {
      const buf = read(2)
      if (!buf) break
      runs = buf.readUInt16LE(0)
    }
    if (ext) {
      const buf = read(4)
      if (!buf) break
      extBytes = buf.readUInt32LE(0)
    }

    let text = ''
    let remaining = cch
    while (remaining > 0) {
      if (exhausted()) {
        if (!advance()) break
        // 跨段之后的第一件事是重新读选项字节：高字节标志可能变了
        const flag = read(1)
        if (!flag) break
        high = (flag.readUInt8(0) & 0x01) !== 0
      }
      const available = Math.floor((segments[seg].length - pos) / (high ? 2 : 1))
      const takeCount = Math.min(available, remaining)
      if (takeCount <= 0) {
        // 只剩半个宽字符：这一段的字符到头了，交给下一轮跨段
        if (!advance()) break
        const flag = read(1)
        if (!flag) break
        high = (flag.readUInt8(0) & 0x01) !== 0
        continue
      }
      const bytes = read(takeCount * (high ? 2 : 1))
      if (!bytes) break
      text += high ? bytes.toString('utf16le') : bytes.toString('latin1')
      remaining -= takeCount
    }
    if (remaining > 0) break // 表被截断：不再往后猜
    if (runs > 0 || extBytes > 0) {
      const skip = read(runs * 4 + extBytes)
      if (!skip) break
    }
    strings.push(text)
  }
  return strings
}

/** RK 值：一个压缩过的数字，最低两位是标志位 */
function rkValue(rk: number): number {
  const int = (rk & 0x02) !== 0
  let value: number
  if (int) {
    value = (rk | 0) >> 2
  } else {
    // 高 30 位是 double 的高 32 位，低 32 位补零
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4)
    value = buf.readDoubleLE(0)
  }
  return (rk & 0x01) !== 0 ? value / 100 : value
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 1e10) / 1e10)
}

interface Sheet {
  name: string
  startPos: number
  rows: Map<number, Map<number, string>>
}

export function xlsText(file: OleFile): LegacyText {
  const warnings: string[] = []
  const book = oleStream(file, 'Workbook') ?? oleStream(file, 'Book')
  if (!book || book.length < 8) throw new Error('这个 .xls 里没有工作簿流（可能不是 Excel 文件）')

  const records = readRecords(book)
  if (records.length === 0) throw new Error('这个 .xls 里没有可读的记录，文件可能损坏了')

  let codePage = 1252
  let shared: string[] = []
  const sheets: Sheet[] = []

  for (const rec of records) {
    if (rec.type === 0x0042 && rec.data.length >= 2) codePage = rec.data.readUInt16LE(0)
    if (rec.type === 0x00fc) shared = readSst(rec)
    if (rec.type === 0x0085 && rec.data.length >= 8) {
      // BOUNDSHEET：工作簿里的偏移(4) + 可见性(1) + 类型(1) + 名字长度(1) +
      // 选项字节(1) + 名字。选项字节的 bit0 = 两字节字符——漏了它，
      // "Sheet1" 会被读成 "S\0h\0e"，打印出来是一串带空档的怪字
      const startPos = rec.data.readUInt32LE(0)
      const cch = rec.data.readUInt8(6)
      const wide = (rec.data.readUInt8(7) & 0x01) !== 0
      const nameBytes = rec.data.subarray(8, 8 + cch * (wide ? 2 : 1))
      const name = wide ? nameBytes.toString('utf16le') : decodeSingleByte(nameBytes, codePage === 936)
      sheets.push({ name, startPos, rows: new Map() })
    }
  }
  if (sheets.length === 0) throw new Error('这个 .xls 里没有工作表')

  const sheetAt = (pos: number): Sheet | null => {
    let found: Sheet | null = null
    for (const sheet of sheets) {
      if (sheet.startPos <= pos && (!found || sheet.startPos > found.startPos)) found = sheet
    }
    return found
  }

  const put = (sheet: Sheet, row: number, col: number, value: string): void => {
    if (!value) return
    let line = sheet.rows.get(row)
    if (!line) {
      line = new Map()
      sheet.rows.set(row, line)
    }
    line.set(col, value)
  }

  /** 共享字符串取不到就是丢内容：数出来，别让它悄悄少几万格 */
  let missingShared = 0

  const cellString = (data: Buffer, at: number): string => {
    // BIFF8 的 LABEL/RSTRING 字符串：u16 长度 + 选项字节 + 字符
    if (at + 3 > data.length) return ''
    const cch = data.readUInt16LE(at)
    const grbit = data.readUInt8(at + 2)
    const wide = (grbit & 0x01) !== 0
    const start = at + 3
    const bytes = data.subarray(start, start + cch * (wide ? 2 : 1))
    return wide ? bytes.toString('utf16le') : decodeSingleByte(bytes, codePage === 936)
  }

  for (const rec of records) {
    const sheet = sheetAt(rec.pos)
    if (!sheet) continue
    const d = rec.data
    switch (rec.type) {
      case 0x00fd: {
        // LABELSST
        if (d.length < 10) break
        const value = shared[d.readUInt32LE(6)]
        if (value === undefined) missingShared++
        else put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), value)
        break
      }
      case 0x0203: // NUMBER
        if (d.length >= 14) put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), numberText(d.readDoubleLE(6)))
        break
      case 0x027e: // RK
        if (d.length >= 10) put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), numberText(rkValue(d.readUInt32LE(6))))
        break
      case 0x00bd: {
        // MULRK：一行里连着几格
        if (d.length < 6) break
        const row = d.readUInt16LE(0)
        const firstCol = d.readUInt16LE(2)
        const count = Math.floor((d.length - 6) / 6)
        for (let i = 0; i < count; i++) {
          put(sheet, row, firstCol + i, numberText(rkValue(d.readUInt32LE(4 + i * 6 + 2))))
        }
        break
      }
      case 0x0204: // LABEL
        if (d.length >= 9) put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), cellString(d, 6))
        break
      case 0x00d6: // RSTRING
        if (d.length >= 9) put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), cellString(d, 6))
        break
      case 0x0205: // BOOLERR
        if (d.length >= 8) {
          const row = d.readUInt16LE(0)
          const col = d.readUInt16LE(2)
          const value = d.readUInt8(6)
          const isError = d.readUInt8(7) !== 0
          put(sheet, row, col, isError ? '#错误' : value !== 0 ? 'TRUE' : 'FALSE')
        }
        break
      case 0x0006: {
        // FORMULA：缓存的结果。字符串结果另有一条 STRING 记录跟着，这里先跳过
        if (d.length < 14) break
        const row = d.readUInt16LE(0)
        const col = d.readUInt16LE(2)
        if (d.readUInt16LE(12) === 0xffff) {
          const kind = d.readUInt8(6)
          if (kind === 1) put(sheet, row, col, d.readUInt8(8) !== 0 ? 'TRUE' : 'FALSE')
          break
        }
        put(sheet, row, col, numberText(d.readDoubleLE(6)))
        break
      }
      default:
        break
    }
  }

  if (codePage !== 936 && codePage !== 1200 && codePage !== 1252) {
    warnings.push(`这份表格的代码页是 ${codePage}，单字节文字可能有个别字不对`)
  }
  if (missingShared > 0) {
    warnings.push(`有 ${missingShared} 个单元格的共享字符串没解出来（表格可能被截断），这些格子是空的`)
  }

  const blocks: string[] = []
  for (const [index, sheet] of sheets.entries()) {
    const rows = [...sheet.rows.keys()].sort((a, b) => a - b)
    const lines: string[] = []
    // 行号可能不连续（空行被跳过），按出现顺序输出即可，不必补空行
    for (const rowIndex of rows) {
      const cells = sheet.rows.get(rowIndex)!
      const maxCol = Math.max(...cells.keys())
      const values: string[] = []
      for (let col = 0; col <= maxCol; col++) values.push(cells.get(col) ?? '')
      const line = values.join('\t').replace(/\t+$/, '')
      if (line.trim()) lines.push(line)
    }
    if (lines.length > 0) blocks.push(`[工作表 ${sheet.name || index + 1}]\n${lines.join('\n')}`)
  }

  const text = blocks.join('\n\n').trim()
  if (!text) throw new Error('这份 .xls 里没有可提取的文字（可能是空工作簿，或者内容全是图）')
  return { text, warnings }
}

/* ------------------------------------------------------------------ *
 * .ppt（PowerPoint 97–2003）
 * ------------------------------------------------------------------ */

/**
 * 记录类型号。这些数不是猜的，也不会变——它们是格式规范里冻结的常量。
 * 只列这里真用到的几个，剩下的（画布、形状、配色）跟"读出文字"无关。
 */
const RT_DOCUMENT = 1000
const RT_SLIDE = 1006
const RT_SLIDE_PERSIST_ATOM = 1011
const RT_TEXT_CHARS_ATOM = 4000
const RT_TEXT_BYTES_ATOM = 4008
const RT_SLIDE_LIST_WITH_TEXT = 4080
const RT_USER_EDIT_ATOM = 4085
const RT_PERSIST_DIRECTORY = 6002

/** 记录树只有容器套容器那么深（文档→形状→文字），留足余量，防坏文件把栈打穿 */
const MAX_PPT_DEPTH = 24

interface PptRecord {
  type: number
  /** 容器的 instance 用来区分"这份列表装的是幻灯片 / 母版 / 备注" */
  instance: number
  /** 在流里的起始位置（顶层记录的偏移是绝对的，用来按 persist 目录找页） */
  start: number
  /** 原子记录的内容；容器为空 */
  data: Buffer
  children: PptRecord[]
}

/**
 * 把一段字节读成记录树。
 *
 * 记录头 8 字节：低 4 位是版本（`0xF` = 这条是容器，后面跟着子记录），
 * 高 12 位是 instance，然后是 2 字节类型和 4 字节长度。
 *
 * 长度越界就停：这类文件被下载截断过很常见，继续按偏移往后读只会读出
 * 一段看着像记录、其实是别的东西的字节，然后吐出一些"像字但不是"的结果。
 */
function readPptRecords(buf: Buffer, depth = 0): PptRecord[] {
  const out: PptRecord[] = []
  let pos = 0
  while (pos + 8 <= buf.length) {
    const verInst = buf.readUInt16LE(pos)
    const type = buf.readUInt16LE(pos + 2)
    const len = buf.readUInt32LE(pos + 4)
    const start = pos + 8
    if (len > buf.length - start) break
    const body = buf.subarray(start, start + len)
    const ver = verInst & 0x000f
    const instance = verInst >>> 4
    if (ver === 0x0f && depth < MAX_PPT_DEPTH) {
      out.push({ type, instance, start: pos, data: Buffer.alloc(0), children: readPptRecords(body, depth + 1) })
    } else {
      // 版本不是容器的都当原子读。深度用尽时也走这条：读到的是一段读不懂的字节，
      // 但至少不会无限往下钻
      out.push({ type, instance, start: pos, data: body, children: [] })
    }
    pos = start + len
  }
  return out
}

/** 一条记录是不是文本原子 */
const isTextAtom = (rec: PptRecord): boolean =>
  rec.type === RT_TEXT_CHARS_ATOM || rec.type === RT_TEXT_BYTES_ATOM

/**
 * 一个文本原子的内容。
 *
 * `TextCharsAtom` 是 UTF-16LE，一眼就懂。`TextBytesAtom` 容易被当成"某种代码页"，
 * 其实不是：它每个字节就是一个字符（码位等于字节值，即压缩过的 Unicode），
 * 所以按 latin1 一一对应地读。当成 GBK 去解会把一串正常字符配成别字。
 */
function pptAtomText(rec: PptRecord): string {
  if (rec.type === RT_TEXT_CHARS_ATOM) return rec.data.toString('utf16le')
  return rec.data.toString('latin1')
}

/** 把一棵记录树里所有文本原子按出现顺序收上来 */
function collectText(records: PptRecord[], out: string[] = []): string[] {
  for (const rec of records) {
    if (isTextAtom(rec)) out.push(pptAtomText(rec))
    if (rec.children.length > 0) collectText(rec.children, out)
  }
  return out
}

/** PowerPoint 的段落符是 \r，软换行是 \x0b，和 Word 那套不是一回事 */
function cleanPptText(text: string): string {
  return text
    .replace(/\x0b/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 持久化目录：把"某个对象在第几号"翻成"它在流的哪个偏移"。
 *
 * 这是老 PPT 里最绕的一处，但没有它就只能按字节顺序猜页——猜错了页码会串。
 * 记录 6002 里是一串 (起始编号, 条数, 若干偏移) 的组；偏移是**相对当前这一段
 * 增量编辑的起点**，而那个起点由最近一次保存（记录 4085 里的 offsetToCurrentEdit）
 * 给出来。所以顺序走一遍：先看到目录就按当前基准算，看到保存记录就更新基准。
 *
 * 同一个编号被写了两次时后写的赢——这正是"改过之后以最后一次为准"。
 */
function persistOffsets(records: PptRecord[]): Map<number, number> {
  const map = new Map<number, number>()
  let base = 0
  for (const rec of records) {
    if (rec.type === RT_USER_EDIT_ATOM && rec.data.length >= 16) {
      base = rec.data.readUInt32LE(12)
      continue
    }
    if (rec.type !== RT_PERSIST_DIRECTORY) continue
    let pos = 0
    while (pos + 4 <= rec.data.length) {
      const head = rec.data.readUInt32LE(pos)
      const first = head & 0xfffff
      const count = head >>> 20
      pos += 4
      for (let i = 0; i < count && pos + 4 <= rec.data.length; i++) {
        map.set(first + i, base + rec.data.readUInt32LE(pos))
        pos += 4
      }
    }
  }
  return map
}

interface PptPage {
  /** 这一页的文字（已经清掉控制字符，可能是空串） */
  text: string
}

export function pptText(file: OleFile): LegacyText {
  const warnings: string[] = []
  /**
   * 加密的老 PPT 不是靠哪一位标志位认的：它会另外写两条 `Encrypted*` 流，
   * 正文流本身被 RC4 加密过。所以看到这两条流就直接说读不了，
   * 不去试着解一段密文——解出来一定是一堆乱码，而乱码会被当成内容总结。
   */
  if (oleStream(file, 'EncryptedSummary') || oleStream(file, 'EncryptedDocument')) {
    throw new Error('这份 .ppt 加了密（需要密码才能打开），里面的字读不了')
  }
  const stream = oleStream(file, 'PowerPoint Document')
  if (!stream || stream.length < 8) throw new Error('这个 .ppt 里没有正文流（可能不是 PowerPoint 文件）')

  const top = readPptRecords(stream)
  if (top.length === 0) throw new Error('这份 .ppt 的记录结构读不出来，文件可能损坏或被截断了')

  /**
   * 一个文档容器就是一版完整的文档，改一次追加一份（增量保存）。
   * 所以**取最后一份**：前面那些是旧版本，把它们也读出来会让同一页文字出现好几遍。
   */
  const documents = top.filter((r) => r.type === RT_DOCUMENT)
  const current = documents[documents.length - 1]
  if (!current) throw new Error('这份 .ppt 的结构里没有文档容器，文件可能损坏了')
  if (documents.length > 1) {
    warnings.push(`这份 .ppt 存过 ${documents.length} 版（增量保存），只读了最后那一版`)
  }

  const persist = persistOffsets(top)

  /**
   * 从流里某个偏移处读**那一页**，把里面的文字收上来。
   *
   * 只取第一条记录：`readPptRecords` 会一路读到流尾，而偏移后面紧跟着的
   * 是别的页——不截断的话每一页都会把后面所有页的文字也算成自己的，
   * 于是"第 1 页"里出现第 2 页的内容（而且顺序还看着挺合理，很难发现）。
   */
  const textAtOffset = (offset: number): string[] => {
    if (offset <= 0 || offset >= stream.length) return []
    const [page] = readPptRecords(stream.subarray(offset))
    return page ? collectText([page]) : []
  }

  /** 按"页"分组取文字：先把一页的文字收齐，再清控制字符 */
  const toPage = (parts: string[]): PptPage => ({ text: cleanPptText(parts.join('\n')) })

  /**
   * 文字到底存在哪，老 PPT 有两种写法：
   *   a) 存在文档里那份「带文字的分页表」（4080）里，页序天然就是放映顺序
   *   b) 存在每一页自己的容器（1006 / 1008）里，这时候页序要靠列表里的编号
   *      去 persist 目录查偏移——按字节顺序排会在改过页序的文件上串页
   * 这里两种都走：列表里只要有字就用列表的，没有就去翻页容器。
   */
  const pagesOf = (instance: 0 | 2): PptPage[] => {
    const list = current.children.find(
      (r) => r.type === RT_SLIDE_LIST_WITH_TEXT && r.instance === instance
    )
    if (!list) return []

    const inline: Array<{ persistIdRef: number; parts: string[] }> = []
    for (const child of list.children) {
      if (child.type === RT_SLIDE_PERSIST_ATOM) {
        inline.push({ persistIdRef: child.data.length >= 4 ? child.data.readUInt32LE(0) : -1, parts: [] })
        continue
      }
      if (isTextAtom(child)) inline[inline.length - 1]?.parts.push(pptAtomText(child))
    }

    if (inline.some((p) => p.parts.length > 0)) return inline.map((p) => toPage(p.parts))

    return inline.map((p) => {
      const offset = persist.get(p.persistIdRef)
      return toPage(offset === undefined ? [] : textAtOffset(offset))
    })
  }

  const sections: string[] = []
  const slides = pagesOf(0)
  const notes = pagesOf(2)

  /**
   * 页容器那一路要是也没找到（更早的 PowerPoint 结构，或者编号对不上），
   * 退到最后一步：把顶层每一页容器里的字按文件顺序收上来。
   * 这时页码只能按文件顺序给，并且必须说明——否则用户会以为第 1 段就是第 1 页。
   */
  if (slides.length === 0) {
    const fallback = top.filter((r) => r.type === RT_SLIDE)
    if (fallback.length > 0) {
      for (const rec of fallback) slides.push(toPage(collectText(rec.children)))
      warnings.push('这份 .ppt 的分页表对不上，页码是按文件里的顺序给的，页与页的先后可能不准')
    }
  }

  slides.forEach((page, index) => {
    // 空白页不输出：一页只有图片时没有字，但它占的页码不能因此往前挤
    if (!page.text) return
    sections.push(`[第 ${index + 1} 张幻灯片]\n${page.text}`)
  })
  notes.forEach((page, index) => {
    if (!page.text) return
    sections.push(`[备注 ${index + 1}]\n${page.text}`)
  })

  const text = sections.join('\n\n').trim()
  if (!text) {
    throw new Error(
      `这份 .ppt 里没有可提取的文字：找到 ${slides.length} 张幻灯片，但里面一个字都没有（多半每一页都只有图片和图形，或者标题框是空的）`
    )
  }
  return { text, warnings }
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

export function legacyOfficeText(kind: 'doc' | 'xls' | 'ppt', buffer: Buffer): LegacyText {
  if (!isOle(buffer)) throw new Error('这不是老式 Office 文件（找不到 OLE 文件头）')
  const file = readOle(buffer)
  if (kind === 'doc') return docText(file)
  if (kind === 'xls') return xlsText(file)
  return pptText(file)
}

export type { OleFile }
