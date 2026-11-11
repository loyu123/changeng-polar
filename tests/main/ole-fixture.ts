/**
 * 造最小的 OLE 容器和里面的 .doc / .xls 流，给读取器的测试用。
 *
 * 和 pdf-fixture 一个道理：仓库里没有 Office 依赖，机器上也不该有测试依赖的样本二进制；
 * 而"这份文件为什么读不出来"必须能靠测试复现，所以这里手写二进制。
 *
 * 容器按 v3 规格来（512 字节扇区）：小于 4096 字节的流塞进 mini 流，
 * 大流走普通扇区——两条路都有测试走到。
 */

const END = 0xfffffffe
const FREE = 0xffffffff
const FATSECT = 0xfffffffd
const SECTOR = 512
const MINI = 64
const CUTOFF = 4096

export interface OleStreamSpec {
  name: string
  data: Buffer
}

/** 把一组命名流装进一个 OLE 复合文档 */
export function buildOle(specs: OleStreamSpec[]): Buffer {
  // 1. 小于 4096 字节的流按 64 字节切块，拼成 mini 流，同时记 miniFAT 链
  const miniChunks: Buffer[] = []
  const miniFat: number[] = []
  const layout: Array<{ spec: OleStreamSpec; start: number; mini: boolean }> = []
  let cursor = 0
  for (const spec of specs) {
    if (spec.data.length >= CUTOFF || spec.data.length === 0) continue
    const count = Math.ceil(spec.data.length / MINI)
    for (let i = 0; i < count; i++) {
      const chunk = spec.data.subarray(i * MINI, (i + 1) * MINI)
      miniChunks.push(chunk.length === MINI ? chunk : Buffer.concat([chunk, Buffer.alloc(MINI - chunk.length)]))
      miniFat[cursor + i] = i === count - 1 ? END : cursor + i + 1
    }
    layout.push({ spec, start: cursor, mini: true })
    cursor += count
  }
  const miniStream = Buffer.concat(miniChunks)

  // 2. 排扇区：FAT → 目录 → miniFAT → mini 流 → 大流
  const dirCount = Math.ceil((1 + specs.length) * 128 / SECTOR)
  const miniFatCount = Math.ceil(miniFat.length * 4 / SECTOR)
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR)
  const bigSectors = specs
    .filter((s) => s.data.length >= CUTOFF)
    .map((s) => Math.ceil(s.data.length / SECTOR))
  const bigTotal = bigSectors.reduce((a, b) => a + b, 0)

  let fatSectors = 1
  while (fatSectors + dirCount + miniFatCount + miniStreamSectors + bigTotal > fatSectors * (SECTOR / 4)) {
    fatSectors++
  }
  const dirStart = fatSectors
  const miniFatStart = dirStart + dirCount
  const miniStreamStart = miniFatStart + miniFatCount

  const fat: number[] = []
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT
  const chainInto = (start: number, count: number): void => {
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1
  }
  chainInto(dirStart, dirCount)
  if (miniFatCount > 0) chainInto(miniFatStart, miniFatCount)
  if (miniStreamSectors > 0) chainInto(miniStreamStart, miniStreamSectors)

  let nextSector = miniStreamStart + miniStreamSectors
  for (const spec of specs) {
    if (spec.data.length < CUTOFF || spec.data.length === 0) continue
    const count = Math.ceil(spec.data.length / SECTOR)
    chainInto(nextSector, count)
    layout.push({ spec, start: nextSector, mini: false })
    nextSector += count
  }
  for (let i = 0; i < nextSector; i++) if (fat[i] === undefined) fat[i] = FREE

  // 3. 头
  const header = Buffer.alloc(SECTOR)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x003e, 24)
  header.writeUInt16LE(3, 26)
  header.writeUInt16LE(0xfffe, 28)
  header.writeUInt16LE(9, 30)
  header.writeUInt16LE(6, 32)
  header.writeUInt32LE(fatSectors, 44)
  header.writeUInt32LE(dirStart, 48)
  header.writeUInt32LE(CUTOFF, 56)
  header.writeUInt32LE(miniFatCount > 0 ? miniFatStart : END, 60)
  header.writeUInt32LE(miniFatCount, 64)
  header.writeUInt32LE(END, 68)
  header.writeUInt32LE(0, 72)
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREE, 76 + i * 4)

  const fatSectorData = Buffer.alloc(fatSectors * SECTOR)
  for (let i = 0; i < fatSectors * (SECTOR / 4); i++) fatSectorData.writeUInt32LE(fat[i] ?? FREE, i * 4)

  // 4. 目录
  const dirSectorData = Buffer.alloc(dirCount * SECTOR)
  const writeDir = (index: number, name: string, type: number, start: number, size: number, child: number): void => {
    const at = index * 128
    const nameBuf = Buffer.from(`${name}\u0000`, 'utf16le')
    nameBuf.copy(dirSectorData, at)
    dirSectorData.writeUInt16LE(nameBuf.length, at + 64)
    dirSectorData.writeUInt8(type, at + 66)
    dirSectorData.writeUInt8(1, at + 67)
    dirSectorData.writeUInt32LE(FREE, at + 68)
    dirSectorData.writeUInt32LE(FREE, at + 72)
    dirSectorData.writeUInt32LE(child, at + 76)
    dirSectorData.writeUInt32LE(start, at + 116)
    dirSectorData.writeUInt32LE(size, at + 120)
  }
  writeDir(0, 'Root Entry', 5, miniStreamSectors > 0 ? miniStreamStart : END, miniStream.length, specs.length)
  layout.forEach((item, index) => writeDir(index + 1, item.spec.name, 2, item.start, item.spec.data.length, FREE))

  const miniFatSectorData = Buffer.alloc(miniFatCount * SECTOR)
  for (let i = 0; i < miniFat.length; i++) miniFatSectorData.writeUInt32LE(miniFat[i], i * 4)

  const pad = (data: Buffer): Buffer => {
    const rest = data.length % SECTOR
    return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(SECTOR - rest)])
  }

  const bigStreamData = layout
    .filter((item) => !item.mini)
    .sort((a, b) => a.start - b.start)
    .map((item) => pad(item.spec.data))

  return Buffer.concat([
    header,
    fatSectorData,
    dirSectorData,
    miniFatSectorData,
    pad(miniStream),
    ...bigStreamData
  ])
}

/* ---------------- BIFF 记录 ---------------- */

export function rec(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(data.length, 2)
  return Buffer.concat([head, data])
}

export function u16(value: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value, 0)
  return buf
}

export function u32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value, 0)
  return buf
}

export function f64(value: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeDoubleLE(value, 0)
  return buf
}

const isWideText = (text: string): boolean => /[^\u0000-ÿ]/.test(text)

/** BIFF8 的 Unicode 字符串：u16 长度 + 选项字节 + 字符 */
export function xlString(text: string): Buffer {
  const wide = isWideText(text)
  return Buffer.concat([
    u16(text.length),
    Buffer.from([wide ? 1 : 0]),
    wide ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'latin1')
  ])
}

export interface XlsSheet {
  name: string
  body: Buffer[]
}

const BOF = 0x0809
const EOF = 0x000a

export function bofGlobals(): Buffer {
  return rec(BOF, Buffer.concat([u16(0x0600), u16(0x0005), Buffer.alloc(12)]))
}
export function bofSheet(): Buffer {
  return rec(BOF, Buffer.concat([u16(0x0600), u16(0x0010), Buffer.alloc(12)]))
}
export function eof(): Buffer {
  return rec(EOF, Buffer.alloc(0))
}

/** BOUNDSHEET：偏移(4) + 可见性(1) + 类型(1) + 名字长度(1) + 选项字节(1) + 名字 */
export function boundsheet(position: number, name: string): Buffer {
  const wide = isWideText(name)
  const nameBytes = wide ? Buffer.from(name, 'utf16le') : Buffer.from(name, 'latin1')
  return rec(0x0085, Buffer.concat([u32(position), Buffer.from([0, 0, name.length, wide ? 1 : 0]), nameBytes]))
}

/** LABELSST：行(2) + 列(2) + 属性(2) + 共享字符串下标(4) */
export function labelsst(row: number, col: number, sstIndex: number): Buffer {
  return rec(0x00fd, Buffer.concat([u16(row), u16(col), u16(0), u32(sstIndex)]))
}

/** NUMBER：行(2) + 列(2) + 属性(2) + double(8) */
export function numberCell(row: number, col: number, value: number): Buffer {
  return rec(0x0203, Buffer.concat([u16(row), u16(col), u16(0), f64(value)]))
}

/** RK：行(2) + 列(2) + 属性(2) + rk(4) */
export function rkCell(row: number, col: number, rk: number): Buffer {
  return rec(0x027e, Buffer.concat([u16(row), u16(col), u16(0), u32(rk >>> 0)]))
}

/** 打包一个 RK 值：整数右移两位，bit1 置位 */
export function rkInt(value: number): number {
  return ((value << 2) | 0x02) >>> 0
}

/**
 * 拼一个 Workbook 流。
 *
 * BOUNDSHEET 里存的是"这张表的 BOF 在流里的绝对偏移"，所以要先排好版再回填——
 * 写死偏移的测试看着更短，但改一下 SST 长度就会全线偏移，测出来的错不是真错。
 */
export function buildWorkbook(sheets: XlsSheet[], globalsExtra: Buffer[] = [], globalsBefore: Buffer[] = []): Buffer {
  const globalsOf = (positions: number[]): Buffer =>
    Buffer.concat([
      bofGlobals(),
      ...globalsBefore,
      ...sheets.map((sheet, i) => boundsheet(positions[i], sheet.name)),
      ...globalsExtra,
      eof()
    ])

  let offset = globalsOf(sheets.map(() => 0)).length
  const positions: number[] = []
  const bodies: Buffer[] = []
  for (const sheet of sheets) {
    const body = Buffer.concat([bofSheet(), ...sheet.body, eof()])
    positions.push(offset)
    bodies.push(body)
    offset += body.length
  }
  return Buffer.concat([globalsOf(positions), ...bodies])
}

/**
 * 一条 SST 记录 + 若干 CONTINUE。
 * `segments[0]` 是接在 8 字节表头后面的串数据，后面每段对应一条 CONTINUE 记录。
 */
export function sst(segments: Buffer[], unique: number, total = unique): Buffer[] {
  const head = Buffer.concat([u32(total), u32(unique)])
  return [rec(0x00fc, Buffer.concat([head, segments[0]])), ...segments.slice(1).map((seg) => rec(0x003c, seg))]
}

/* ---------------- .doc ---------------- */

/** UTF-16 片段 */
export function wideBody(text: string): Buffer {
  return Buffer.from(text, 'utf16le')
}

export interface DocOptions {
  /** true = 正文按单字节存（片段表里置 bit30），false = UTF-16 */
  compressed?: boolean
  /** 置 fEncrypted 位 */
  encrypted?: boolean
  /** 语言 ID，默认 0x0804（简体中文），传 0x0409 走英文 */
  lid?: number
  /** Word 95 及更早：不写片段表，正文就是 fcMin..fcMac */
  word95?: boolean
}

const TEXT_AT = 0x200

/**
 * 拼一份 .doc 文件（OLE 里两条流：WordDocument + 1Table）。
 *
 * @param body 正文的原始字节。单字节片段就是那些字节本身；UTF-16 片段是 UTF-16LE
 */
export function buildDocFile(body: Buffer, options: DocOptions = {}): Buffer {
  const compressed = options.compressed === true
  const chars = compressed ? body.length : Math.floor(body.length / 2)
  const wordDocument = Buffer.alloc(Math.max(TEXT_AT + body.length + 16, 0x400))
  wordDocument.writeUInt16LE(0xa5ec, 0)
  wordDocument.writeUInt16LE(options.word95 ? 71 : 193, 2)
  wordDocument.writeUInt16LE(options.lid ?? 0x0804, 6)
  // bit9 = fWhichTblStm（用 1Table）；bit8 = fEncrypted
  wordDocument.writeUInt16LE(0x0200 | (options.encrypted ? 0x0100 : 0), 0x0a)
  body.copy(wordDocument, TEXT_AT)
  // Word 95 的正文范围就在 FIB 的 fcMin/fcMac 上
  wordDocument.writeUInt32LE(TEXT_AT, 0x18)
  wordDocument.writeUInt32LE(TEXT_AT + body.length, 0x1c)

  let table = Buffer.alloc(16)
  if (!options.word95) {
    // 片段表：1 段。(n+1) 个字符位置 + 1 个 PCD
    const fc = compressed ? (((TEXT_AT * 2) | 0x40000000) >>> 0) : TEXT_AT
    const plc = Buffer.concat([u32(0), u32(chars), u16(0), u32(fc), u16(0)])
    const pcdt = Buffer.concat([Buffer.from([0x02]), u32(plc.length), plc])
    table = Buffer.concat([Buffer.alloc(16), pcdt])
    // CLX 放在 1Table 流的 16 字节处
    wordDocument.writeUInt32LE(16, 0x01a2)
    wordDocument.writeUInt32LE(pcdt.length, 0x01a6)
  } else {
    wordDocument.writeUInt32LE(0, 0x01a2)
    wordDocument.writeUInt32LE(0, 0x01a6)
  }

  return buildOle([
    { name: 'WordDocument', data: wordDocument },
    { name: '1Table', data: table }
  ])
}

/** 拼一份 .xls 文件 */
export function buildXlsFile(workbook: Buffer): Buffer {
  return buildOle([{ name: 'Workbook', data: workbook }])
}

/* ---------------- .ppt ---------------- */

/**
 * 一条 PPT 记录：2 字节（低 4 位版本、高 12 位 instance）+ 2 字节类型 + 4 字节长度。
 * `container` 置位时版本写成 0xF，长度是里面所有子记录拼起来的长度。
 */
export function pptRecord(type: number, instance: number, body: Buffer, container = false): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt16LE(((instance & 0x0fff) << 4) | (container ? 0x0f : 0x00), 0)
  head.writeUInt16LE(type, 2)
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

/** UTF-16 文本原子（中文都走这条） */
export const pptChars = (text: string): Buffer => pptRecord(4000, 0, Buffer.from(text, 'utf16le'))
/** 单字节文本原子（每个字节就是一个字符，不是代码页） */
export const pptBytes = (text: string): Buffer => pptRecord(4008, 0, Buffer.from(text, 'latin1'))
/** 文本头原子：instance 说明这是标题 / 正文 / 备注的文字 */
export const pptTextHeader = (kind = 0): Buffer => pptRecord(3999, 0, u32(kind))

/**
 * 分页表里的一条：`persistIdRef` 是这个对象的编号，后面靠持久化目录查它落在流里的哪。
 * 真实文件里这条是 20 字节（编号 + 标志 + 文字数 + 页号 + 保留），照抄长度。
 */
export const pptSlidePersist = (persistIdRef: number, slideId = 256): Buffer =>
  pptRecord(1011, 0, Buffer.concat([u32(persistIdRef), u32(0), u32(0), u32(slideId), u32(0)]))

/**
 * 文档容器里的「带文字的分页表」。
 *
 * 两种存法真实文件里都有，测试两条都要走到：
 * - 传 `pages` → 文字直接写在表里（老一点的 PowerPoint 这么存）
 * - 传 `persistIds` → 表里只有页的编号，文字在各自的页容器里（97–2003 常见）
 */
export function pptTextList(pages: string[][], instance = 0): Buffer {
  const body: Buffer[] = []
  pages.forEach((paragraphs, index) => {
    body.push(pptSlidePersist(index + 1))
    for (const text of paragraphs) {
      body.push(pptTextHeader(0))
      body.push(pptChars(text))
    }
  })
  return pptRecord(4080, instance, Buffer.concat(body), true)
}

/** 表里只放页的编号（文字在页容器里时用这个） */
export function pptIndexList(persistIds: number[], instance = 0): Buffer {
  return pptRecord(4080, instance, Buffer.concat(persistIds.map((id) => pptSlidePersist(id))), true)
}

/** 拼一个 PowerPoint 文档容器（顶层记录 1000，里面装着若干子记录） */
export function buildPptDocument(children: Buffer[]): Buffer {
  return pptRecord(1000, 0, Buffer.concat(children), true)
}

/** 一页（或一份备注）自己的容器：记录 1006 = 幻灯片，1008 = 备注 */
export function pptPageContainer(type: 1006 | 1008, paragraphs: string[]): Buffer {
  return pptRecord(type, 0, Buffer.concat(paragraphs.map((text) => Buffer.concat([pptTextHeader(0), pptChars(text)]))), true)
}

/** 持久化目录：把编号翻成流里的偏移 */
export function pptPersistDirectory(entries: Array<[persistId: number, offset: number]>): Buffer {
  const body: Buffer[] = []
  for (const [id, offset] of entries) body.push(u32(((1 << 20) | id) >>> 0), u32(offset))
  return pptRecord(6002, 0, Buffer.concat(body))
}

/** 保存记录：`offsetToCurrentEdit` 是下一段增量编辑的基准 */
export function pptUserEdit(offsetToCurrentEdit: number): Buffer {
  return pptRecord(4085, 0, Buffer.concat([u32(0), u16(0), u16(0), u32(0), u32(offsetToCurrentEdit)]))
}

/**
 * 拼一份 .ppt 文件（OLE 里一条 `PowerPoint Document` 流）。
 *
 * `parts` 按顺序拼成流；要造"文字在页容器里"的文件，得先算好每个容器在流里的偏移，
 * 所以这里接受一个回调：给它"算出偏移"的能力，由调用方把目录写进去。
 */
export function buildPptFile(parts: Buffer[] | ((at: (index: number) => number) => Buffer[])): Buffer {
  let resolved: Buffer[]
  if (typeof parts === 'function') {
    // 先按占位长度排一遍，拿到每段的偏移，再让调用方按真实偏移重排一次。
    // 目录里的偏移是 4 字节定长，所以第一次排出来的偏移就是最终的偏移。
    const probe = parts(() => 0)
    const offsets: number[] = []
    let cursor = 0
    for (const part of probe) {
      offsets.push(cursor)
      cursor += part.length
    }
    resolved = parts((index) => offsets[index])
  } else {
    resolved = parts
  }
  return buildOle([{ name: 'PowerPoint Document', data: Buffer.concat(resolved) }])
}
