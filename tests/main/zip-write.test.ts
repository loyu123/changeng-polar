import { describe, expect, it } from 'vitest'
import { buildZip, crc32 } from '../../src/main/node/zip-write'
import { readZip } from '../../src/main/node/office'

/**
 * ZIP 打包器。
 *
 * 这里锁的是"打出来的包别人解不乱"：自己解自己当然容易对，所以两件独立的事都要测——
 * CRC 算得对（错的 CRC 会让 Office 报"文件已损坏"，而且不说是哪一条），
 * 以及包能被**读取那边**（`office.ts` 的 readZip）原样解回来。
 */

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

describe('crc32', () => {
  it('和标准值一致（这几个是 ZIP/PNG 通用的参考值）', () => {
    expect(crc32(bytes(''))).toBe(0)
    expect(crc32(bytes('a'))).toBe(0xe8b7be43)
    expect(crc32(bytes('abc'))).toBe(0x352441c2)
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
  })
})

describe('buildZip', () => {
  it('打进去几条，就能解回来几条，内容一字不差', () => {
    const entries = [
      { name: '[Content_Types].xml', data: bytes('<Types/>') },
      { name: 'word/document.xml', data: bytes('<w:document>你好</w:document>') }
    ]
    const zip = buildZip(entries)
    const back = readZip(zip)
    expect([...back.keys()]).toEqual(['[Content_Types].xml', 'word/document.xml'])
    expect(back.get('word/document.xml')!.toString('utf8')).toBe('<w:document>你好</w:document>')
  })

  it('大条目也能原样解回来（走的是 deflate 那条路）', () => {
    // 重复内容压缩率很高：压完必须比原文短，才会走 deflate 分支
    const text = '<w:p>'.repeat(20_000)
    const zip = buildZip([{ name: 'word/document.xml', data: bytes(text) }])
    expect(zip.length).toBeLessThan(Buffer.byteLength(text) / 10)
    expect(readZip(zip).get('word/document.xml')!.toString('utf8')).toBe(text)
  })

  it('同样的内容打两遍，字节完全一样', () => {
    // 时间戳写死成 1980-01-01 就是为了这个：文件字节不该因为"隔了几秒"而变，
    // 否则 sha256 回读核对和评测里的稳定性测量都会莫名抖动
    const entries = [{ name: 'a.xml', data: bytes('<a/>') }]
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true)
  })

  it('一条都没有时直接报错，不产出空包', () => {
    expect(() => buildZip([])).toThrow(/一条都没有/)
  })

  it('中文文件名不乱码（条目名按 UTF-8 写）', () => {
    const zip = buildZip([{ name: '长庚/说明.xml', data: bytes('x') }])
    expect([...readZip(zip).keys()]).toEqual(['长庚/说明.xml'])
  })
})
