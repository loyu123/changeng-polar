import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, plainText, splitTableRow, toSlides } from '../../src/main/node/markdown'

/**
 * Markdown 解析。
 *
 * 这一层是"模型写什么"和"Word/PPT 长什么样"之间的唯一翻译，所以两条都要测：
 * 认得出的结构要认得准，**认不出的要原样留着**——把 `*` 吃掉会让正文变样，
 * 而正文变样比多两个星号糟得多（用户看到的是一份内容错了的文档）。
 */

describe('parseInline', () => {
  it('粗体、斜体、行内代码各归各位', () => {
    expect(parseInline('前 **粗** 中 *斜* 后 `码`')).toEqual([
      { text: '前 ' },
      { text: '粗', bold: true },
      { text: ' 中 ' },
      { text: '斜', italic: true },
      { text: ' 后 ' },
      { text: '码', code: true }
    ])
  })

  it('粗体里套行内代码不会被拆坏', () => {
    expect(parseInline('**看这个 `x` 就行**')).toEqual([
      { text: '看这个 ', bold: true },
      { text: 'x', code: true, bold: true },
      { text: ' 就行', bold: true }
    ])
  })

  it('链接折成「文字（地址）」：链接要留，句子也要读得通', () => {
    expect(plainText('见 [官网](https://example.com/x)')).toBe('见 官网（https://example.com/x）')
  })

  it('只有地址没文字时留地址', () => {
    expect(plainText('[](https://example.com)')).toBe('https://example.com')
  })

  it('认不出的标记原样留着，不吞', () => {
    expect(plainText('价格是 3 * 4 * 5')).toBe('价格是 3 * 4 * 5')
    expect(plainText('未闭合的 **粗体')).toBe('未闭合的 **粗体')
  })

  it('转义字符按字面输出', () => {
    expect(plainText('\\*不是斜体\\*')).toBe('*不是斜体*')
  })
})

describe('parseMarkdown', () => {
  it('标题的级别就是 # 的个数', () => {
    expect(parseMarkdown('# 一\n### 三')).toEqual([
      { type: 'heading', level: 1, text: '一' },
      { type: 'heading', level: 3, text: '三' }
    ])
  })

  it('连续的列表行并成一个块，不然后面每项都会从 1 重新编号', () => {
    const blocks = parseMarkdown('- 甲\n- 乙\n- 丙')
    expect(blocks).toEqual([{ type: 'bullet', items: ['甲', '乙', '丙'] }])
  })

  it('有序列表按 marked 的写法认 1. 和 1)', () => {
    expect(parseMarkdown('1. 甲\n2) 乙')).toEqual([{ type: 'ordered', items: ['甲', '乙'] }])
  })

  it('代码块里的 # 和 - 不当标题、不当列表', () => {
    const blocks = parseMarkdown('```bash\n# 这是注释\n- 不是列表\ndf -h\n```')
    expect(blocks).toEqual([{ type: 'code', lang: 'bash', text: '# 这是注释\n- 不是列表\ndf -h' }])
  })

  it('没闭合的代码块一路吃到结尾，而不是把后面的正文当正文', () => {
    const blocks = parseMarkdown('```\n第一行\n第二行')
    expect(blocks).toEqual([{ type: 'code', lang: '', text: '第一行\n第二行' }])
  })

  it('表格要表头 + 分隔行才算，单独一行竖线还是普通段落', () => {
    expect(parseMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')).toEqual([
      { type: 'table', head: ['甲', '乙'], rows: [['1', '2']] }
    ])
    expect(parseMarkdown('甲 | 乙')[0]).toMatchObject({ type: 'paragraph' })
  })

  it('表格里转义的竖线不算分隔符', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('分隔线认 --- / *** / ___', () => {
    for (const line of ['---', '***', '___']) {
      expect(parseMarkdown(line)).toEqual([{ type: 'rule' }])
    }
  })

  it('段内的软换行并成一句（Markdown 里换行不换段）', () => {
    expect(parseMarkdown('第一句\n第二句')).toEqual([{ type: 'paragraph', text: '第一句 第二句' }])
  })

  it('引用块连续几行并成一段', () => {
    expect(parseMarkdown('> 甲\n> 乙')).toEqual([{ type: 'quote', text: '甲\n乙' }])
  })

  it('空文档解析出空块列表，不抛错', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })
})

describe('toSlides', () => {
  it('一级标题开新页，标题就是它', () => {
    const slides = toSlides(parseMarkdown('# 第一页\n内容\n# 第二页\n内容'))
    expect(slides.map((s) => s.title)).toEqual(['第一页', '第二页'])
  })

  it('二级标题不分页：它只是想在一页里分三段', () => {
    const slides = toSlides(parseMarkdown('# 一页\n## 甲\n内容\n## 乙\n内容'))
    expect(slides).toHaveLength(1)
    expect(slides[0]!.blocks.filter((b) => b.type === 'heading')).toHaveLength(2)
  })

  it('--- 也分页', () => {
    const slides = toSlides(parseMarkdown('内容甲\n---\n内容乙'))
    expect(slides).toHaveLength(2)
  })

  it('--- 紧跟着一级标题时不多造一页空白', () => {
    const slides = toSlides(parseMarkdown('# 甲\n内容\n---\n# 乙\n内容'))
    expect(slides.map((s) => s.title)).toEqual(['甲', '乙'])
  })

  it('整篇没有一级标题时只出一页，标题留空（由调用方兜底）', () => {
    const slides = toSlides(parseMarkdown('只有正文\n- 和要点'))
    expect(slides).toHaveLength(1)
    expect(slides[0]!.title).toBeNull()
  })
})
