/**
 * 把模型给的 Markdown 正文解析成"块"，给 `docx.ts` / `pptx.ts` 用。
 *
 * 为什么让模型写 Markdown 而不是让它在参数里描述结构：Word 和 PowerPoint 需要的是
 * 层次（标题几级、哪些是要点），而模型最熟练、最省字、也最不容易出错的表达方式就是
 * Markdown。一个 `#` 就是一级标题，一行 `- ` 就是要点——它已经会这个了，
 * 不需要再教它一套 JSON 结构。
 *
 * 支持的子集（**只解析这些，其余当普通段落**，不做 HTML、不做嵌套列表）：
 *   `# 一到六级标题`、`- / * / + ` 无序列表、`1. ` 有序列表、`> ` 引用、
 *   ``` 代码块 ```、`---` 分隔线、`| a | b |` 表格、以及行内的 `**粗**` `*斜*` `` `码` ``
 *
 * 三个刻意的取舍，写在这里免得后来人以为是漏了：
 * 1. **不认 setext 标题**（文字下面一行 `===` 或 `---`）。`---` 在幻灯片里是分页符，
 *    这两种用法在 Markdown 里本来就有歧义，认了一边另一边就废了。
 * 2. **`[文字](链接)` 折成「文字（链接）」纯文本**。真超链接要在包里加关系文件和
 *    drawing 节点，为了一个链接不值当；而把 URL 丢掉更糟——用户会以为文档缺了东西。
 * 3. **嵌套列表拍平**。缩进两级以上按同一级排，宁可层次浅，也不做出一个
 *    还得靠编号定义去猜深度的东西。
 */

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'ordered'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'rule' }

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const BULLET_RE = /^\s*[-*+]\s+(.*)$/
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const FENCE_RE = /^\s{0,3}(```|~~~)\s*([^`\s]*)/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** 表格行拆成单元格。首尾的竖线要去掉，转义的 `\|` 不算分隔符 */
export function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let buffer = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      buffer += '|'
      i += 1
    } else if (ch === '|') {
      cells.push(buffer.trim())
      buffer = ''
    } else {
      buffer += ch
    }
  }
  cells.push(buffer.trim())
  return cells
}

/**
 * 行内解析。
 *
 * 一次扫过去、按出现顺序切，而不是对每种标记各跑一遍 replace：后者会让
 * `**加粗里的 `码`**` 这类嵌套先被一种规则吃掉，剩下的半截标记留在正文里。
 * 认不出来的标记原样留着——把 `*` 吃掉会让内容变样，而内容变样比多两个星号糟。
 */
export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let buffer = ''
  const flush = (extra: Partial<Span> = {}): void => {
    if (buffer) {
      spans.push({ text: buffer, ...extra })
      buffer = ''
    }
  }

  for (let i = 0; i < text.length; i++) {
    const rest = text.slice(i)
    // 行内代码：`x`（内容里不再解析任何标记）
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      flush()
      spans.push({ text: code[1]!, code: true })
      i += code[0].length - 1
      continue
    }
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (bold) {
      flush()
      for (const inner of parseInline(bold[2]!)) spans.push({ ...inner, bold: true })
      i += bold[0].length - 1
      continue
    }
    const italic = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (italic) {
      flush()
      for (const inner of parseInline(italic[2]!)) spans.push({ ...inner, italic: true })
      i += italic[0].length - 1
      continue
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      flush()
      // 文字和地址都留：只留文字等于把用户要的链接吞了，只留地址又读不成句
      const label = link[1]!.trim()
      const url = link[2]!.trim()
      buffer += label ? `${label}（${url}）` : url
      i += link[0].length - 1
      continue
    }
    const escape = /^\\([\\`*_{}[\]()#+\-.!|>])/.exec(rest)
    if (escape) {
      buffer += escape[1]!
      i += escape[0].length - 1
      continue
    }
    buffer += text[i]!
  }
  flush()
  return spans.length > 0 ? spans : [{ text }]
}

/** 只是把行内标记拿掉，用于"这句话在多长的地方显示"这类不需要格式的场景 */
export function plainText(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join('')
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // 空行只是分隔，不产出块
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const lang = fence[2] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!)
        i += 1
      }
      i += 1 // 跳过收尾的 ```（没闭合就一路吃到底，代码块本来就不该有别的含义）
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      i += 1
      continue
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    // 表格：先看当前行是不是表头，再看下一行是不是分隔行（| --- | --- |）
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)) {
      const head = splitTableRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitTableRow(lines[i]!))
        i += 1
      }
      blocks.push({ type: 'table', head, rows })
      continue
    }

    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      // 连续的列表行并成一个块：分开的话每一项都会重新从 1 开始编号
      const items: string[] = []
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]!)
        if (!m) break
        items.push(m[1]!.trim())
        i += 1
      }
      blocks.push({ type: 'bullet', items })
      continue
    }

    const ordered = ORDERED_RE.exec(line)
    if (ordered) {
      const items: string[] = []
      while (i < lines.length) {
        const m = ORDERED_RE.exec(lines[i]!)
        if (!m) break
        items.push(m[1]!.trim())
        i += 1
      }
      blocks.push({ type: 'ordered', items })
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      const parts: string[] = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]!)
        if (!m) break
        parts.push(m[1]!.trim())
        i += 1
      }
      blocks.push({ type: 'quote', text: parts.join('\n') })
      continue
    }

    // 普通段落：吃到空行或下一个块级标记为止（Markdown 里换行不换段，这里并成一句）
    const parts: string[] = []
    while (i < lines.length) {
      const current = lines[i]!
      if (
        !current.trim() ||
        HEADING_RE.test(current) ||
        RULE_RE.test(current) ||
        FENCE_RE.test(current) ||
        BULLET_RE.test(current) ||
        ORDERED_RE.test(current) ||
        QUOTE_RE.test(current)
      ) {
        break
      }
      parts.push(current.trim())
      i += 1
    }
    if (parts.length > 0) blocks.push({ type: 'paragraph', text: parts.join(' ') })
  }

  return blocks
}

export interface Slide {
  /** 这一页的标题；null = 整篇没有一级标题，只有内容 */
  title: string | null
  blocks: Block[]
}

/**
 * 从块里切幻灯片。
 *
 * 约定只有两条，写在工具描述里给模型看：
 * - `#` 一级标题 = 新的一页，标题就是它
 * - `---` 也能分页（Markdown 转幻灯片的通行写法）
 *
 * 二级及以下标题留在页内当小标题——把它也当分页符的话，"# 标题"下面跟三个
 * "## 小节"就会变成四页，而模型多半只是想在一页里分三段。
 */
export function toSlides(blocks: Block[]): Slide[] {
  const slides: Slide[] = []
  let current: Slide = { title: null, blocks: [] }

  const flush = (): void => {
    if (current.title !== null || current.blocks.length > 0) slides.push(current)
    current = { title: null, blocks: [] }
  }

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 1) {
      flush()
      current.title = block.text
      continue
    }
    // 分隔线就是分页。紧跟着的一级标题会自己 flush 一次，而空页压不出来，
    // 所以"先 --- 再 # 标题"不会多出一页空白
    if (block.type === 'rule') {
      flush()
      continue
    }
    current.blocks.push(block)
  }

  flush()
  return slides
}
