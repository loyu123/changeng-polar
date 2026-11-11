import { deflateSync } from 'node:zlib'

/**
 * 造一份最小可用的 PDF，给 PDF 读取器的测试用。
 *
 * 手写而不是让某个库生成：一是仓库里没有 PDF 库（读取器也是自己写的），
 * 二是测试要能精确控制"这份 PDF 长什么样"——编码、ToUnicode、压缩方式
 * 都得能一个个单独摆出来，否则测不出问题在哪。
 *
 * 不写 xref 表：读取器本来就不看它（顺序扫 `obj` 更抗增量更新和坏表），
 * 这里补一张假的只会让人以为它是必需的。
 */
export function buildPdf(bodies: Array<string | Buffer>, options: { root?: number; encrypt?: boolean } = {}): string {
  let out = '%PDF-1.7\n'
  bodies.forEach((body, i) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
    out += `${i + 1} 0 obj\n${bytes.toString('latin1')}\nendobj\n`
  })
  const root = options.root ?? 1
  const encrypt = options.encrypt ? ' /Encrypt 9 0 R' : ''
  out += `trailer\n<< /Size ${bodies.length + 1} /Root ${root} 0 R${encrypt} >>\n%%EOF\n`
  return out
}

/** 一条内容流对象：`<< /Length N >> stream … endstream` */
export function stream(content: string, options: { flate?: boolean } = {}): Buffer {
  const data = options.flate ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length}${options.flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1')
  ])
}

/** 一份最简单的单页 PDF：一段文字 + 一个字体 */
export function simplePdf(content: string, font: string, options: { flate?: boolean } = {}): string {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream(content, options),
    font
  ])
}

/** 一个 cp1252 的简单字体 */
export const SIMPLE_FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

/** 一份 ToUnicode CMap 的流对象 */
export function toUnicodeStream(mappings: string): Buffer {
  return stream(`/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${mappings}
endcmap
end end`)
}

/** Identity-H（两字节字形号）的中文字体 */
export function cidFont(toUnicodeRef: number): string {
  return `<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [] /ToUnicode ${toUnicodeRef} 0 R >>`
}
