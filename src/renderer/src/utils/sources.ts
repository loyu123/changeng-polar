import type { Evidence } from '../../../shared/types'

/**
 * 来源列表太长时先截一半。
 *
 * 为什么要有上限：一条检索型回答带 10~15 条出处在实测里很常见，全展开会把整个
 * 对话挤上去，用户想看的那个结论反而要往上翻。而"收了 15 条"这件事本身有意义，
 * 所以不能悄悄砍掉——被截掉多少要写在按钮上，点一下就能看全。
 *
 * 三条规矩，都是踩过的：
 * 1. **截断只发生在展开之后**，不发生在收起状态：收起时只显示"来源 15 条"，一行。
 * 2. **本机证据排在最前，一定保住**：检索结果飘忽，但"我查了注册表"是这个工具
 *    最硬的证据；截断把本机那几条挤掉，等于把最可信的部分藏了。
 * 3. 剩下的按原顺序，不重排：出处顺序是模型引用的顺序，重排会让"第 3 条"变味。
 */

/** 展开后先显示几条。再多就折在按钮后面 */
export const SOURCE_PREVIEW = 6

export interface SourceView {
  /** 这次该显示哪几条 */
  shown: Evidence[]
  /** 折在按钮后面的条数；0 表示全都在 shown 里 */
  hidden: number
}

export function visibleSources(evidence: Evidence[], expandedAll: boolean, preview = SOURCE_PREVIEW): SourceView {
  if (expandedAll || evidence.length <= preview) return { shown: evidence, hidden: 0 }
  // 本机证据优先占位：它是这次回答里唯一"不是网上说的"那部分
  const local = evidence.filter((e) => e.type === 'local')
  const rest = evidence.filter((e) => e.type !== 'local')
  const shown = [...local, ...rest].slice(0, preview)
  // 还原成原顺序：上面的"本机优先"只用来决定谁入选，不用来改显示顺序
  const keep = new Set(shown.map((e) => e.id))
  const ordered = evidence.filter((e) => keep.has(e.id))
  return { shown: ordered, hidden: evidence.length - ordered.length }
}
