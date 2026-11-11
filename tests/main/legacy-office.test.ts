import { describe, expect, it } from 'vitest'
import { isOle, oleStream, readOle } from '../../src/main/node/ole'
import { docText, legacyOfficeText, xlsText } from '../../src/main/node/legacy-office'
import {
  buildDocFile,
  buildOle,
  buildWorkbook,
  buildXlsFile,
  eof,
  labelsst,
  numberCell,
  rec,
  rkCell,
  rkInt,
  sst,
  u16,
  u32,
  wideBody,
  xlString
} from './ole-fixture'

/**
 * 这些测试的重点不是"能读出来"，而是"读不出来的时候说的是实话"。
 *
 * 读一份文档最坏的结果不是报错，是读出一段看着像那么回事的错字，
 * 然后模型拿着它总结。所以每个拒绝路径都要断言消息里说了什么。
 */

const oleOf = (buffer: Buffer) => readOle(buffer)

describe('OLE 容器', () => {
  it('认得出文件头，非 OLE 一律拒绝', () => {
    expect(isOle(buildOle([{ name: 'A', data: Buffer.from('hi') }]))).toBe(true)
    expect(isOle(Buffer.from('PK\u0003\u0004 not ole'))).toBe(false)
    expect(isOle(Buffer.alloc(4))).toBe(false)
    expect(() => readOle(Buffer.from('随便什么东西'))).toThrow(/OLE/)
  })

  it('小的流从 mini 流里读，大的流走普通扇区，两条路都对', () => {
    const small = Buffer.from('小的流')
    const big = Buffer.alloc(9000)
    for (let i = 0; i < big.length; i++) big[i] = i % 251

    const file = oleOf(buildOle([
      { name: 'Small', data: small },
      { name: 'Big', data: big }
    ]))
    expect(oleStream(file, 'Small')?.equals(small)).toBe(true)
    expect(oleStream(file, 'Big')?.equals(big)).toBe(true)
  })

  it('按名字取流不分大小写，且不会让流的条数翻倍', () => {
    const file = oleOf(buildOle([{ name: 'Workbook', data: Buffer.from('x') }]))
    expect(file.streams.size).toBe(1)
    expect(oleStream(file, 'workbook')?.toString()).toBe('x')
    expect(oleStream(file, 'WORKBOOK')?.toString()).toBe('x')
    expect(oleStream(file, 'Book')).toBeUndefined()
  })

  it('目录条目里能看出流的名字和长度', () => {
    const file = oleOf(buildOle([{ name: 'WordDocument', data: Buffer.alloc(100, 7) }]))
    const entry = file.entries.find((e) => e.name === 'WordDocument')
    expect(entry?.type).toBe(2)
    expect(entry?.size).toBe(100)
  })
})

describe('.doc（Word 97 片段表）', () => {
  it('UTF-16 片段读得出中文正文', () => {
    const text = '关于三季度工作的说明\r第二段内容。'
    const file = oleOf(buildDocFile(wideBody(text)))
    const result = docText(file)
    expect(result.text).toContain('关于三季度工作的说明')
    expect(result.text).toContain('第二段内容。')
    // 段落符 \r 应该变成换行，而不是原样留在正文里
    expect(result.text).toContain('\n')
    expect(result.warnings).toEqual([])
  })

  it('单字节片段（bit30）也能读，位置要右移一位', () => {
    const file = oleOf(buildDocFile(Buffer.from('hello world', 'latin1'), { compressed: true }))
    expect(docText(file).text).toBe('hello world')
  })

  it('中文文档的单字节片段按 GB18030 解（D6D0 CEC4 = 中文）', () => {
    const body = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    const file = oleOf(buildDocFile(body, { compressed: true, lid: 0x0804 }))
    expect(docText(file).text).toBe('中文')
  })

  it('加密的 .doc 直接说加密了，不去试密码', () => {
    const file = oleOf(buildDocFile(wideBody('秘密'), { encrypted: true }))
    expect(() => docText(file)).toThrow(/加了密/)
  })

  it('没有 WordDocument 流 → 说这不是 Word 文档', () => {
    const file = oleOf(buildOle([{ name: 'Workbook', data: Buffer.alloc(600) }]))
    expect(() => docText(file)).toThrow(/没有正文流/)
  })

  it('文件头不对 → 说文件头不对', () => {
    const bogus = Buffer.alloc(0x400)
    bogus.writeUInt16LE(0x1234, 0)
    const file = oleOf(buildOle([{ name: 'WordDocument', data: bogus }]))
    expect(() => docText(file)).toThrow(/文件头不对/)
  })

  it('空文档的拒绝消息里要说清是几段、几个字，别让人以为解析器坏了', () => {
    // 片段表在，但字符数是 0
    const file = oleOf(buildDocFile(Buffer.alloc(0), { compressed: true }))
    expect(() => docText(file)).toThrow(/没有可提取的文字/)
    expect(() => docText(file)).toThrow(/1 段/)
    expect(() => docText(file)).toThrow(/0 个字符/)
  })

  it('Word 95 及更早（没有片段表）按 fcMin..fcMac 读，并提示这是老格式', () => {
    const file = oleOf(buildDocFile(Buffer.from('old word', 'latin1'), { compressed: true, word95: true }))
    const result = docText(file)
    expect(result.text).toBe('old word')
    expect(result.warnings.join()).toContain('Word 95')
  })

  it('去掉控制字符，但不把正文吃掉', () => {
    const file = oleOf(buildDocFile(wideBody('第一段\r\x07第二段\x01\x02')))
    const text = docText(file).text
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
    expect(text).not.toMatch(/[\x00-\x08]/)
  })
})

describe('.xls（BIFF8）', () => {
  const workbookOf = (sheets: Parameters<typeof buildWorkbook>[0], extra: Buffer[] = []): ReturnType<typeof readOle> =>
    oleOf(buildXlsFile(buildWorkbook(sheets, extra)))

  it('共享字符串和数字都读得出来，按工作表分块', () => {
    const sstRecords = sst([Buffer.concat([xlString('姓名'), xlString('张三')])], 2)
    const book = workbookOf(
      [
        {
          name: 'Sheet1',
          body: [labelsst(0, 0, 0), labelsst(0, 1, 1), numberCell(1, 0, 42), numberCell(1, 1, 3.5)]
        }
      ],
      sstRecords
    )
    const text = xlsText(book).text
    expect(text).toContain('[工作表 Sheet1]')
    expect(text).toContain('姓名\t张三')
    expect(text).toContain('42\t3.5')
  })

  it('工作表名用两字节字符时不会读成 "S\\0h\\0e"', () => {
    const book = workbookOf([{ name: '成绩表', body: [numberCell(0, 0, 1)] }])
    expect(xlsText(book).text).toContain('[工作表 成绩表]')
    expect(xlsText(book).text).not.toContain('\u0000')
  })

  it('RK 压缩数字：整数和带小数的都能还原', () => {
    const book = workbookOf([
      {
        name: 'S',
        body: [rkCell(0, 0, rkInt(7)), rkCell(0, 1, rkInt(-3))]
      }
    ])
    const first = xlsText(book).text.split('\n').find((l) => l.includes('\t')) ?? ''
    expect(first).toBe('7\t-3')
  })

  it('共享字符串跨 CONTINUE 时，断在字符中间也接得上', () => {
    // 第一条串 10 个字符，前 5 个在 SST 本体里，后 5 个在 CONTINUE 里；
    // CONTINUE 开头必须重新给一个选项字节（这里 bit0=0，单字节）
    const head = Buffer.concat([u32(2), u32(2)])
    const part1 = Buffer.concat([u16(10), Buffer.from([0]), Buffer.from('ABCDE', 'latin1')])
    const part2 = Buffer.concat([
      Buffer.from([0]),
      Buffer.from('FGHIJ', 'latin1'),
      xlString('XYZ')
    ])
    const sstRecords = [rec(0x00fc, Buffer.concat([head, part1])), rec(0x003c, part2)]
    const book = workbookOf([{ name: 'S', body: [labelsst(0, 0, 0), labelsst(0, 1, 1)] }], sstRecords)
    const text = xlsText(book).text
    expect(text).toContain('ABCDEFGHIJ')
    expect(text).toContain('XYZ')
  })

  it('多张表各归各的', () => {
    const sstRecords = sst([Buffer.concat([xlString('一月'), xlString('二月')])], 2)
    const book = workbookOf(
      [
        { name: '第一季度', body: [labelsst(0, 0, 0)] },
        { name: '第二季度', body: [labelsst(0, 0, 1)] }
      ],
      sstRecords
    )
    const text = xlsText(book).text
    expect(text).toContain('[工作表 第一季度]\n一月')
    expect(text).toContain('[工作表 第二季度]\n二月')
  })

  it('共享字符串取不到时数出来并提示，而不是悄悄少几万格', () => {
    const sstRecords = sst([xlString('只有一条')], 1)
    const book = workbookOf([{ name: 'S', body: [labelsst(0, 0, 0), labelsst(0, 1, 99)] }], sstRecords)
    const result = xlsText(book)
    expect(result.text).toContain('只有一条')
    expect(result.warnings.join()).toContain('1 个单元格')
  })

  it('没有 Workbook 流 → 说这不是 Excel 文件', () => {
    const file = oleOf(buildOle([{ name: 'WordDocument', data: Buffer.alloc(600) }]))
    expect(() => xlsText(file)).toThrow(/没有工作簿流/)
  })

  it('空工作簿如实说没有文字', () => {
    const book = workbookOf([{ name: 'S', body: [] }])
    expect(() => xlsText(book)).toThrow(/没有可提取的文字/)
  })

  it('只有 BOF/EOF 没有表时，说没有工作表', () => {
    const book = oleOf(buildXlsFile(Buffer.concat([rec(0x0809, Buffer.concat([u16(0x0600), u16(5), Buffer.alloc(12)])), eof()])))
    expect(() => xlsText(book)).toThrow(/没有工作表/)
  })

  it('代码页不是 936/1200/1252 时给出提示', () => {
    const book = workbookOf([{ name: 'S', body: [numberCell(0, 0, 1)] }], [rec(0x0042, u16(866))])
    expect(xlsText(book).warnings.join()).toContain('866')
  })
})

describe('统一入口', () => {
  it('不是 OLE 就直接拒绝，不往下猜', () => {
    expect(() => legacyOfficeText('doc', Buffer.from('PK\u0003\u0004'))).toThrow(/OLE/)
    expect(() => legacyOfficeText('xls', Buffer.alloc(1024))).toThrow(/OLE/)
  })

  it('后缀说是 .doc 但里面装的是工作簿 → 明确拒绝，而不是吐空字符串', () => {
    const xls = buildXlsFile(buildWorkbook([{ name: 'S', body: [numberCell(0, 0, 1)] }]))
    expect(() => legacyOfficeText('doc', xls)).toThrow(/没有正文流/)
  })
})
