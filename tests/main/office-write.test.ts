import { describe, expect, it } from 'vitest'
import { buildDocx, countChars } from '../../src/main/node/docx'
import { buildPptx, pptxSummary, renderSlides } from '../../src/main/node/pptx'
import { officeText, readZip } from '../../src/main/node/office'
import { parseMarkdown } from '../../src/main/node/markdown'

/**
 * 写出 Office 文件。
 *
 * 断言的落点是"Office 会不会拒绝打开"，而不是"XML 好不好看"：
 * 少一个 `[Content_Types].xml`、关系编号对不上、XML 里混进一个 `&`，
 * Word/PowerPoint 的反应都是一句"文件已损坏"——而那句话不会告诉你是哪儿错了。
 * 所以这里逐项盯着那几处：包内必备部件、关系与清单一致、转义、以及能不能读回来。
 *
 * 附注：这些文件在真机 Word 16 / PowerPoint 16 里实测能直接打开（无修复提示），
 * 但那是人工验的，自动化测不了；这里能自动化锁住的是上面那些结构性前提。
 */

const MD = `# 季度小结

本季处理工单 **128** 件，其中 *紧急* 3 件。

## 主要工作

- 巡检 12 次
- 迁移 2 套

| 日期 | 问题 |
| --- | --- |
| 7-12 | 磁盘写满 |

> 备件库存在老化。

\`\`\`bash
df -h
\`\`\`

---

# 附：数据来源

工单系统导出。
`

const xmlOf = (buffer: Buffer, name: string): string => {
  const entry = readZip(buffer).get(name)
  if (!entry) throw new Error(`包里没有 ${name}`)
  return entry.toString('utf8')
}

describe('docx', () => {
  it('包里有 Word 打开所需的全部部件', () => {
    const names = [...readZip(buildDocx(MD, '季度小结').buffer).keys()]
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml',
      'docProps/app.xml'
    ]) {
      expect(names, `缺 ${required}`).toContain(required)
    }
  })

  it('正文用样式，不逐段写死字号（不然用户改「标题 1」的样式文档纹丝不动）', () => {
    const body = xmlOf(buildDocx(MD, '季度小结').buffer, 'word/document.xml')
    expect(body).toContain('<w:pStyle w:val="Title"/>')
    expect(body).toContain('<w:pStyle w:val="Heading2"/>')
    expect(body).toContain('<w:pStyle w:val="ListParagraph"/>')
  })

  it('列表用的是真编号定义（numId），不是往正文里塞「•」', () => {
    const built = buildDocx(MD, '季度小结')
    const body = xmlOf(built.buffer, 'word/document.xml')
    expect(body).toContain('<w:numId w:val="1"/>')
    expect(xmlOf(built.buffer, 'word/numbering.xml')).toContain('<w:num w:numId="1">')
    // 正文里不该出现手写圆点
    expect(body).not.toContain('• ')
  })

  it('表格是真的 Word 表格', () => {
    const body = xmlOf(buildDocx(MD, '季度小结').buffer, 'word/document.xml')
    expect(body).toContain('<w:tbl>')
    expect(body).toContain('<w:tblHeader/>')
    expect(body).toContain('7-12')
  })

  it('读回来能见到每一块正文', () => {
    const text = officeText('docx', buildDocx(MD, '季度小结').buffer)
    for (const piece of ['季度小结', '本季处理工单 128 件', '巡检 12 次', '磁盘写满', '备件库存在老化', 'df -h', '附：数据来源']) {
      expect(text, piece).toContain(piece)
    }
  })

  it('正文里的 & < > 被转义（一个裸 & 就够让 Word 报"文件已损坏"）', () => {
    const body = xmlOf(buildDocx('# 甲 & 乙 <b>\n\nAT&T', '甲').buffer, 'word/document.xml')
    expect(body).toContain('甲 &amp; 乙 &lt;b&gt;')
    expect(body).toContain('AT&amp;T')
    expect(body).not.toMatch(/甲 & 乙/)
  })

  it('控制字符被清掉，而不是原样写进 XML', () => {
    const built = buildDocx('# 标题\u0000\n\n正文\u0007', '标题')
    const body = xmlOf(built.buffer, 'word/document.xml')
    expect(body).not.toContain('\u0000')
    expect(body).not.toContain('\u0007')
    expect(officeText('docx', built.buffer)).toContain('标题')
  })

  it('空内容也产出能打开的文件（body 里至少一个段落）', () => {
    const built = buildDocx('', '空')
    expect(xmlOf(built.buffer, 'word/document.xml')).toContain('<w:p/>')
    expect(built.blocks).toBe(0)
  })

  it('同样的输入产出同样的字节（回读核对和稳定性测量都靠这个）', () => {
    const a = buildDocx(MD, '季度小结').buffer
    const b = buildDocx(MD, '季度小结').buffer
    expect(a.equals(b)).toBe(true)
  })

  it('字数只数落到文档里的字，不算 Markdown 记号', () => {
    const blocks = parseMarkdown('# 甲\n\n**粗**体')
    // "# 甲" 的 '#' 和 '**' 都不该算进去
    expect(countChars(blocks)).toBe(3)
  })
})

describe('pptx', () => {
  const built = () => buildPptx(MD, '季度小结')

  it('包里有 PowerPoint 打开所需的全部部件（母版 / 版式 / 主题都要在）', () => {
    const names = [...readZip(built().buffer).keys()]
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/presProps.xml',
      'ppt/viewProps.xml',
      'ppt/tableStyles.xml'
    ]) {
      expect(names, `缺 ${required}`).toContain(required)
    }
  })

  it('每一页在清单和内容类型里都登记了，关系编号也对得上', () => {
    const { buffer, slides } = built()
    const presentation = xmlOf(buffer, 'ppt/presentation.xml')
    const rels = xmlOf(buffer, 'ppt/_rels/presentation.xml.rels')
    const types = xmlOf(buffer, '[Content_Types].xml')

    for (let i = 1; i <= slides; i++) {
      expect(presentation, `清单缺第 ${i} 页`).toContain(`r:id="rId${i + 1}"`)
      expect(rels, `关系缺第 ${i} 页`).toContain(`Target="slides/slide${i}.xml"`)
      expect(types, `内容类型缺第 ${i} 页`).toContain(`/ppt/slides/slide${i}.xml`)
      expect(readZip(buffer).has(`ppt/slides/slide${i}.xml`)).toBe(true)
      expect(readZip(buffer).has(`ppt/slides/_rels/slide${i}.xml.rels`)).toBe(true)
    }
    // 母版是 rId1，主题在最后一页之后，两个编号不能撞
    expect(presentation).toContain('r:id="rId1"')
    expect(rels).toContain('Target="slideMasters/slideMaster1.xml"')
  })

  it('16:9 的页面尺寸', () => {
    expect(xmlOf(built().buffer, 'ppt/presentation.xml')).toContain('cx="12192000" cy="6858000"')
  })

  it('一级标题开新页，二级标题留在页内', () => {
    const slides = renderSlides(MD, '季度小结')
    expect(slides.map((s) => s.title)).toEqual(['季度小结', '附：数据来源'])
    // 第一页里带那个二级标题
    expect(slides[0]!.paras.some((p) => p.bold && p.spans[0]?.text === '主要工作')).toBe(true)
  })

  it('每页一个标题框 + 一个正文框，都不带占位符继承', () => {
    // 走占位符要母版/版式/页面三处 idx 对上，对不上 PowerPoint 会静默挪位置；
    // 这里锁住"空白版式 + 独立文本框"这条路，别被人改回去
    expect(xmlOf(built().buffer, 'ppt/slideLayouts/slideLayout1.xml')).toContain('type="blank"')
    const slide = xmlOf(built().buffer, 'ppt/slides/slide1.xml')
    expect(slide).toContain('txBox="1"')
    expect(slide).not.toContain('<p:ph ')
  })

  it('读回来能见到每一页的字', () => {
    const text = officeText('pptx', built().buffer)
    expect(text).toContain('[第 1 页]')
    expect(text).toContain('[第 2 页]')
    expect(text).toContain('巡检 12 次')
    expect(text).toContain('工单系统导出')
  })

  it('正文溢出时按小标题切开，不会让字跑到幻灯片外面', () => {
    const long = ['# 长页'].concat(Array.from({ length: 40 }, (_, i) => `- 要点 ${i + 1}`)).join('\n')
    const slides = renderSlides(long, '长页')
    expect(slides.length).toBeGreaterThan(1)
    expect(slides[0]!.title).toBe('长页')
    expect(slides[1]!.title).toBe('长页（续）')
    // 每页都在上限之内
    for (const slide of slides) expect(slide.paras.length).toBeLessThanOrEqual(14)
    // 一条都没丢
    const all = slides.flatMap((s) => s.paras.map((p) => p.spans.map((x) => x.text).join(''))).join('\n')
    for (let i = 1; i <= 40; i++) expect(all).toContain(`要点 ${i}`)
  })

  it('页数超上限时直接报错，而不是产出一份 200 页的文件', () => {
    const many = Array.from({ length: 120 }, (_, i) => `# 第 ${i + 1} 页`).join('\n')
    expect(() => buildPptx(many, '太长')).toThrow(/上限/)
  })

  it('正文按页内字数自动定字号：短页放大、长页缩小（不留半页空白）', () => {
    const short = renderSlides('# 短页\n\n- 一条\n- 两条', '短页')
    expect(short[0]!.paras[0]!.size).toBeGreaterThan(1800)
    // 14 条接近整行的中文：放到 20pt 就超过正文区的 360pt，只能留在 18pt
    const row = `- ${'这一条要点写得比较长'.repeat(4)}`
    const dense = Array.from({ length: 14 }, () => row).join('\n')
    const long = renderSlides(`# 长页\n${dense}`, '长页')
    expect(long[0]!.paras[0]!.size).toBeLessThanOrEqual(1800)
    // 字号是整磅，不能出现 1763 这种
    for (const slide of short.concat(long)) {
      for (const para of slide.paras) expect(para.size % 100).toBe(0)
    }
  })

  it('内容越多字号越小，不会反过来（否则就是溢出）', () => {
    const row = '这一条要点写得比较长，占掉一行的大半宽度。'
    const sizes = [2, 6, 10, 14].map((n) => {
      const body = Array.from({ length: n }, () => `- ${row}`).join('\n')
      return renderSlides(`# 测\n\n${body}`, '测')[0]!.paras[0]!.size
    })
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!)
    expect(sizes[0]!).toBeGreaterThan(sizes[sizes.length - 1]!)
  })

  it('整篇没有一级标题时用文件名兜底当标题', () => {
    const slides = renderSlides('只有正文\n- 和要点', '兜底标题')
    expect(slides).toHaveLength(1)
    expect(slides[0]!.title).toBe('兜底标题')
  })

  it('同样输入同样字节', () => {
    expect(buildPptx(MD, '季度小结').buffer.equals(buildPptx(MD, '季度小结').buffer)).toBe(true)
  })

  it('pptxSummary 与真实页数一致（回执上的"共 N 页"不能是估的）', () => {
    expect(pptxSummary(MD, '季度小结').slides).toBe(built().slides)
  })

  it('XML 里的 & 一样要转义', () => {
    const slide = xmlOf(buildPptx('# 甲 & 乙\n\nAT&T', '甲').buffer, 'ppt/slides/slide1.xml')
    expect(slide).toContain('甲 &amp; 乙')
    expect(slide).not.toMatch(/甲 & 乙/)
  })
})

describe('zip 里的 XML 都压过（否则大文档写出去要慢一大截）', () => {
  it('正文条目是 deflate 的，解回来一字不差', () => {
    const buffer = buildDocx(MD, '季度小结').buffer
    const entries = readZip(buffer)
    expect(entries.get('word/document.xml')!.length).toBeGreaterThan(100)
    // readZip 已经做过解压，这里对比原始包长度：压过才会明显小于解出来的总量
    const total = [...entries.values()].reduce((sum, b) => sum + b.length, 0)
    expect(buffer.length).toBeLessThan(total)
  })
})
