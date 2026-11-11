import { inflateRawSync, inflateSync } from 'node:zlib'

/**
 * 从 .pdf 里把「文字层」抠出来。
 *
 * 不引 pdfjs 这类库，理由和 office.ts 里写的那个一样：为了读一份文档引一个
 * 上百 KB、还要跟着升级的依赖，换来的攻击面比这段代码大；而这里要的东西很窄——
 * 只要文字，不要排版、不要渲染、不要图。
 *
 * PDF 的结构其实是三段：
 *   1. 一堆 `N G obj … endobj` 的对象（字典 / 数组 / 数字 / 字符串）
 *   2. 页面树：Catalog → Pages → Kids → 每页的 /Contents 是一条内容流
 *   3. 内容流里是一串操作符：`BT /F1 12 Tf … (文字) Tj ET`
 *
 * 抠字的难点全在**字体编码**上，不在结构上：
 * - 简单字体（Type1/TrueType）一个字节一个码，通常就是 cp1252，能直接读
 * - 中文 PDF 几乎都是 Type0 + Identity-H：一个字符两个字节，而且这两个字节
 *   不是 Unicode，是「字形号」。没有 /ToUnicode 表就还原不出字来
 * - 所以这里认真处理 /ToUnicode（bfchar / bfrange），没有它就**如实说读不了**，
 *   绝不把字形号当 Unicode 吐出去——那样得到的是一串看着像字的东西，
 *   比不明说更糟：模型会拿它编内容。
 *
 * 明确做不到的（都在返回的 warnings / 抛错里说清楚，不装作读到了）：
 * - 扫描件：整页是图，没有文字层 → 抛错"没有文字层"
 * - 加密 PDF（带 /Encrypt）：需要密码，不试
 * - Type0 字体但没有 /ToUnicode：还原不出字，那一页会记一条 warning
 */

/* ------------------------------------------------------------------ *
 * PDF 对象
 * ------------------------------------------------------------------ */

interface PdfName {
  name: string
}
interface PdfString {
  bytes: Buffer
}
interface PdfRef {
  num: number
  gen: number
}
interface PdfKeyword {
  keyword: string
}
interface PdfDict {
  dict: Map<string, PdfValue>
}
type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfKeyword | PdfValue[] | PdfDict

const isDict = (v: PdfValue | undefined): v is PdfDict =>
  typeof v === 'object' && v !== null && 'dict' in v
const isName = (v: PdfValue | undefined): v is PdfName =>
  typeof v === 'object' && v !== null && 'name' in v
const isString = (v: PdfValue | undefined): v is PdfString =>
  typeof v === 'object' && v !== null && 'bytes' in v
const isRef = (v: PdfValue | undefined): v is PdfRef =>
  typeof v === 'object' && v !== null && 'num' in v
const isKeyword = (v: PdfValue | undefined, word?: string): v is PdfKeyword =>
  typeof v === 'object' && v !== null && 'keyword' in v && (word === undefined || v.keyword === word)

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

/**
 * 一个最小的 PDF 词法 + 语法分析器。
 *
 * 直接在 Buffer 上按字节走：PDF 里的「字符串」是**字节串**不是文本，
 * 中间解码成 JS 字符串会把内容流里的二进制搞坏。
 */
class PdfLexer {
  constructor(
    readonly buf: Buffer,
    public pos = 0
  ) {}

  skipWs(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (WS.has(c)) {
        this.pos++
        continue
      }
      if (c === 0x25) {
        // % 注释，到行尾
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) {
          this.pos++
        }
        continue
      }
      break
    }
  }

  readValue(depth = 0): PdfValue {
    if (depth > 32) return null
    this.skipWs()
    const c = this.buf[this.pos]
    if (c === undefined) return null
    if (c === 0x2f) return this.readName()
    if (c === 0x28) return this.readLiteralString()
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.readDict(depth)
      return this.readHexString()
    }
    if (c === 0x5b) return this.readArray(depth)
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return this.readNumberOrRef()
    return this.readKeyword()
  }

  /** `/Name`，其中 `#41` 是转义后的 A */
  private readName(): PdfName {
    this.pos++ // '/'
    let name = ''
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (WS.has(c) || DELIM.has(c)) break
      if (c === 0x23 && this.pos + 2 < this.buf.length) {
        const hex = this.buf.toString('latin1', this.pos + 1, this.pos + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16))
          this.pos += 3
          continue
        }
      }
      name += String.fromCharCode(c)
      this.pos++
    }
    return { name }
  }

  /** `(…)`，可以嵌套括号，反斜杠转义 */
  private readLiteralString(): PdfString {
    this.pos++ // '('
    const out: number[] = []
    let depth = 1
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (c === 0x5c) {
        this.pos++
        const e = this.buf[this.pos]
        if (e === undefined) break
        const simple = SIMPLE_ESCAPE[e]
        if (simple !== undefined) {
          out.push(simple)
          this.pos++
          continue
        }
        if (e >= 0x30 && e <= 0x37) {
          // \ddd 八进制，最多三位
          let oct = ''
          while (oct.length < 3 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37) {
            oct += String.fromCharCode(this.buf[this.pos])
            this.pos++
          }
          out.push(parseInt(oct, 8) & 0xff)
          continue
        }
        if (e === 0x0d) {
          // 续行符：反斜杠 + EOL，什么都不产出
          this.pos++
          if (this.buf[this.pos] === 0x0a) this.pos++
          continue
        }
        if (e === 0x0a) {
          this.pos++
          continue
        }
        out.push(e)
        this.pos++
        continue
      }
      if (c === 0x28) depth++
      if (c === 0x29) {
        depth--
        if (depth === 0) {
          this.pos++
          break
        }
      }
      out.push(c)
      this.pos++
    }
    return { bytes: Buffer.from(out) }
  }

  /** `<48656c6c6f>` */
  private readHexString(): PdfString {
    this.pos++ // '<'
    let hex = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = this.buf[this.pos]
      if (!WS.has(c)) hex += String.fromCharCode(c)
      this.pos++
    }
    this.pos++ // '>'
    if (hex.length % 2 === 1) hex += '0'
    return { bytes: Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ''), 'hex') }
  }

  private readArray(depth: number): PdfValue[] {
    this.pos++ // '['
    const out: PdfValue[] = []
    for (;;) {
      this.skipWs()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x5d) {
        this.pos++
        break
      }
      const before = this.pos
      out.push(this.readValue(depth + 1))
      if (this.pos === before) this.pos++ // 卡住就往前挪，绝不死循环
    }
    return out
  }

  private readDict(depth: number): PdfDict {
    this.pos += 2 // '<<'
    const dict = new Map<string, PdfValue>()
    for (;;) {
      this.skipWs()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      const before = this.pos
      const key = this.readValue(depth + 1)
      this.skipWs()
      const value = this.readValue(depth + 1)
      if (isName(key)) dict.set(key.name, value)
      if (this.pos === before) this.pos++
    }
    return { dict }
  }

  private readNumberOrRef(): PdfValue {
    const start = this.pos
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (WS.has(c) || DELIM.has(c)) break
      this.pos++
    }
    const raw = this.buf.toString('latin1', start, this.pos)
    const num = Number(raw)
    if (!Number.isFinite(num)) return null
    if (!Number.isInteger(num)) return num

    // `12 0 R` 是引用：先记下位置，认错了要退回来
    const save = this.pos
    this.skipWs()
    const genStart = this.pos
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (c < 0x30 || c > 0x39) break
      this.pos++
    }
    const gen = Number(this.buf.toString('latin1', genStart, this.pos))
    if (this.pos > genStart) {
      this.skipWs()
      if (this.buf[this.pos] === 0x52 && (this.pos + 1 >= this.buf.length || WS.has(this.buf[this.pos + 1]) || DELIM.has(this.buf[this.pos + 1]))) {
        this.pos++
        return { num, gen }
      }
    }
    this.pos = save
    return num
  }

  private readKeyword(): PdfValue {
    const start = this.pos
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (WS.has(c) || DELIM.has(c)) break
      this.pos++
    }
    const word = this.buf.toString('latin1', start, this.pos)
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    return { keyword: word }
  }
}

const SIMPLE_ESCAPE: Record<number, number> = {
  0x6e: 0x0a, // \n
  0x72: 0x0d, // \r
  0x74: 0x09, // \t
  0x62: 0x08,
  0x66: 0x0c,
  0x28: 0x28,
  0x29: 0x29,
  0x5c: 0x5c
}

/* ------------------------------------------------------------------ *
 * 对象表
 * ------------------------------------------------------------------ */

interface PdfObject {
  value: PdfValue
  /** 有 stream 的对象才有；已经是**解码后**的字节（过了 Filter） */
  stream?: Buffer
}

interface PdfDoc {
  objects: Map<number, PdfObject>
  /** 从 trailer / xref 流的 /Root 找到的目录对象 */
  catalog?: PdfDict
  encrypted: boolean
}

/**
 * 扫全文件的 `N G obj`。
 *
 * 不用 xref 表：xref 有经典表、xref 流、增量更新三种写法，而它们又经常因为
 * "生成工具不规范"而不可信。直接顺序扫 `obj` 关键字最简单，也能扛住增量更新
 * （同一对象号后出现的覆盖先出现的，正是增量更新的语义）。
 */
function collectObjects(buf: Buffer): PdfDoc {
  const objects = new Map<number, PdfObject>()
  const text = buf.toString('latin1')
  const re = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1])
    const lexer = new PdfLexer(buf, m.index + m[0].length)
    let value: PdfValue
    try {
      value = lexer.readValue()
    } catch {
      continue
    }
    if (value === null) continue
    const obj: PdfObject = { value }
    if (isDict(value)) {
      lexer.skipWs()
      const rest = buf.toString('latin1', lexer.pos, Math.min(lexer.pos + 10, buf.length))
      if (rest.startsWith('stream')) {
        let start = lexer.pos + 'stream'.length
        if (buf[start] === 0x0d) start++
        if (buf[start] === 0x0a) start++
        const raw = readStreamBytes(buf, start, value)
        if (raw) {
          const decoded = decodeStream(value, raw.value)
          if (decoded.ok) obj.stream = decoded.data
          else obj.stream = undefined
        }
      }
    }
    objects.set(num, obj)
  }

  // 对象流（PDF 1.5+）：一批对象压在一个 stream 里
  const objStms: PdfObject[] = []
  for (const obj of objects.values()) {
    if (isDict(obj.value) && isName(obj.value.dict.get('Type')) && (obj.value.dict.get('Type') as PdfName).name === 'ObjStm' && obj.stream) {
      objStms.push(obj)
    }
  }
  for (const stm of objStms) expandObjectStream(stm, objects)

  const trailer = readTrailer(buf)
  let catalog: PdfDict | undefined
  if (trailer.rootNum !== null) {
    const root = objects.get(trailer.rootNum)?.value
    if (isDict(root)) catalog = root
  }
  if (!catalog) {
    // 没有经典 trailer（只有 xref 流的 PDF 就是这样）：按 /Type /Catalog 找
    for (const obj of objects.values()) {
      if (isDict(obj.value) && isName(obj.value.dict.get('Type')) && (obj.value.dict.get('Type') as PdfName).name === 'Catalog') {
        catalog = obj.value
        break
      }
    }
  }

  return { objects, catalog, encrypted: trailer.encrypted }
}

/** 取一个 stream 的原始字节：优先信 /Length，它不对就退回去找 endstream */
function readStreamBytes(buf: Buffer, start: number, dict: PdfDict): { value: Buffer } | null {
  const declared = dict.dict.get('Length')
  if (typeof declared === 'number' && declared >= 0 && start + declared <= buf.length) {
    const lexer = new PdfLexer(buf, start + declared)
    lexer.skipWs()
    if (buf.toString('latin1', lexer.pos, lexer.pos + 9) === 'endstream') {
      return { value: buf.subarray(start, start + declared) }
    }
  }
  const end = buf.indexOf('endstream', start, 'latin1')
  if (end < 0) return null
  let stop = end
  if (buf[stop - 1] === 0x0a) stop--
  if (buf[stop - 1] === 0x0d) stop--
  return { value: buf.subarray(start, Math.max(start, stop)) }
}

function expandObjectStream(stm: PdfObject, objects: Map<number, PdfObject>): void {
  const dict = stm.value as PdfDict
  const n = dict.dict.get('N')
  const first = dict.dict.get('First')
  if (typeof n !== 'number' || typeof first !== 'number') return
  const data = stm.stream!
  const header = new PdfLexer(data, 0)
  const pairs: Array<{ num: number; offset: number }> = []
  for (let i = 0; i < n; i++) {
    const objNum = header.readValue()
    const offset = header.readValue()
    if (typeof objNum !== 'number' || typeof offset !== 'number') break
    pairs.push({ num: objNum, offset })
  }
  for (const pair of pairs) {
    try {
      const value = new PdfLexer(data, first + pair.offset).readValue()
      if (value !== null && !objects.has(pair.num)) objects.set(pair.num, { value })
    } catch {
      /* 单个坏对象跳过 */
    }
  }
}

/** trailer 里只关心两件事：加密没加密、Catalog 是哪个 */
function readTrailer(buf: Buffer): { rootNum: number | null; encrypted: boolean } {
  const text = buf.toString('latin1')
  let encrypted = false
  let rootNum: number | null = null
  const re = /trailer\s*<</g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const lexer = new PdfLexer(buf, m.index + 'trailer'.length)
    const dict = lexer.readValue()
    if (!isDict(dict)) continue
    if (dict.dict.has('Encrypt')) encrypted = true
    const root = dict.dict.get('Root')
    if (isRef(root)) rootNum = root.num
  }
  return { rootNum, encrypted }
}

/* ------------------------------------------------------------------ *
 * 过滤器
 * ------------------------------------------------------------------ */

function decodeStream(dict: PdfDict, raw: Buffer): { ok: true; data: Buffer } | { ok: false; reason: string } {
  const filter = dict.dict.get('Filter')
  const names: string[] = []
  if (isName(filter)) names.push(filter.name)
  else if (Array.isArray(filter)) for (const f of filter) if (isName(f)) names.push(f.name)

  let data = raw
  for (const name of names) {
    if (name === 'FlateDecode' || name === 'Fl') {
      const inflated = inflate(data)
      if (!inflated) return { ok: false, reason: 'FlateDecode 解不开（多半是加密过的流）' }
      data = inflated
      const parms = dict.dict.get('DecodeParms')
      if (isDict(parms)) {
        const predictor = parms.dict.get('Predictor')
        if (typeof predictor === 'number' && predictor > 1) {
          const applied = unpredict(data, parms)
          if (!applied) return { ok: false, reason: '带预测器的压缩流解不开' }
          data = applied
        }
      }
      continue
    }
    if (name === 'ASCIIHexDecode' || name === 'AHx') {
      const hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '')
      data = Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, 'hex')
      continue
    }
    if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85(data)
      continue
    }
    if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLength(data)
      continue
    }
    return { ok: false, reason: `没用见过的压缩方式（${name}）` }
  }
  return { ok: true, data }
}

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data)
  } catch {
    /* 有的生成器写的是裸 deflate，没有 zlib 头 */
  }
  try {
    return inflateRawSync(data)
  } catch {
    return null
  }
}

/**
 * PNG / TIFF 预测器。主要出现在 xref 流里，偶尔也有内容流用它。
 * 每行开头一个字节说明这一行用哪种差分：0 无、1 Sub、2 Up、3 Average、4 Paeth。
 */
function unpredict(data: Buffer, parms: PdfDict): Buffer | null {
  const predictor = Number(parms.dict.get('Predictor') ?? 1)
  const colors = Number(parms.dict.get('Colors') ?? 1)
  const bpc = Number(parms.dict.get('BitsPerComponent') ?? 8)
  const columns = Number(parms.dict.get('Columns') ?? 1)
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.max(1, Math.ceil((columns * colors * bpc) / 8))

  if (predictor === 2) {
    if (bpc !== 8) return null
    const out = Buffer.from(data)
    for (let row = 0; row * rowLen < out.length; row++) {
      const base = row * rowLen
      for (let i = bytesPerPixel; i < rowLen && base + i < out.length; i++) {
        out[base + i] = (out[base + i] + out[base + i - bytesPerPixel]) & 0xff
      }
    }
    return out
  }
  if (predictor < 10) return data

  const out: number[] = []
  let prev = Buffer.alloc(rowLen)
  for (let pos = 0; pos < data.length; pos += rowLen + 1) {
    const type = data[pos]
    const row = Buffer.from(data.subarray(pos + 1, Math.min(pos + 1 + rowLen, data.length)))
    if (row.length < rowLen) break
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
      const up = prev[i]
      const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0
      switch (type) {
        case 1:
          row[i] = (row[i] + left) & 0xff
          break
        case 2:
          row[i] = (row[i] + up) & 0xff
          break
        case 3:
          row[i] = (row[i] + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          row[i] = (row[i] + pred) & 0xff
          break
        }
        default:
          break
      }
    }
    out.push(...row)
    prev = row
  }
  return Buffer.from(out)
}

function ascii85(data: Buffer): Buffer {
  const text = data.toString('latin1').replace(/^<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '')
  const out: number[] = []
  let group: number[] = []
  const flush = (): void => {
    const pad = 5 - group.length
    const tuple = [...group, ...Array(pad).fill(84)]
    let value = 0
    for (const digit of tuple) value = value * 85 + (digit - 33)
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, group.length - 1))
    group = []
  }
  for (const ch of text) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(ch.charCodeAt(0))
    if (group.length === 5) flush()
  }
  if (group.length > 1) flush()
  return Buffer.from(out)
}

function runLength(data: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < data.length; ) {
    const len = data[i++]
    if (len === 128) break
    if (len < 128) {
      for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++])
    } else {
      const byte = data[i++]
      for (let k = 0; k < 257 - len; k++) out.push(byte)
    }
  }
  return Buffer.from(out)
}

/* ------------------------------------------------------------------ *
 * ToUnicode / 字体
 * ------------------------------------------------------------------ */

interface CMap {
  /** 一个字符占几个字节：Identity-H 是 2，简单字体是 1 */
  width: number
  map: Map<number, string>
}

const HEX = /<([0-9a-fA-F\s]*)>/g

function hexToNumber(hex: string): number {
  return parseInt(hex.replace(/\s+/g, ''), 16) || 0
}

function hexToUtf16(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  const padded = clean.length % 4 === 0 ? clean : clean.padEnd(Math.ceil(clean.length / 4) * 4, '0')
  // PDF 的 ToUnicode 目标永远是 UTF-16BE，而 Node 只认 LE：逐对换一下
  const bytes = Buffer.from(padded, 'hex')
  bytes.swap16()
  return bytes.toString('utf16le')
}

/**
 * 解析一份 ToUnicode CMap。
 *
 * 只有两张表真正重要：`bfchar`（一个码对一个字）和 `bfrange`（一段码对一段字）。
 * `codespacerange` 决定一个码占几个字节——没有它就只能靠字体类型猜。
 */
function parseCMap(text: string): CMap {
  const map = new Map<number, string>()
  let width = 0

  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const hexes = [...block[1].matchAll(HEX)].map((h) => h[1].replace(/\s+/g, ''))
    if (hexes.length >= 1) width = Math.max(width, Math.ceil(hexes[0].length / 2))
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const tokens = [...block[1].matchAll(HEX)].map((h) => h[1].replace(/\s+/g, ''))
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      map.set(hexToNumber(tokens[i]), hexToUtf16(tokens[i + 1]))
      if (!width) width = Math.ceil(tokens[i].length / 2)
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]
    // 三种写法：<lo> <hi> <dst>  /  <lo> <hi> [<a> <b> …]  /  <lo> <hi> <dst> 的数组形式
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]+>)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const lo = hexToNumber(m[1])
      const hi = hexToNumber(m[2])
      if (!width) width = Math.ceil(m[1].length / 2)
      if (hi < lo || hi - lo > 0xffff) continue
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(HEX)].map((h) => h[1].replace(/\s+/g, ''))
        for (let i = 0; i <= hi - lo && i < items.length; i++) map.set(lo + i, hexToUtf16(items[i]))
      } else {
        const dstHex = m[3].replace(/[<>]/g, '')
        const base = hexToUtf16(dstHex)
        const head = base.slice(0, -1)
        const last = base.charCodeAt(base.length - 1)
        for (let i = 0; i <= hi - lo; i++) {
          map.set(lo + i, head + String.fromCharCode(last + i))
        }
      }
    }
  }

  return { width: width || 1, map }
}

/** 字体：把内容流里的字节还原成字 */
interface FontDecoder {
  width: number
  decode(bytes: Buffer): string
  /** 解不出来时的说法（null = 能解） */
  problem: string | null
}

/** cp1252 的 0x80–0x9F 那一段和 latin1 不一样，这是 PDF 简单字体最常见的编码 */
const CP1252_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
}

/** 字形名 → Unicode。只覆盖常见的那一批，认不得就当没有 */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', fi: 'fi', fl: 'fl',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', nbspace: ' ', periodcentered: '·'
}

function glyphToUnicode(name: string): string | null {
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name]
  if (/^[A-Za-z]$/.test(name)) return name
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name)
  if (uni) return String.fromCharCode(parseInt(uni[1], 16))
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (u) {
    const code = parseInt(u[1], 16)
    if (code <= 0x10ffff) return String.fromCodePoint(code)
  }
  return null
}

function cp1252(bytes: Buffer): string {
  let out = ''
  for (const byte of bytes) out += CP1252_HIGH[byte] ?? String.fromCharCode(byte)
  return out
}

/* ------------------------------------------------------------------ *
 * 读整份文档
 * ------------------------------------------------------------------ */

export interface PdfText {
  text: string
  /** 总页数 */
  pages: number
  /** 有文字层的页数。为 0 说明是扫描件 */
  pagesWithText: number
  /** 能读但读得不完整的地方，要跟着结论一起说出去 */
  warnings: string[]
}

class PdfReader {
  private readonly objects: Map<number, PdfObject>

  constructor(private readonly doc: PdfDoc) {
    this.objects = doc.objects
  }

  resolve(value: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (depth > 16 || !isRef(value)) return value
    return this.objects.get(value.num)?.value
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.resolve(value)
    return isDict(resolved) ? resolved : undefined
  }

  stream(value: PdfValue | undefined): Buffer | undefined {
    if (!isRef(value)) return undefined
    return this.objects.get(value.num)?.stream
  }

  /** 字体对象 → 解码器。这是整份代码里唯一"可能读不出来"的地方 */
  fontDecoder(fontValue: PdfValue | undefined, warnings: string[], seen: Set<string>): FontDecoder {
    const font = this.dict(fontValue)
    if (!font) return fixedDecoder(cp1252, 1, null)

    const subtype = isName(font.dict.get('Subtype')) ? (font.dict.get('Subtype') as PdfName).name : ''
    const baseFont = isName(font.dict.get('BaseFont')) ? (font.dict.get('BaseFont') as PdfName).name : ''

    // 有 ToUnicode 就用它：这是唯一可信的映射，跟字体类型无关
    const toUnicodeRef = font.dict.get('ToUnicode')
    const cmapBytes = this.stream(toUnicodeRef)
    if (cmapBytes) {
      const cmap = parseCMap(cmapBytes.toString('latin1'))
      if (cmap.map.size > 0) {
        return {
          width: cmap.width,
          problem: null,
          decode: (bytes) => decodeByCMap(bytes, cmap)
        }
      }
    }

    if (subtype === 'Type0') {
      // 中文 PDF 的常态：Identity-H（两字节字形号）但没有 ToUnicode → 还原不出字
      const key = baseFont || 'Type0'
      if (!seen.has(key)) {
        seen.add(key)
        warnings.push(`「${key}」这种字体没有 ToUnicode 表，里面的字还原不出来（那一部分会缺字）`)
      }
      return fixedDecoder(() => '', 2, '没有 ToUnicode 表')
    }

    // 简单字体：一个字节一个码。带 /Differences 时按字形名映射，否则按 cp1252
    const encoding = this.dict(font.dict.get('Encoding'))
    const differences = new Map<number, string>()
    const diffs = this.resolve(encoding?.dict.get('Differences'))
    if (Array.isArray(diffs)) {
      let code = 0
      for (const item of diffs) {
        if (typeof item === 'number') {
          code = item
          continue
        }
        if (isName(item)) {
          const ch = glyphToUnicode(item.name)
          if (ch !== null) differences.set(code, ch)
          code++
        }
      }
    }
    const baseEncoding = isName(encoding?.dict.get('BaseEncoding'))
      ? (encoding!.dict.get('BaseEncoding') as PdfName).name
      : ''
    const decoder = (bytes: Buffer): string => {
      let out = ''
      for (const byte of bytes) {
        const mapped = differences.get(byte)
        out += mapped ?? (baseEncoding === 'MacRomanEncoding' ? String.fromCharCode(byte) : cp1252(Buffer.from([byte])))
      }
      return out
    }
    return fixedDecoder(decoder, 1, null)
  }

  /** 内容流 → 文字 */
  pageText(content: Buffer, resources: PdfDict | undefined, warnings: string[], depth = 0): string {
    if (depth > 6) return ''
    const fontDict = this.dict(resources?.dict.get('Font'))
    const fonts = new Map<string, FontDecoder>()
    const seenFonts = new Set<string>()
    const getFont = (name: string): FontDecoder => {
      const cached = fonts.get(name)
      if (cached) return cached
      const decoder = this.fontDecoder(fontDict?.dict.get(name), warnings, seenFonts)
      fonts.set(name, decoder)
      return decoder
    }

    const xobjects = this.dict(resources?.dict.get('XObject'))
    const lines: string[] = []
    let line = ''
    let current: FontDecoder | null = null
    let lastY: number | null = null

    const newline = (): void => {
      if (line.trim()) lines.push(line.trim())
      line = ''
    }

    const show = (bytes: Buffer): void => {
      if (!current) current = getFont('')
      line += current.decode(bytes)
    }

    const lexer = new PdfLexer(content)
    const operands: PdfValue[] = []
    while (lexer.pos < content.length) {
      const before = lexer.pos
      const value = lexer.readValue()
      if (lexer.pos === before) {
        lexer.pos++
        continue
      }
      if (!isKeyword(value)) {
        operands.push(value)
        // 操作数越攒越多说明碰上了不认识的东西，别把内存吃掉
        if (operands.length > 64) operands.splice(0, operands.length - 32)
        continue
      }

      const op = value.keyword
      if (op === 'BI') {
        // 内联图片：整段跳过，绝不能把里面的二进制当操作数
        const end = content.indexOf('EI', lexer.pos, 'latin1')
        lexer.pos = end < 0 ? content.length : end + 2
        operands.length = 0
        continue
      }

      switch (op) {
        case 'Tf': {
          const name = operands.find(isName)
          if (name) current = getFont(name.name)
          break
        }
        case 'Td':
        case 'TD': {
          const ty = operands[operands.length - 1]
          if (typeof ty === 'number' && Math.abs(ty) > 0.5) newline()
          break
        }
        case 'Tm': {
          const ty = operands[operands.length - 1]
          if (typeof ty === 'number') {
            if (lastY !== null && Math.abs(ty - lastY) > 0.5) newline()
            lastY = ty
          }
          break
        }
        case 'T*':
          newline()
          break
        case 'Tj': {
          const str = [...operands].reverse().find(isString)
          if (str) show(str.bytes)
          break
        }
        case "'":
        case '"': {
          newline()
          const str = [...operands].reverse().find(isString)
          if (str) show(str.bytes)
          break
        }
        case 'TJ': {
          const arr = operands.find(Array.isArray)
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (isString(item)) show(item.bytes)
              // 数组里的数字是字距微调：负得多的那一下通常是词间空格
              else if (typeof item === 'number' && item < -100) line += ' '
            }
          }
          break
        }
        case 'Do': {
          const name = operands.find(isName)
          const xobj = name ? xobjects?.dict.get(name.name) : undefined
          const ref = isRef(xobj) ? xobj : undefined
          const xobjDict = this.dict(xobj)
          const isForm = isName(xobjDict?.dict.get('Subtype')) && (xobjDict!.dict.get('Subtype') as PdfName).name === 'Form'
          if (isForm && ref) {
            const inner = this.objects.get(ref.num)?.stream
            if (inner) {
              const innerResources = this.dict(xobjDict!.dict.get('Resources')) ?? resources
              const sub = this.pageText(inner, innerResources, warnings, depth + 1)
              if (sub.trim()) {
                newline()
                lines.push(sub.trim())
              }
            }
          }
          break
        }
        default:
          break
      }
      operands.length = 0
    }
    newline()
    return lines.join('\n')
  }

  pages(): Array<{ dict: PdfDict; resources?: PdfDict }> {
    const out: Array<{ dict: PdfDict; resources?: PdfDict }> = []
    const visited = new Set<number>()

    const walk = (value: PdfValue | undefined, inherited: PdfDict | undefined, depth: number): void => {
      if (depth > 32) return
      const ref = isRef(value) ? value : undefined
      if (ref) {
        if (visited.has(ref.num)) return
        visited.add(ref.num)
      }
      const node = this.dict(value)
      if (!node) return
      const type = isName(node.dict.get('Type')) ? (node.dict.get('Type') as PdfName).name : ''
      const ownResources = this.dict(node.dict.get('Resources')) ?? inherited
      if (type === 'Pages') {
        const kids = this.resolve(node.dict.get('Kids'))
        if (Array.isArray(kids)) for (const kid of kids) walk(kid, ownResources, depth + 1)
        return
      }
      if (type === 'Page') {
        out.push({ dict: node, resources: ownResources })
        return
      }
      // 没写 /Type 但有 /Contents 的，也当一页
      if (node.dict.has('Contents')) out.push({ dict: node, resources: ownResources })
    }

    const catalog = this.doc.catalog
    if (catalog) walk(catalog.dict.get('Pages'), undefined, 0)
    if (out.length === 0) {
      // 页面树坏了：退回到"按对象号扫所有 /Type /Page"，顺序可能不准但比什么都没有强
      for (const num of [...this.objects.keys()].sort((a, b) => a - b)) {
        walk({ num, gen: 0 }, undefined, 0)
      }
    }
    return out
  }
}

function fixedDecoder(decode: (bytes: Buffer) => string, width: number, problem: string | null): FontDecoder {
  return { width, decode, problem }
}

function decodeByCMap(bytes: Buffer, cmap: CMap): string {
  const width = cmap.width
  let out = ''
  for (let i = 0; i + width <= bytes.length; i += width) {
    let code = 0
    for (let k = 0; k < width; k++) code = (code << 8) | bytes[i + k]
    out += cmap.map.get(code) ?? ''
  }
  return out
}

/** 收一下空白：PDF 的换行是排版换行，不是段落，别留一堆空洞 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 读一份 PDF 的文字层。读不出来就抛错，由调用方翻成"读不了，可以帮你打开看"。
 */
export function pdfText(buffer: Buffer): PdfText {
  // 找不到 obj 就可能根本不是 PDF，也可能是被别的格式改了后缀
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF')) {
    throw new Error('这不像是一份 PDF（文件头里没有 %PDF 标记）')
  }
  const doc = collectObjects(buffer)
  if (doc.encrypted) throw new Error('这份 PDF 是加密的（需要密码才能打开），里面的字读不了')

  const reader = new PdfReader(doc)
  const pages = reader.pages()
  if (pages.length === 0) throw new Error('这份 PDF 里没找到任何页面，可能已经损坏')

  const warnings: string[] = []
  const blocks: string[] = []
  let pagesWithText = 0

  for (const [index, page] of pages.entries()) {
    const contents = page.dict.dict.get('Contents')
    const parts: Buffer[] = []
    const collect = (v: PdfValue | undefined): void => {
      if (isRef(v)) {
        const s = reader.stream(v)
        if (s) parts.push(s)
        return
      }
      const resolved = reader.resolve(v)
      if (Array.isArray(resolved)) for (const item of resolved) collect(item)
    }
    collect(contents)
    if (parts.length === 0) continue

    let text = ''
    try {
      text = reader.pageText(Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')])), page.resources, warnings)
    } catch (err) {
      warnings.push(`第 ${index + 1} 页读不动：${err instanceof Error ? err.message : String(err)}`)
    }
    text = tidy(text)
    if (text) {
      pagesWithText++
      blocks.push(pages.length > 1 ? `[第 ${index + 1} 页]\n${text}` : text)
    }
  }

  if (pagesWithText === 0) {
    // 「有内容流但一个字都没解出来」和「这页本来就没字」是两回事：
    // 前者多半是字体还原不了，后者才是扫描件。分开说，别把原因弄错。
    if (warnings.length > 0) {
      throw new Error(`这份 PDF 里的字还原不出来：${warnings.join('；')}。要看内容只能打开它自己看`)
    }
    throw new Error(
      '这份 PDF 里没有文字层（多半是扫描件或整页图片）。读不出字来，要看内容只能打开它自己看'
    )
  }
  if (pagesWithText < pages.length) {
    warnings.push(`${pages.length} 页里有 ${pages.length - pagesWithText} 页没有文字层（多半是扫描件），结论只覆盖有字的那 ${pagesWithText} 页`)
  }

  return { text: tidy(blocks.join('\n\n')), pages: pages.length, pagesWithText, warnings }
}

/** 给调用方复用：知道了 warnings 之后要跟着结论一起说出去 */
export function pdfWarningsNote(warnings: string[]): string {
  return warnings.length === 0 ? '' : `；注意：${warnings.join('；')}`
}
