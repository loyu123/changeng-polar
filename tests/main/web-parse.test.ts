import { describe, expect, it } from 'vitest'
import { decodeEntities, stripTags } from '../../src/main/node/html'
import { relevanceTokens, unwrapBing, unwrapDdg } from '../../src/main/node/web'

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
