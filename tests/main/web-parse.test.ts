import { describe, expect, it } from 'vitest'
import { decodeEntities, stripTags } from '../../src/main/node/html'
import {
  bingSearchUrl,
  detectChallenge,
  diagnosePage,
  isCjkQuery,
  relevanceTokens,
  unwrapBing,
  unwrapDdg
} from '../../src/main/node/web'

/**
 * 检索链路的纯函数部分。
 *
 * 免费检索源（DDG / Bing）返回的是 HTML 壳子，地址还包了一层跳转：
 * 这里的解析错了，症状是"检索有结果但点开的是搜索引擎自己"。
 */
describe('检索结果解析', () => {
  it('解出 DuckDuckGo 的 uddg 跳转参数', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=xyz'
    expect(unwrapDdg(href)).toBe('https://example.com/page?a=1')
  })

  it('解出 Bing 的 base64 跳转参数', () => {
    const target = 'https://example.com/real'
    const b64 = Buffer.from(target, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const href = `/ck/a?u=a1${b64}&ntb=1`
    expect(unwrapBing(href)).toBe(target)
  })

  it('已经是直链的原样返回', () => {
    expect(unwrapDdg('https://example.com/x')).toBe('https://example.com/x')
  })

  it('协议相对地址补上 https', () => {
    expect(unwrapDdg('//example.com/x')).toBe('https://example.com/x')
  })

  it('垃圾输入不抛错', () => {
    expect(() => unwrapDdg('')).not.toThrow()
    expect(() => unwrapBing('/ck/a?u=a1!!!')).not.toThrow()
  })
})

describe('相关性词元', () => {
  it('中文切成二元组，拉丁词保留', () => {
    const tokens = relevanceTokens('微信 WeChat 官网')
    expect(tokens).toContain('wechat')
    expect(tokens).toContain('微信')
    // "官网"是到处都有的词，不该参与相关性判断
    expect(tokens).not.toContain('官网')
  })

  it('空检索词给出空词元表（调用方据此不做过滤）', () => {
    expect(relevanceTokens('')).toEqual([])
  })
})

describe('实体与标签清理在检索场景下的表现', () => {
  it('搜索结果标题里的高亮标签被剥掉', () => {
    expect(stripTags('<b>微信</b>&nbsp;官网')).toBe('微信 官网')
  })

  it('中文站点常见的命名实体正常还原', () => {
    expect(decodeEntities('&laquo;示例&raquo;')).toBe('&laquo;示例&raquo;')
  })
})

/**
 * 国内可用的那条路：抓 cn.bing.com。
 *
 * 换成 www.bing.com 会静默退化——那个实例从国内 IP 抓回来经常是一页与检索词
 * 毫无关系的结果（查 DeepSeek 返回 Windows 帮助页），而且状态码 200、解析也成功，
 * 从调用方完全看不出问题。所以把主机名钉在用例里。
 */
describe('Bing 抓取地址', () => {
  const url = (q: string): URL => new URL(bingSearchUrl(q))

  it('走 cn.bing.com，不走 www', () => {
    expect(url('微信').host).toBe('cn.bing.com')
    expect(bingSearchUrl('微信')).not.toContain('www.bing.com')
  })

  it('中文词用中文界面，西文词用英文界面', () => {
    expect(url('量子计算 最新进展').searchParams.get('setlang')).toBe('zh-Hans')
    expect(url('Electron 45 release notes').searchParams.get('setlang')).toBe('en')
  })

  it('不钉 ensearch（钉死了会让英文技术词被翻成中文再搜）', () => {
    expect(bingSearchUrl('Electron 45 release notes')).not.toContain('ensearch')
    expect(bingSearchUrl('量子计算')).not.toContain('ensearch')
  })

  it('检索词原样带过去，不被截断或改写', () => {
    const q = '增值税 发票 红冲 流程'
    expect(url(q).searchParams.get('q')).toBe(q)
  })

  it('中文/西文判定看主体语言，不看到一个汉字就当中文', () => {
    expect(isCjkQuery('量子计算 最新进展')).toBe(true)
    expect(isCjkQuery('Electron 45 release notes')).toBe(false)
    // 英文技术词里夹一两个汉字，主体仍是英文
    expect(isCjkQuery('Electron 的主进程 process 模型 IPC')).toBe(false)
    expect(isCjkQuery('')).toBe(false)
  })
})

/**
 * DuckDuckGo 被拦时回的是 **202 加一页人机验证**，不是错误码。
 * 旧代码只判 `res.ok`，于是把这一页当成"零条结果"，用户看到"查不到"——
 * 把"被拦了"说成"没有"，用户会以为要查的东西不存在。
 */
describe('反爬页识别', () => {
  const ddgChallenge =
    'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human.'

  it('DuckDuckGo 的 202 挑战页认得出', () => {
    expect(detectChallenge(202, ddgChallenge)).toContain('反爬')
  })

  it('常见的验证页文案认得出', () => {
    expect(detectChallenge(200, '<div>请完成安全验证后继续</div>')).toContain('反爬')
    expect(detectChallenge(200, '<div class="captcha-box"></div>')).toContain('反爬')
  })

  it('正常页面只是真的没结果时不误判', () => {
    expect(detectChallenge(200, '<html><body><p>没有找到相关结果</p></body></html>')).toBeNull()
    expect(detectChallenge(200, '')).toBeNull()
  })
})

/**
 * "读到了字，但没读到正文"的判定。
 *
 * 这三条样本是从真实页面抄下来的结果，不是编的：
 *   知乎问答    35 字，只剩站点口号
 *   微信公众号  78 字，全是「，」「。」这类排版碎片
 *   小红书      14 字，最终地址已跳到 /login
 * 判不出来的后果不是报错，而是更糟的那种——模型拿站点口号当页面内容回答，
 * 用户看到一段通顺、具体、但和那页毫无关系的话。
 */
describe('正文诊断：读到了字但没读到正文', () => {
  const page = (over: Partial<Parameters<typeof diagnosePage>[0]>) =>
    diagnosePage({ html: '<html></html>', text: '', finalUrl: 'https://example.com/a', titleMissing: false, ...over })

  it('跳到登录页：认得出，且说清要登录', () => {
    const verdict = page({
      text: '小红书 - 你的生活兴趣社区',
      finalUrl: 'https://www.xiaohongshu.com/login?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com',
      titleMissing: false
    })
    expect(verdict).toContain('登录')
  })

  it('标点碎片占多数：不当正文（微信公众号那种「， ⏎ 。 ⏎ ，」）', () => {
    const soup = ['某篇公众号文章', '：', '，', '，', '，', '。', '视频', '小程序', '赞'].join('\n')
    expect(page({ text: soup })).toContain('碎片')
  })

  it('错误提示页：直接说是错误提示（比"碎片"更具体，所以优先报这个）', () => {
    expect(page({ text: '参数错误\n请返回重试' })).toContain('错误提示')
    expect(page({ text: '404 页面不存在' })).toContain('错误提示')
    // 同一页既像错误页又满是碎片时，报错误页——那才是用户该知道的事
    expect(page({ text: ['参数错误', '，', '。', '，', '。', '，'].join('\n') })).toContain('错误提示')
  })

  it('前端渲染的空壳：认出 SPA 容器 + 文字过少', () => {
    const verdict = page({
      html: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
      text: '加载中'
    })
    expect(verdict).toContain('JS')
  })

  it('空页面：如实说空的', () => {
    expect(page({ text: '   ' })).toContain('空')
  })

  it('正常正文不误报（误报比漏报更糟：会让模型放弃一个能用的页面）', () => {
    const body = Array.from({ length: 12 }, (_, i) => `这是第 ${i + 1} 段正文，讲了具体的事情。`).join('\n')
    expect(page({ text: body })).toBeUndefined()
  })

  it('正常的长页面带 SPA 容器也不误报（容器在页里不等于正文是空的）', () => {
    const body = Array.from({ length: 40 }, (_, i) => `正文段落 ${i}：具体内容，不是导航。`).join('\n')
    expect(page({ html: '<body><div id="root"></div></body>', text: body })).toBeUndefined()
  })

  it('有标题的正常短页面不误报（短本身不是证据）', () => {
    expect(page({ text: '这是一个只有几句话的说明页面。', titleMissing: false })).toBeUndefined()
  })
})
