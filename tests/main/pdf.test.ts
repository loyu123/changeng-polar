import { describe, expect, it } from 'vitest'
import { pdfText } from '../../src/main/node/pdf'
import {
  buildPdf,
  cidFont,
  SIMPLE_FONT,
  simplePdf,
  stream,
  toUnicodeStream
} from './pdf-fixture'

/**
 * PDF 的文字层。
 *
 * 每一份 PDF 都是这里现造的（见 pdf-fixture.ts），所以能精确地把
 * 「哪种编码」「有没有 ToUnicode」「压没压缩」拆开测。
 *
 * 最要紧的一条不是"能读"，而是**读不出来的时候要如实说读不出来**：
 * 中文 PDF 常常是 Identity-H 字形号，没有 ToUnicode 就还原不出字。
 * 那时候如果吐一串字形号出去，模型会拿它当内容总结——错的内容比没有更糟。
 */

const pdf = (text: string): ReturnType<typeof pdfText> => pdfText(Buffer.from(text, 'latin1'))

describe('PDF · 读得出字', () => {
  it('简单字体 + Tj：一行文字读出来', () => {
    const out = pdf(simplePdf('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET', SIMPLE_FONT))
    expect(out.text).toBe('Hello PDF')
    expect(out.pages).toBe(1)
    expect(out.pagesWithText).toBe(1)
  })

  it('TJ 里的字距微调：负得多的地方断开成空格', () => {
    const content = 'BT /F1 12 Tf 72 720 Td [(Hello) -300 (world)] TJ ET'
    expect(pdf(simplePdf(content, SIMPLE_FONT)).text).toBe('Hello world')
  })

  it('Td 换行：两行文字不会被粘成一行', () => {
    const content = 'BT /F1 12 Tf 72 720 Td (first line) Tj 0 -14 Td (second line) Tj ET'
    expect(pdf(simplePdf(content, SIMPLE_FONT)).text).toBe('first line\nsecond line')
  })

  it('压缩过的内容流照样能读（真实 PDF 都是压缩的）', () => {
    const out = pdf(simplePdf('BT /F1 12 Tf 72 720 Td (compressed body) Tj ET', SIMPLE_FONT, { flate: true }))
    expect(out.text).toBe('compressed body')
  })

  it('十六进制字符串也能读', () => {
    const content = 'BT /F1 12 Tf 72 720 Td <48656c6c6f> Tj ET'
    expect(pdf(simplePdf(content, SIMPLE_FONT)).text).toBe('Hello')
  })

  it('空格的转义与反斜杠都按规范解', () => {
    const content = 'BT /F1 12 Tf 72 720 Td (a\\(b\\)c) Tj ET'
    expect(pdf(simplePdf(content, SIMPLE_FONT)).text).toBe('a(b)c')
  })
})

describe('PDF · 中文（Identity-H + ToUnicode）', () => {
  const chinesePdf = (mappings: string, content: string): string =>
    buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      stream(content),
      cidFont(6),
      toUnicodeStream(mappings)
    ])

  it('bfchar：一个字对一个字', () => {
    const mappings = '2 beginbfchar\n<0001> <4F60>\n<0002> <597D>\nendbfchar'
    const out = pdf(chinesePdf(mappings, 'BT /F1 12 Tf 72 720 Td <00010002> Tj ET'))
    expect(out.text).toBe('你好')
  })

  it('bfrange：一段码对一段字（连着加的写法）', () => {
    // <0001> <0003> <4E00> → 一 丁 丂（U+4E00 起连着三个）
    const mappings = '1 beginbfrange\n<0001> <0003> <4E00>\nendbfrange'
    const out = pdf(chinesePdf(mappings, 'BT /F1 12 Tf 72 720 Td <000100020003> Tj ET'))
    expect(out.text).toBe('一丁丂')
  })

  it('bfrange 的数组写法', () => {
    const mappings = '1 beginbfrange\n<0001> <0002> [<4F60> <597D>]\nendbfrange'
    const out = pdf(chinesePdf(mappings, 'BT /F1 12 Tf 72 720 Td <00020001> Tj ET'))
    expect(out.text).toBe('好你')
  })

  it('映射表里没有的码不硬凑（宁可缺字，也不吐字形号）', () => {
    const mappings = '1 beginbfchar\n<0001> <4F60>\nendbfchar'
    const out = pdf(chinesePdf(mappings, 'BT /F1 12 Tf 72 720 Td <00010099> Tj ET'))
    expect(out.text).toBe('你')
  })
})

describe('PDF · 读不出字就说读不出', () => {
  it('扫描件（整页没有文字层）→ 抛错说没有文字层', () => {
    // 内容流里只有画图，没有一个文字操作符
    const content = 'q 100 0 0 100 0 0 cm /Im1 Do Q'
    expect(() => pdf(simplePdf(content, SIMPLE_FONT))).toThrow(/没有文字层/)
  })

  it('Type0 字体没有 ToUnicode → 抛错说还原不出来，而不是吐字形号', () => {
    const font = '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [] >>'
    const doc = simplePdf('BT /F1 12 Tf 72 720 Td <00010002> Tj ET', font)
    expect(() => pdf(doc)).toThrow(/还原不出来/)
  })

  it('加密的 PDF 直接说加密了，不去试密码', () => {
    const doc = buildPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [] /Count 0 >>'
      ],
      { encrypt: true }
    )
    expect(() => pdf(doc)).toThrow(/加密/)
  })

  it('根本不是 PDF（改了后缀）→ 说文件头不对', () => {
    expect(() => pdf('这只是一段普通文字')).toThrow(/%PDF/)
  })

  it('文件头像 PDF 但没有对象 → 说没找到页面，不假装读到空内容', () => {
    expect(() => pdf('%PDF-1.7\n什么对象都没有\n%%EOF')).toThrow(/没找到任何页面|损坏/)
  })
})

describe('PDF · 多页', () => {
  it('按页分开，每页带页码；没字的页不算进去', () => {
    const doc = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      stream('BT /F1 12 Tf 72 720 Td (page one) Tj ET'),
      SIMPLE_FONT,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
      stream('BT /F1 12 Tf 72 720 Td (page two) Tj ET')
    ])
    const out = pdf(doc)
    expect(out.pages).toBe(2)
    expect(out.text).toContain('[第 1 页]')
    expect(out.text).toContain('page one')
    expect(out.text).toContain('[第 2 页]')
    expect(out.text).toContain('page two')
  })

  it('其中一页没字：读得到的那页照读，但要说清少了几页', () => {
    const doc = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      stream('BT /F1 12 Tf 72 720 Td (only page with text) Tj ET'),
      SIMPLE_FONT,
      '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 7 0 R >>',
      stream('q 1 0 0 1 0 0 cm Q')
    ])
    const out = pdf(doc)
    expect(out.pages).toBe(2)
    expect(out.pagesWithText).toBe(1)
    expect(out.warnings.join()).toContain('没有文字层')
  })
})

describe('PDF · 内联图片不能混进文字里', () => {
  it('BI … EI 整段跳过', () => {
    const content =
      'BT /F1 12 Tf 72 720 Td (before) Tj ET ' +
      'BI /W 2 /H 2 /BPC 8 /CS /G ID \u0000\u0001\u0002\u0003 EI ' +
      'BT /F1 12 Tf 72 700 Td (after) Tj ET'
    const out = pdf(simplePdf(content, SIMPLE_FONT))
    expect(out.text).toBe('before\nafter')
  })
})
