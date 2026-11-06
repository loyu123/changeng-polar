import type { ReactNode } from 'react'

/**
 * 气泡内 Markdown：只支持模型实际会用的三种——
 * **加粗**、`行内代码`、``` 围栏代码块，外加 - 列表。
 * 解析成 React 元素直出，不走 dangerouslySetInnerHTML，天然防注入。
 * 其余语法（标题、表格、链接）原样保留文字——模型被约束不写大标题，
 * 出现奇怪标记时宁可让人看见原文，也不猜错意思。
 */

/** 行内解析：**加粗** 与 `行内代码` */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|`([^`\n]+)`/g
  let last = 0
  let i = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) nodes.push(<b key={`${keyPrefix}b${i++}`}>{m[1]}</b>)
    else nodes.push(<code key={`${keyPrefix}c${i++}`} className="md-code">{m[2]}</code>)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let key = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const content = paragraph.join('\n')
    blocks.push(
      <div className="md-p" key={`p${key++}`}>
        {inline(content, `p${key}`)}
      </div>
    )
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 围栏代码块：开着就一直收到闭合为止；流式输出没等到闭合也照常渲染
    if (line.trimStart().startsWith('```')) {
      flushParagraph()
      const buf: string[] = []
      i += 1
      for (; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) buf.push(lines[i])
      blocks.push(
        <pre className="md-pre" key={`pre${key++}`}>
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      flushParagraph()
      // 连续的列表行归进同一个 <ul>
      const items: string[] = []
      for (; i < lines.length && /^\s*[-*•]\s+/.test(lines[i]); i++) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''))
      }
      i -= 1
      blocks.push(
        <ul className="md-ul" key={`ul${key++}`}>
          {items.map((item, j) => (
            <li key={j}>{inline(item, `li${key}-${j}`)}</li>
          ))}
        </ul>
      )
      continue
    }
    if (line.trim() === '') flushParagraph()
    else paragraph.push(line)
  }
  flushParagraph()

  return <>{blocks}</>
}
