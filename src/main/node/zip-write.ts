/**
 * 写 .docx / .pptx 用的最小 ZIP 打包器。
 *
 * 读那边（`office.ts` 的 `readZip`）是自己解中央目录的，写这边同理：仓库里没有 zip 依赖，
 * 为写两个文件引一个包，升级和攻击面都比这段代码大。压缩本身用 `node:zlib` 现成的
 * `deflateRawSync`——ZIP 的 deflate 就是裸 deflate，不带 zlib 头。
 *
 * 三件容易写错的事，这里都记着：
 * 1. **CRC32 必须算对**。Word/PowerPoint 打开时先校 CRC，算错就是"文件已损坏"，
 *    而报错里不会告诉你是哪一条出错。
 * 2. **`[Content_Types].xml` 必须在包里**（由调用方负责）。少了它 Office 直接拒绝打开。
 * 3. **时间戳写死成 1980-01-01**。这不是偷懒：同一份内容写两遍要得到同一串字节，
 *    sha256 才对得上，"回读核对"也才有意义；而且评测里 `--repeat` 量稳定性时，
 *    文件字节不许因为"隔了几秒钟"而变。
 *
 * 只做够用的事：不写 ZIP64、不写加密、不支持目录条目。条目名都是 ASCII。
 */

import { deflateRawSync } from 'node:zlib'

/** 固定时间戳：1980-01-01 00:00。DOS 日期位：日 0–4、月 5–8、年 9–15（相对 1980） */
const DOS_DATE = (1 << 5) | 1
const DOS_TIME = 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  /** 包里边条目的路径，用 `/` 分隔（`word/document.xml`） */
  name: string
  data: Buffer
}

/**
 * 打成一个 ZIP 包。
 *
 * 每条都做 deflate：OOXML 的 XML 压缩率通常在 10:1 以上，而不压缩的 13 MB 文档
 * 写出去要慢一大截。压完比原文件还大时（小条目会这样）退回 store——省不了空间
 * 还多一层解压，不如直接放。
 */
export function buildZip(entries: ReadonlyArray<ZipEntryInput>): Buffer {
  if (entries.length === 0) throw new Error('ZIP 里一条都没有，打不出空包')
  if (entries.length > 0xffff) throw new Error(`ZIP 条目太多（${entries.length} 条，上限 65535）`)

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const deflated = deflateRawSync(entry.data, { level: 9 })
    // 0 = 不压缩（store），8 = deflate
    const useDeflate = deflated.length < entry.data.length
    const body = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头
    local.writeUInt16LE(20, 4) // 解开它需要 2.0
    local.writeUInt16LE(0x0800, 6) // 位 11：名字是 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // 没有 extra 段
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录条目
    central.writeUInt16LE(20, 4) // 制作版本
    central.writeUInt16LE(20, 6) // 最低解开版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头的位置
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // 本磁盘号
  eocd.writeUInt16LE(0, 6) // 目录所在磁盘号
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 没有注释

  return Buffer.concat([...locals, centralBuf, eocd])
}
