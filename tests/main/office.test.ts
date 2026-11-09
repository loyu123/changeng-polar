import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { docxText, officeText, pptxText, readZip, xlsxText } from '../../src/main/node/office'

/**
 * 从 .docx/.xlsx/.pptx 里抠文字。
 *
 * 这三种都是 ZIP 包着几段 XML，所以这里自己造 ZIP 来测——不依赖机器上有没有
 * Office，也不需要往仓库里塞二进制样本。同一套造包逻辑在 gate-check 里也跑一遍，
 * 那边是走完整的工具链（read_file 穿过闸门）读一份造出来的 docx。
 */

/**
 * 造一个最小可用的 ZIP。
 *
 * CRC 留 0：读取器不校验它（校验得再准也修不好一个坏文件，反而会把
 * "能读"变成"读不了"）。这里的目的是喂给读取器，不是生成可分发的包。
 */
function buildZip(files: Record<string, string>, compressed = true): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const data = compressed ? deflateRawSync(raw) : raw
    const method = compressed ? 8 : 0
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, eocd])
}

describe('ZIP 读取器', () => {
  it('deflate 压缩的条目能解出来', () => {
    const zip = readZip(buildZip({ 'a.txt': '你好，世界' }))
    expect(zip.get('a.txt')?.toString('utf8')).toBe('你好，世界')
  })

  it('不压缩（存储）的条目也能解出来', () => {
    const zip = readZip(buildZip({ 'b.txt': '原样存着' }, false))
    expect(zip.get('b.txt')?.toString('utf8')).toBe('原样存着')
  })

  it('多个条目各自回到自己的名字下', () => {
    const zip = readZip(buildZip({ 'x/1.xml': 'one', 'y/2.xml': 'two' }))
    expect(zip.get('x/1.xml')?.toString('utf8')).toBe('one')
    expect(zip.get('y/2.xml')?.toString('utf8')).toBe('two')
    expect(zip.size).toBe(2)
  })

  it('不是 ZIP 就抛错，不猜', () => {
    expect(() => readZip(Buffer.from('这只是一段文字，根本不是压缩包'))).toThrow(/ZIP/)
  })
})

describe('Word（.docx）', () => {
  const docx = (body: string) =>
    buildZip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>`
    })

  it('段落之间断行，标签全部剥掉', () => {
    const text = docxText(readZip(docx('<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>')))
    expect(text).toBe('第一段\n第二段')
  })

  /** 表格里同一行的单元格应当挨在一起，不然读出来会像一堆散落的词 */
  it('表格单元格用制表符连起来', () => {
    const body = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>年龄</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    expect(docxText(readZip(docx(body)))).toBe('姓名\t年龄')
  })

  it('XML 实体还原成字符', () => {
    const text = docxText(readZip(docx('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p><w:p><w:r><w:t>2 &lt; 3</w:t></w:r></w:p>')))
    expect(text).toBe('a & b\n2 < 3')
  })

  it('没有正文就抛错（不是所有 docx 都能读）', () => {
    expect(() => docxText(readZip(buildZip({ 'other.xml': '<x/>' })))).toThrow()
  })
})

describe('Excel（.xlsx）', () => {
  const xlsx = (rows: string, shared: string[]) =>
    buildZip({
      'xl/workbook.xml': '<workbook/>',
      'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`
    })

  it('共享字符串 + 数字按行列还原', () => {
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>42</v></c><c r="B2"><v>7</v></c></row>'
    const text = xlsxText(readZip(xlsx(rows, ['姓名', '年龄'])))
    expect(text).toContain('姓名\t年龄')
    expect(text).toContain('42\t7')
  })

  it('内联文字（inlineStr）也能读', () => {
    const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>直接写的</t></is></c></row>'
    expect(xlsxText(readZip(xlsx(rows, [])))).toContain('直接写的')
  })

  it('整行都是空的就跳过，不留一堆空行', () => {
    const rows = '<row r="1"><c r="A1"><v></v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row>'
    const text = xlsxText(readZip(xlsx(rows, ['有内容'])))
    expect(text.trim().split('\n').filter((l) => !l.startsWith('['))).toEqual(['有内容'])
  })

  it('多张工作表按序号排好，各带标题', () => {
    const zip = buildZip({
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二张</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第一张</t></is></c></row></sheetData></worksheet>'
    })
    const text = xlsxText(readZip(zip))
    expect(text.indexOf('第一张')).toBeLessThan(text.indexOf('第二张'))
    expect(text).toContain('[工作表 1]')
  })

  it('没有工作表就抛错', () => {
    expect(() => xlsxText(readZip(buildZip({ 'xl/workbook.xml': '<workbook/>' })))).toThrow()
  })
})

describe('PowerPoint（.pptx）', () => {
  it('按页码顺序把每页文字分开', () => {
    const zip = buildZip({
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>'
    })
    const text = pptxText(readZip(zip))
    expect(text.indexOf('第一页')).toBeLessThan(text.indexOf('第二页'))
    // 按数字排，不是按字符串排：slide10 要排在 slide2 后面
    expect(text.indexOf('第二页')).toBeLessThan(text.indexOf('第十页'))
    expect(text).toContain('[第 1 页]')
  })
})

describe('统一入口 · 读不出字就说读不出', () => {
  it('文字被剥干净（只剩空段落）→ 抛错，而不是返回空串让模型去编', () => {
    const zip = buildZip({ 'word/document.xml': '<w:document><w:body><w:p></w:p></w:body></w:document>' })
    expect(() => officeText('docx', zip)).toThrow(/没有/)
  })
})
