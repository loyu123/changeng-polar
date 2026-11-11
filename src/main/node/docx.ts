import { parseMarkdown, parseInline, plainText, type Block, type Span } from './markdown'
import { buildZip, type ZipEntryInput } from './zip-write'
import { escapeXml, textXml } from './xml'

/**
 * 把 Markdown 写成一份 .docx。
 *
 * .docx 不是"Word 存的二进制"，它就是 **一个 ZIP 里装着几段 XML**，所以写它不需要
 * 装 Word，也不用拉起任何窗口——这和读那边（`office.ts`）是同一个道理，只是反过来。
 * 包的结构记在这里，省得改动时又要回头翻规范：
 *
 *   [Content_Types].xml          每种部件的 MIME；少了它 Word 直接拒绝打开
 *   _rels/.rels                  包级关系：谁是主文档
 *   word/document.xml            正文（本文件的主要产物）
 *   word/styles.xml              样式表：标题、正文、列表、引用、代码
 *   word/numbering.xml           列表编号定义（真项目符号，不是往正文里塞「•」）
 *   word/_rels/document.xml.rels 正文引用了哪些部件
 *   docProps/core.xml / app.xml  标题、作者、字数
 *
 * 三处刻意的克制：
 * 1. **段落用样式，不逐段写死字号**。写死的话用户在 Word 里改「标题 1」的样式，
 *    文档纹丝不动——那不是一份 Word 文档，只是一页截图。
 * 2. **不做页眉页脚、目录、批注、图片**。这些都要额外的部件和关系，
 *    而"基础能写"是这一轮的目标；要做也得先让它稳定。
 * 3. **字体写明中日韩（eastAsia）**。只写 ascii 字体时，中文在 Word 里会落到
 *    一个随系统而变的默认字体上，同一份文件在两台机器上长得不一样。
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** 一次最多切多少张表格：表格是二维的，超长的表几乎一定是模型写岔了 */
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLS = 20

/**
 * 一行文字 → 若干 run。
 *
 * `xml:space="preserve"` 是必须的：不加的话 Word 会把首尾空格吃掉，
 * 而代码块的缩进全靠空格。
 */
function runsToXml(spans: ReadonlyArray<Span>): string {
  return spans
    .map((span) => {
      const pieces: string[] = []
      if (span.bold) pieces.push('<w:b/>')
      if (span.italic) pieces.push('<w:i/>')
      if (span.code) pieces.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>')
      const rPr = pieces.length > 0 ? `<w:rPr>${pieces.join('')}</w:rPr>` : ''
      // 段落内的换行（引用里会有）用 <w:br/>，直接塞 \n 会被 Word 当成空格
      const body = textXml(span.text)
        .split('\n')
        .map((line) => `<w:t xml:space="preserve">${line}</w:t>`)
        .join('<w:br/>')
      return `<w:r>${rPr}${body}</w:r>`
    })
    .join('')
}

function paragraph(spans: ReadonlyArray<Span>, pPr = ''): string {
  const props = pPr ? `<w:pPr>${pPr}</w:pPr>` : ''
  return `<w:p>${props}${runsToXml(spans)}</w:p>`
}

function headingParagraph(level: number, text: string): string {
  // 只到三级：四级以后在 Word 里和正文字号差不多，模型也很少真的需要
  const style = `Heading${Math.min(Math.max(level, 1), 3)}`
  return paragraph(parseInline(text), `<w:pStyle w:val="${style}"/>`)
}

function listItems(items: ReadonlyArray<string>, ordered: boolean): string {
  const numId = ordered ? 2 : 1
  return items
    .map((item) =>
      paragraph(
        parseInline(item),
        `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`
      )
    )
    .join('')
}

function codeParagraphs(text: string): string {
  return text
    .split('\n')
    .map((line) => paragraph([{ text: line }], '<w:pStyle w:val="CodeBlock"/>'))
    .join('')
}

/**
 * 表格。列宽按列数均分整页宽度（A4 减去左右页边距后约 9650 twip），
 * 不做"按内容自适应"：那需要量字体宽度，而估算出来的列宽常常比不对齐更难看。
 */
function tableXml(head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 1)
  if (cols > MAX_TABLE_COLS) throw new Error(`表格有 ${cols} 列，超过上限 ${MAX_TABLE_COLS} 列`)
  const trimmed = rows.slice(0, MAX_TABLE_ROWS)
  const width = Math.floor(9650 / cols)
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`

  const cell = (text: string, bold: boolean): string => {
    const spans = parseInline(text).map((s) => (bold ? { ...s, bold: true } : s))
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraph(spans)}</w:tc>`
  }

  const headRow =
    head.length > 0
      ? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${Array.from({ length: cols }, (_, i) => cell(head[i] ?? '', true)).join('')}</w:tr>`
      : ''
  const bodyRows = trimmed
    .map((row) => `<w:tr>${Array.from({ length: cols }, (_, i) => cell(row[i] ?? '', false)).join('')}</w:tr>`)
    .join('')

  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9650" w:type="dxa"/></w:tblPr>${grid}${headRow}${bodyRows}</w:tbl>`
}

function blocksToXml(blocks: ReadonlyArray<Block>): string {
  const parts: string[] = []
  let titleDone = false

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        // 第一个一级标题做成封面标题（Title 样式）：一份文档开头就该是它
        if (block.level === 1 && !titleDone) {
          parts.push(paragraph(parseInline(block.text), '<w:pStyle w:val="Title"/>'))
          titleDone = true
        } else {
          parts.push(headingParagraph(block.level, block.text))
        }
        break
      }
      case 'paragraph':
        parts.push(paragraph(parseInline(block.text)))
        break
      case 'bullet':
        parts.push(listItems(block.items, false))
        break
      case 'ordered':
        parts.push(listItems(block.items, true))
        break
      case 'quote':
        parts.push(paragraph(parseInline(block.text), '<w:pStyle w:val="Quote"/>'))
        break
      case 'code':
        parts.push(codeParagraphs(block.text))
        break
      case 'rule':
        parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>')
        break
      case 'table':
        parts.push(tableXml(block.head, block.rows))
        // Word 要求表格后面紧跟一个段落，否则两张表会粘成一张
        parts.push('<w:p/>')
        break
    }
  }

  return parts.join('')
}

/** A4 纵向，页边距 1440 twip（1 英寸），和 Word 中文版默认一致 */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>' +
  '</w:sectPr>'

const STYLES = `${XML_HEAD}<w:styles xmlns:w="${W}">
<w:docDefaults>
  <w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="等线" w:cs="Calibri"/>
    <w:sz w:val="22"/><w:szCs w:val="22"/>
    <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
  </w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:jc w:val="left"/><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:after="80"/><w:ind w:left="420"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:ind w:left="420"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr></w:pPr>
  <w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>
  <w:tblPr><w:tblBorders>
    <w:top w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
  </w:tblBorders></w:tblPr>
  <w:tcPr><w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr></w:style>
</w:styles>`

/** 真项目符号：`numId=1` 圆点、`numId=2` 阿拉伯数字 */
const NUMBERING = `${XML_HEAD}<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>
    <w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>
    <w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

export interface OfficeBuildResult {
  buffer: Buffer
  /** 写进去之后能拿出来核对的字数（回执里报给人看） */
  chars: number
  /** 块数量，用于回执里说"写了几段" */
  blocks: number
}

/** 正文字数：只数真的要落到文档里的字，不算 Markdown 记号 */
export function countChars(blocks: ReadonlyArray<Block>): number {
  let total = 0
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') {
      total += plainText(block.text).length
    } else if (block.type === 'bullet' || block.type === 'ordered') {
      total += block.items.reduce((sum, item) => sum + plainText(item).length, 0)
    } else if (block.type === 'code') {
      total += block.text.length
    } else if (block.type === 'table') {
      total += [...block.head, ...block.rows.flat()].reduce((sum, cell) => sum + plainText(cell).length, 0)
    }
  }
  return total
}

export function buildDocx(markdown: string, title: string): OfficeBuildResult {
  const blocks = parseMarkdown(markdown)
  const body = blocksToXml(blocks)
  // 空文档也得有一个段落：只剩 sectPr 的 body 虽然合法，但 Word 里点一下都点不进正文
  const content = body || '<w:p/>'
  const safeTitle = textXml(title)

  const document = `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${content}${SECTION}</w:body></w:document>`

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

  const rootRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

  const docRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>
</Relationships>`

  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${safeTitle}</dc:title><dc:creator>长庚 POLAR</dc:creator><cp:lastModifiedBy>长庚 POLAR</cp:lastModifiedBy>
</cp:coreProperties>`

  const words = countChars(blocks)
  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>长庚 POLAR</Application><Words>${words}</Words><Characters>${words}</Characters>
</Properties>`

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(NUMBERING, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') }
  ]

  return { buffer: buildZip(entries), chars: words, blocks: blocks.length }
}
