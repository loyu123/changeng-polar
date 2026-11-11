import { parseMarkdown, parseInline, plainText, toSlides, type Block, type Span } from './markdown'
import { buildZip, type ZipEntryInput } from './zip-write'
import { escapeXml, stripControlChars } from './xml'

/**
 * 把 Markdown 写成一份 .pptx（基础版：标题 + 文字，没有主题装饰、没有动画）。
 *
 * 和 .docx 一样是 ZIP+XML，但包的结构复杂得多，而且**层级是强制的**：
 *
 *   ppt/presentation.xml         幻灯片清单、页面尺寸
 *   ppt/slideMasters/slideMaster1.xml   母版（配色映射、文字层级）
 *   ppt/slideLayouts/slideLayout1.xml   版式（这里用「空白」）
 *   ppt/slides/slideN.xml               每一页
 *   ppt/theme/theme1.xml                主题配色与字体
 *   ppt/presProps.xml / viewProps.xml / tableStyles.xml
 *
 * 为什么采用「空白版式 + 每页自己摆文本框」：
 * 走占位符（placeholder）那条路要母版、版式、页面三处的 `idx` 编号一一对上，
 * 对不上时 PowerPoint 会静默地把内容挪到别的地方，甚至提示"需要修复"。
 * 而我们这一轮要的就是稳定：空白版式下每页只放自己的文本框，没有任何继承关系，
 * 位置由代码算死。代价是以后要做"标题页/图文页"这类版式时得另写，
 * 但那是装饰的事，等真要做再补。
 *
 * 明确不做的（用户说了后期再加）：主题配色、图片、图表、切换效果、动画、备注页。
 */

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument'

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** 16:9 的页面尺寸（EMU）。4:3 是 9144000×6858000，这里按现代投影仪的比例 */
const SLIDE_CX = 12192000
const SLIDE_CY = 6858000

/** 文本框的位置与大小：左右各留 0.9 cm 出头的边距，标题在上、正文在下 */
const BOX_X = 838200
const BOX_CX = SLIDE_CX - BOX_X * 2
const TITLE_Y = 365125
const TITLE_CY = 1325563
const BODY_Y = 1825625
const BODY_CY = SLIDE_CY - BODY_Y - 457200

/**
 * 一页最多摆多少行正文。
 *
 * 上限不是为了"排版好看"，是为了**不让字溢出页面**：PowerPoint 不会报错，
 * 它只是把超出的部分画到幻灯片外面，用户打开看到的是一页挤爆的字。
 * 超过就分页，宁可多一页。
 *
 * 14 行是按正文区高 5 英寸（360pt）、正文 18pt、行距约 1.2 倍估出来的保守值——
 * 页内小标题是 24pt、还带段前距，实际能放的行数比这个再少一点。
 * 文本框里写了 `normAutofit`，真溢出来时 PowerPoint 会自己缩字号兜一层。
 */
const MAX_BODY_LINES = 14
const MAX_SLIDES = 100

interface Para {
  spans: Span[]
  /** 项目符号 / 编号的前缀，写进第一段 run 里（不用真正的列表级别：那要靠版式占位符） */
  prefix?: string
  size: number
  bold?: boolean
  color?: string
  /** 段前距 */
  spaceBefore?: number
}

const pPr = (before = 0, indent = 0): string =>
  before || indent
    ? `<a:pPr${indent ? ` marL="${indent}" indent="-${indent}"` : ''}>${before ? `<a:spcBef><a:spcPts val="${before * 100}"/></a:spcBef>` : ''}</a:pPr>`
    : '<a:pPr/>'

const runXml = (text: string, opts: { size: number; bold?: boolean; color?: string }): string => {
  const attrs = ['lang="zh-CN"', `sz="${opts.size}"`, opts.bold ? 'b="1"' : ''].filter(Boolean).join(' ')
  const fill = opts.color ? `<a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill>` : ''
  return `<a:r><a:rPr ${attrs}>${fill}<a:latin typeface="Calibri"/><a:ea typeface="等线"/></a:rPr><a:t>${escapeXml(stripControlChars(text))}</a:t></a:r>`
}

function paragraphXml(para: Para): string {
  const indent = para.prefix ? 285750 : 0
  const head = para.prefix ? runXml(para.prefix, { size: para.size, bold: para.bold, color: para.color }) : ''
  const body = para.spans
    .map((span) => runXml(span.text, { size: para.size, bold: para.bold || span.bold }))
    .join('')
  return `<a:p>${pPr(para.spaceBefore, indent)}${head}${body}</a:p>`
}

/** 一个文本框 */
function textBox(id: number, name: string, box: { x: number; y: number; cx: number; cy: number }, paras: Para[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${paras.map(paragraphXml).join('')}</p:txBody></p:sp>`
  )
}

/** 块 → 一页上的若干段。标题已经在 title 里，这里只处理正文 */
function blocksToParas(blocks: ReadonlyArray<Block>): Para[] {
  const paras: Para[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        // 页内小标题：比正文大一号、加粗、换主题色，和正文拉开层次
        const size = block.level === 2 ? 2400 : 2000
        paras.push({ spans: parseInline(block.text), size, bold: true, color: '1F3864', spaceBefore: 6 })
        break
      }
      case 'paragraph':
        paras.push({ spans: parseInline(block.text), size: 1800 })
        break
      case 'bullet':
        for (const item of block.items) paras.push({ spans: parseInline(item), size: 1800, prefix: '• ' })
        break
      case 'ordered':
        block.items.forEach((item, index) => {
          paras.push({ spans: parseInline(item), size: 1800, prefix: `${index + 1}. ` })
        })
        break
      case 'quote':
        paras.push({ spans: parseInline(block.text), size: 1600, color: '595959' })
        break
      case 'code':
        // 幻灯片上不适合贴大段代码：保留原文，但按行切开，字号调小
        for (const line of block.text.split('\n')) {
          paras.push({ spans: [{ text: line || ' ' }], size: 1400, prefix: '' })
        }
        break
      case 'table': {
        // 表格按"每行一句、字段用 | 隔开"摆。真表格要 graphicFrame + a:tbl，
        // 而这一轮只要"内容在页面上、看得懂"，不做它
        const header = block.head.join(' | ')
        if (header) paras.push({ spans: [{ text: header, bold: true }], size: 1600, bold: true })
        for (const row of block.rows) paras.push({ spans: [{ text: row.join(' | ') }], size: 1600 })
        break
      }
      case 'rule':
        break
    }
  }
  return paras
}

/**
 * 把一页的正文按行数上限切成几页：溢出的字会跑到幻灯片外面，PPT 不会提醒。
 *
 * 切点尽量落在**小标题之前**，而不是硬切在第 N 行：硬切会让续页从一句话的中间开始，
 * 比如"二、下季度计划"留在上一页、下面的编号项孤零零跑到下一页。找不到小标题
 * （整页都是要点）时才退回硬切。
 */
function splitParas(paras: ReadonlyArray<Para>): Para[][] {
  if (paras.length <= MAX_BODY_LINES) return [paras.slice()]

  const chunks: Para[][] = []
  let start = 0
  while (start < paras.length) {
    let end = Math.min(start + MAX_BODY_LINES, paras.length)
    if (end < paras.length) {
      // 从上限往回找一个"出现在段首的小标题"作为切点；找不到就按上限切
      for (let i = end; i > start + 1; i--) {
        const para = paras[i]
        if (para && para.bold && para.spaceBefore) {
          end = i
          break
        }
      }
    }
    chunks.push(paras.slice(start, end))
    start = end
  }
  return chunks
}

/**
 * 自动定字号：短页放大，长页缩小。
 *
 * 正文写死 18pt 的后果是"四条要点的页只占左上角三分之一、下面一片空白"——
 * 那不是简洁，是没排版。这里按页内实际字数估一遍行高，从大到小挑一个放得下的字号。
 * 估算刻意保守（中文按 1em、西文按 0.55em、行距 1.22），宁可小一号，也不让字跑出页面。
 */
const BODY_W_PT = Math.floor(BOX_CX / 12700)
const BODY_H_PT = Math.floor(BODY_CY / 12700)
const BASE_SIZE = 1800
/** 从大到小试；第一档不满足就退一档。上限 32pt：再大就比标题（40pt）没小多少了 */
const SIZE_STEPS = [3200, 2800, 2600, 2200, 2000, 1800, 1600, 1400, 1200] as const

const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

/** 一段文字的宽度，单位是"字号倍数"（1 = 一个汉字的宽度） */
function widthEm(text: string): number {
  let em = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    em += code > 0xffff || WIDE_CHAR.test(ch) ? 1 : 0.55
  }
  return em
}

function estimateHeight(paras: ReadonlyArray<Para>, factor: number): number {
  let total = 0
  for (const para of paras) {
    // para.size 是 1/100 磅，先换成磅再算行高
    const pt = (para.size * factor) / 100
    const text = (para.prefix ?? '') + para.spans.map((span) => span.text).join('')
    const usable = BODY_W_PT - (para.prefix ? 23 : 0)
    const lines = Math.max(1, Math.ceil((widthEm(text) * pt) / usable))
    total += lines * pt * 1.22 + (para.spaceBefore ?? 0) * factor
  }
  return total
}

/** 返回整页正文的缩放倍数；留 8% 余量给行距与字体度量误差 */
function fitFactor(paras: ReadonlyArray<Para>): number {
  for (const base of SIZE_STEPS) {
    const factor = base / BASE_SIZE
    if (estimateHeight(paras, factor) <= BODY_H_PT * 0.92) return factor
  }
  return SIZE_STEPS[SIZE_STEPS.length - 1] / BASE_SIZE
}

function fitSizes(paras: Para[]): Para[] {
  const factor = fitFactor(paras)
  if (factor === 1) return paras
  // sz 是 1/100 磅，取整到整磅，免得出现 1763 这种字号
  return paras.map((para) => ({ ...para, size: Math.max(800, Math.round((para.size * factor) / 100) * 100) }))
}

interface RenderedSlide {
  title: string
  paras: Para[]
}

export function renderSlides(markdown: string, fallbackTitle: string): RenderedSlide[] {
  const slides = toSlides(parseMarkdown(markdown))
  const rendered: RenderedSlide[] = []

  for (const slide of slides) {
    // 整篇没有一级标题时，靠 `---` 分出来的页没有自己的标题：第一页用文件名兜底，
    // 后面的页留空（不留"（续）"，那会让读者以为下面还有正题）
    const title = slide.title ?? (rendered.length === 0 ? fallbackTitle : '')
    const paras = blocksToParas(slide.blocks)
    const chunks = splitParas(paras)
    chunks.forEach((chunk, index) => {
      // 拆出来的续页标题加个「（续）」，不然连着几页同名，读者以为翻页没生效
      rendered.push({ title: index === 0 || !title ? title : `${title}（续）`, paras: fitSizes(chunk) })
    })
  }

  if (rendered.length === 0) rendered.push({ title: fallbackTitle, paras: [] })
  return rendered
}

function slideXml(slide: RenderedSlide): string {
  const shapes: string[] = []
  let id = 2
  if (slide.title.trim()) {
    shapes.push(
      textBox(
        id++,
        '标题',
        { x: BOX_X, y: TITLE_Y, cx: BOX_CX, cy: TITLE_CY },
        [{ spans: [{ text: slide.title }], size: 4000, bold: true }]
      )
    )
  }
  if (slide.paras.length > 0) {
    shapes.push(textBox(id++, '正文', { x: BOX_X, y: slide.title.trim() ? BODY_Y : TITLE_Y, cx: BOX_CX, cy: BODY_CY }, slide.paras))
  }

  return (
    `${XML_HEAD}<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  )
}

const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'

const SLIDE_MASTER = `${XML_HEAD}<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>
  <p:titleStyle><a:lvl1pPr><a:defRPr sz="4000" b="1"/></a:lvl1pPr></p:titleStyle>
  <p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
  <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>`

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="blank" preserve="1">
<p:cSld name="空白">${EMPTY_TREE}</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`

const THEME = `${XML_HEAD}<a:theme xmlns:a="${A}" name="长庚">
<a:themeElements>
<a:clrScheme name="长庚">
  <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
  <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2>
  <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
  <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
  <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
  <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
  <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
  <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
  <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="长庚">
  <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="等线"/><a:cs typeface=""/></a:majorFont>
  <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="等线"/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="长庚">
  <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
  <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
  <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
  <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`

const PRES_PROPS = `${XML_HEAD}<p:presentationPr xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"/>`

const VIEW_PROPS = `${XML_HEAD}<p:viewPr xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">
<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>
<p:gridSpacing cx="72008" cy="72008"/>
</p:viewPr>`

const TABLE_STYLES = `${XML_HEAD}<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`

export function buildPptx(markdown: string, title: string): { buffer: Buffer; slides: number; chars: number } {
  const rendered = renderSlides(markdown, title)
  if (rendered.length > MAX_SLIDES) {
    throw new Error(`这份内容会切成 ${rendered.length} 页，超过单份上限 ${MAX_SLIDES} 页；拆成几份再写`)
  }

  const slideIds = rendered.map((_, index) => 256 + index)
  // 关系编号：rId1 给母版，rId2..N+1 给各页，之后是主题与三个属性部件
  const firstSlideRid = 2
  const themeRid = firstSlideRid + rendered.length
  const presPropsRid = themeRid + 1
  const viewPropsRid = presPropsRid + 1
  const tableStylesRid = viewPropsRid + 1

  const presentation = `${XML_HEAD}<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${slideIds.map((id, index) => `<p:sldId id="${id}" r:id="rId${firstSlideRid + index}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`

  const presentationRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${rendered.map((_, index) => `<Relationship Id="rId${firstSlideRid + index}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${themeRid}" Type="${R}/theme" Target="theme/theme1.xml"/>
<Relationship Id="rId${presPropsRid}" Type="${R}/presProps" Target="presProps.xml"/>
<Relationship Id="rId${viewPropsRid}" Type="${R}/viewProps" Target="viewProps.xml"/>
<Relationship Id="rId${tableStylesRid}" Type="${R}/tableStyles" Target="tableStyles.xml"/>
</Relationships>`

  const masterRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/>
</Relationships>`

  const layoutRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`

  const slideRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`

  const slideOverrides = rendered
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="${CT}.presentationml.slide+xml"/>`
    )
    .join('\n')

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>
${slideOverrides}
<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>
<Override PartName="/ppt/presProps.xml" ContentType="${CT}.presentationml.presProps+xml"/>
<Override PartName="/ppt/viewProps.xml" ContentType="${CT}.presentationml.viewProps+xml"/>
<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.presentationml.tableStyles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>
</Types>`

  const rootRels = `${XML_HEAD}<Relationships xmlns="${PKG}">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title><dc:creator>长庚 POLAR</dc:creator><cp:lastModifiedBy>长庚 POLAR</cp:lastModifiedBy>
</cp:coreProperties>`

  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>长庚 POLAR</Application><Slides>${rendered.length}</Slides>
</Properties>`

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(app, 'utf8') },
    { name: 'ppt/presentation.xml', data: Buffer.from(presentation, 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from(presentationRels, 'utf8') },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: Buffer.from(SLIDE_MASTER, 'utf8') },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Buffer.from(masterRels, 'utf8') },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: Buffer.from(SLIDE_LAYOUT, 'utf8') },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Buffer.from(layoutRels, 'utf8') },
    { name: 'ppt/theme/theme1.xml', data: Buffer.from(THEME, 'utf8') },
    { name: 'ppt/presProps.xml', data: Buffer.from(PRES_PROPS, 'utf8') },
    { name: 'ppt/viewProps.xml', data: Buffer.from(VIEW_PROPS, 'utf8') },
    { name: 'ppt/tableStyles.xml', data: Buffer.from(TABLE_STYLES, 'utf8') },
    ...rendered.flatMap((slide, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data: Buffer.from(slideXml(slide), 'utf8') },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: Buffer.from(slideRels, 'utf8') }
    ])
  ]

  const chars = rendered.reduce(
    (sum, slide) =>
      sum +
      plainText(slide.title).length +
      slide.paras.reduce((p, para) => p + para.spans.reduce((s, span) => s + span.text.length, 0), 0),
    0
  )

  return { buffer: buildZip(entries), slides: rendered.length, chars }
}

/** 页数与标题：给工具回执用（模型据此说"写了几页"） */
export function pptxSummary(markdown: string, title: string): { slides: number; titles: string[] } {
  const rendered = renderSlides(markdown, title)
  return { slides: rendered.length, titles: rendered.map((s) => s.title) }
}
