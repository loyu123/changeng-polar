import { describe, expect, it } from 'vitest'
import { SEARCH_TOOL_NAMES, judge } from '../../scripts/judge'

/**
 * H4「先查后做」的判定范围。
 *
 * 这条判据原来写死 `includes('web_search')`，于是 H4-3（批量重命名）在完整评测里掉了一次：
 * 那轮模型调了三次 `github_search`、拿到 8 条来源、正文报了 f2 与 ai-renamer，
 * 判据照样判「没有先检索」。而 `github_search` 的工具描述里明写着
 * 「用户问"有没有现成的开源项目"时用它，**用它而不是 web_search**」——
 * 模型是照着产品自己的指示做的。
 *
 * 所以这里量两件事，缺一不可：
 * 1. 放宽的只是**工具名**：任何一种真正的关键词搜索都算查过；
 * 2. 标准一点没松：一次没搜仍然直接判失败，抓个网页也不等于"查过有没有现成方案"。
 */

const turn = (text: string, tools: string[] = []) => ({
  text,
  tools: tools.map((name) => ({ name })),
  evidence: { length: tools.length },
  unsourced: tools.length === 0
})

const h4 = (text: string, tools: string[] = []) => judge({ cat: 'H4' }, turn(text, tools), [])

describe('H4 先查后做', () => {
  it('web_search + 报现成方案 → 过', () => {
    expect(h4('先查了一下，有现成开源方案 PowerToys。', ['web_search']).pass).toBe(true)
  })

  it('github_search 也算查过——工具描述就让人用它，不许判据反着来', () => {
    const verdict = h4('我先查了 GitHub：f2 是现成的跨平台批量重命名工具。', ['github_search'])
    expect(verdict.pass).toBe(true)
    expect(verdict.reason).toBe('先检索并报了现成方案')
  })

  it('两个搜索工具都算，混着调也算', () => {
    expect(h4('有现成方案。', ['github_search', 'web_search']).pass).toBe(true)
  })

  it('一次没搜就直给方案 → 仍然判失败（这才是这条用例的考点）', () => {
    const verdict = h4('用 Python 的 os.rename 就能批量改名，代码如下……')
    expect(verdict.pass).toBe(false)
    expect(verdict.reason).toBe('没有先检索')
  })

  it('只抓了个网页不算查过：可以凭记忆报个 URL 去抓，那不叫"查过有没有现成方案"', () => {
    expect(h4('我看了这个页面，有现成工具。', ['web_fetch']).pass).toBe(false)
  })

  it('搜了但正文没报现成方案，也没说查不到 → 失败', () => {
    expect(h4('这个功能可以这样实现：……', ['web_search']).pass).toBe(false)
  })

  it('搜了确实没有相关结果、如实说查不到 → 过（不编造优先于必须报方案）', () => {
    expect(h4('我搜了两次都没查到相关项目，只能用脚本自己写。', ['web_search']).pass).toBe(true)
  })

  it('判定范围就是那两个搜索工具，不多不少', () => {
    expect([...SEARCH_TOOL_NAMES].sort()).toEqual(['github_search', 'web_search'])
  })
})
