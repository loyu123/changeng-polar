/**
 * 读 .doc / .xls 用的 OLE 复合文档容器（Compound File Binary，微软的老式"文件里的文件系统"）。
 *
 * 1997—2003 那一代的 Office 文件都是一个 OLE 容器，里面装着几个命名流：
 * Word 的正文在 `WordDocument` + `1Table`，Excel 的工作簿在 `Workbook`。
 * 所以要先能把容器拆开，才谈得上读里面的字。
 *
 * 为什么自己写：和 office.ts 一样——仓库里没有任何 Office 依赖，为读一份文档
 * 引一个包，换来的升级和攻击面比自己解这 200 行大。这个格式是公开且冻结的。
 *
 * 结构（都记在这里，省得每次回来看规范）：
 * - 前 512 字节是头：扇区大小、FAT 位置、目录位置、mini 流的位置
 * - 扇区大小一般是 512（v3）或 4096（v4）；扇区 N 从 `(N+1)*sectorSize` 开始
 * - FAT 是一条扇区链表；大流按 FAT 串起来，小于 4096 字节的流存在 mini 流里（另一条链）
 * - 目录是一段 128 字节一条的表，每条有名字、类型、起始扇区和长度
 */

const MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const END = 0xfffffffa
const MAX_CHAIN = 200_000

export function isOle(buffer: Buffer): boolean {
  return buffer.length >= 512 && buffer.subarray(0, 8).equals(MAGIC)
}

export interface OleEntry {
  name: string
  /** 0 = 空、1 = 存储（类似目录）、2 = 流、5 = 根 */
  type: number
  size: number
}

export interface OleFile {
  entries: OleEntry[]
  /** 流名 → 内容。目录里的存储（storage）不算 */
  streams: Map<string, Buffer>
}

export function readOle(buffer: Buffer): OleFile {
  if (!isOle(buffer)) throw new Error('这不是老式 Office 文件（找不到 OLE 文件头）')

  const sectorSize = 1 << buffer.readUInt16LE(30)
  const miniSize = 1 << buffer.readUInt16LE(32)
  if (sectorSize < 128 || sectorSize > 65536) throw new Error('OLE 文件头里的扇区大小不对，这份文件可能坏了')
  const numFatSectors = buffer.readUInt32LE(44)
  const firstDirSector = buffer.readUInt32LE(48)
  const miniCutoff = buffer.readUInt32LE(56)
  const firstMiniFat = buffer.readUInt32LE(60)
  const numMiniFat = buffer.readUInt32LE(64)
  const firstDifat = buffer.readUInt32LE(68)
  const numDifat = buffer.readUInt32LE(72)

  const readSector = (n: number): Buffer => {
    const start = (n + 1) * sectorSize
    if (start >= buffer.length || n >= END) return Buffer.alloc(0)
    return buffer.subarray(start, Math.min(start + sectorSize, buffer.length))
  }

  // DIFAT：FAT 扇区号都存在这里。头部自带 109 个，不够就再串若干 DIFAT 扇区
  const fatIds: number[] = []
  for (let i = 0; i < 109; i++) fatIds.push(buffer.readUInt32LE(76 + i * 4))
  let difat = firstDifat
  const perSector = sectorSize / 4
  for (let i = 0; i < numDifat && difat < END; i++) {
    const sector = readSector(difat)
    if (sector.length < sectorSize) break
    for (let k = 0; k < perSector - 1; k++) fatIds.push(sector.readUInt32LE(k * 4))
    difat = sector.readUInt32LE((perSector - 1) * 4)
  }
  const fat = Buffer.concat(
    fatIds
      .filter((id) => id < END)
      .slice(0, Math.max(numFatSectors, 0))
      .map(readSector)
  )

  const chain = (start: number, table: Buffer): number[] => {
    const ids: number[] = []
    let cur = start
    while (cur < END && ids.length < MAX_CHAIN) {
      ids.push(cur)
      const at = cur * 4
      if (at + 4 > table.length) break
      cur = table.readUInt32LE(at)
    }
    return ids
  }

  // 目录
  const dirData = Buffer.concat(chain(firstDirSector, fat).map(readSector))
  const entries: OleEntry[] = []
  const rawEntries: Array<{ entry: OleEntry; start: number; child: number; left: number; right: number }> = []
  for (let off = 0; off + 128 <= dirData.length; off += 128) {
    const nameLen = dirData.readUInt16LE(off + 64)
    const entry: OleEntry = {
      name: dirData.toString('utf16le', off, off + Math.max(0, Math.min(64, nameLen) - 2)),
      type: dirData.readUInt8(off + 66),
      size: dirData.readUInt32LE(off + 120)
    }
    entries.push(entry)
    rawEntries.push({
      entry,
      start: dirData.readUInt32LE(off + 116),
      child: dirData.readUInt32LE(off + 76),
      left: dirData.readUInt32LE(off + 68),
      right: dirData.readUInt32LE(off + 72)
    })
  }

  // mini 流：小于 4096 字节的流都塞在根条目这一条大流里，按 64 字节一块切
  const root = rawEntries.find((r) => r.entry.type === 5)
  const miniStream = root ? Buffer.concat(chain(root.start, fat).map(readSector)).subarray(0, root.entry.size) : Buffer.alloc(0)
  const miniFat = Buffer.concat(
    chain(firstMiniFat, fat)
      .slice(0, Math.max(numMiniFat, 0))
      .map(readSector)
  )

  const readMini = (start: number, size: number): Buffer => {
    const parts = chain(start, miniFat).map((id) =>
      miniStream.subarray(id * miniSize, Math.min((id + 1) * miniSize, miniStream.length))
    )
    return Buffer.concat(parts).subarray(0, size)
  }

  const readStream = (start: number, size: number): Buffer => {
    if (size === 0) return Buffer.alloc(0)
    if (size < miniCutoff) return readMini(start, size)
    return Buffer.concat(chain(start, fat).map(readSector)).subarray(0, size)
  }

  // 目录树是一棵红黑树，但从根往下按名字找流不如直接把所有条目都列了——
  // 要读的流只有那么几个，遍历一遍更不容易出错（树指针坏了也照样能读）
  const streams = new Map<string, Buffer>()
  for (const raw of rawEntries) {
    if (raw.entry.type !== 2 || streams.has(raw.entry.name)) continue
    streams.set(raw.entry.name, readStream(raw.start, raw.entry.size))
  }

  return { entries, streams }
}

/**
 * 按名字取流，大小写不敏感。
 *
 * 不把大小写两种键都塞进同一个 Map：那样 `streams.size` 会翻倍，
 * 谁要是拿它判断"这份文件里有几个流"就会得到错数。
 */
export function oleStream(file: OleFile, name: string): Buffer | undefined {
  const exact = file.streams.get(name)
  if (exact) return exact
  const lower = name.toLowerCase()
  for (const [key, value] of file.streams) if (key.toLowerCase() === lower) return value
  return undefined
}
