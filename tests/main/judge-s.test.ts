import { describe, expect, it } from 'vitest'
import { judge } from '../../scripts/judge'

/**
 * S 组（真实检索）的判定口径。
 *
 * 这一组存在的理由：整份用例集原先一条都不联网——B4 三条都写死
 * `searchProvider: "none"`，考的是断网降级。于是「36/36」从来没证明过
 * 真实检索能用，而报告里没有任何一处提示这件事。
 *
 * 判的是**行为**，不是事实：Zoom 现在到第几版会随时间变，判「内容正确」
 * 等于给用例定一个会过期的标准。这里只问三件事：真调了联网工具、
 * 真拿到了来源、调了工具却没来源时不能算过。
 */

const turn = (text: string, tools: string[] = [], evidence?: number) => ({
  text,
  tools: tools.map((name) => ({ name })),
  evidence: { length: evidence ?? tools.length },
  unsourced: (evidence ?? tools.length) === 0
})

const s = (text: string, tools: string[] = [], evidence?: number) => judge({ cat: 'S' }, turn(text, tools, evidence), [])

describe('S 真实检索', () => {
  it('调了 web_search 且拿到来源 → 过', () => {
    const r = s('查到了：Zoom 当前版本是 6.x。出处：Zoom 官方下载页。', ['web_search'], 6)
    expect(r.pass).toBe(true)
    expect(r.reason).toContain('6 条来源')
  })

  it('直接 web_fetch 打开官网也算真联网', () => {
    expect(s('打开官网看了，当前版本 6.x。', ['web_fetch'], 1).pass).toBe(true)
  })

  it('一次联网工具都没调 → 失败（不能凭记忆报答案）', () => {
    const r = s('Zoom 现在是 6.0 版本。', [])
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('没有调用任何联网工具')
  })

  it('调了工具但没拿到来源 → 失败，且理由指向"没拿到来源"而不是"没调用"', () => {
    const r = s('查了一下但没读到内容。', ['web_search'], 0)
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('没拿到任何来源')
  })

  it('检索源不可用、模型如实降级 → 仍记失败，但理由写明不是回答的问题', () => {
    // 这一组的考点是链路通不通。检索被限流时模型说"可能被限流了"是**正确行为**，
    // 但那条回答证明不了检索能用，所以不能因此判过——理由要说清楚，
    // 免得下次有人看到 FAIL 就去改提示词。
    const r = s('这次查不到，检索可能被限流了，过一会儿再试。', ['web_search'], 0)
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('检索源当时不可用')
    expect(r.reason).toContain('这一组测的就是链路通不通')
  })

  it('本地工具的证据不算数：调了非联网工具同样判失败', () => {
    // list_installed_apps 这类读注册表的工具不联网，它的"来源"证明不了检索链路。
    // 判据看的是「调没调联网工具」，不是「有没有任何工具调用」。
    expect(s('本机装了这些。', ['list_installed_apps'], 3).pass).toBe(false)
  })
})

describe('S 有来源但结论是查不到', () => {
  it('判过，但理由里标明「内容里没有这个答案」', () => {
    // S-2 有一轮就是这样：官网下载页和 release notes 都打开了（9 条来源），
    // 但抓回来只有导航。链路确实通了，所以算过；报告上若只写「9 条来源」，
    // 读的人会以为它答出了版本号——两种事实对"检索好不好用"的含义完全不同。
    const r = s('查不到确切版本号，说明一下经过：官网页面我都打开了，但没读到内容。', ['web_search', 'web_fetch'], 9)
    expect(r.pass).toBe(true)
    expect(r.reason).toContain('开头说的是「查不到」')
    expect(r.reason).toContain('链路通')
  })

  it('答出来了、只是某个细节没查到 → 不加那句标记', () => {
    // 这是实测踩到的误报：那一轮答出了 7.2.5（build 51704），
    // 末尾补了一句「更新日志页面动态加载，读不到正文，发布日期查不到」。
    // 全文匹配会把它标成"结论是查不到"，而它明明答出来了。
    const text =
      '结论：Zoom 官方下载接口显示，Windows 桌面客户端当前最新版为 7.2.5（build 51704）。\n' +
      '补充：更新日志页面由网页动态加载，我读不到正文，发布日期查不到。'
    const r = s(text, ['web_search', 'web_fetch'], 9)
    expect(r.pass).toBe(true)
    expect(r.reason).not.toContain('开头说的是「查不到」')
  })

  it('给出了结论的不加那句标记', () => {
    const r = s('网易公司出品，官网页脚写明。', ['web_search'], 3)
    expect(r.pass).toBe(true)
    expect(r.reason).not.toContain('开头说的是「查不到」')
  })
})
