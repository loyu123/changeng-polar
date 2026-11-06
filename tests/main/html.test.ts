import { describe, expect, it } from 'vitest'
import { decodeEntities, findTextPart, stripTags } from '../../src/main/node/html'

describe('decodeEntities', () => {
  it('命名实体、十进制、十六进制都还原', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;')).toBe('&<>"\'')
    expect(decodeEntities('&#x4e2d;&#25991;')).toBe('中文')
    expect(decodeEntities('&nbsp;')).toBe(' ')
  })

  it('不认识的实体原样保留（宁可露出原文，也不猜错意思）', () => {
    expect(decodeEntities('&foobar;')).toBe('&foobar;')
  })

  it('非法码点不抛错', () => {
    expect(() => decodeEntities('&#xFFFFFF;')).not.toThrow()
  })
})

describe('stripTags', () => {
  it('去掉 script / style，块级标签转成换行', () => {
    const html = `<html><head><style>p{color:red}</style><script>evil()</script></head>
<body><h1>标题</h1><p>第一段&amp;内容</p><p>第二段&nbsp;带空格</p><br>换行后<ul><li>甲</li><li>乙</li></ul></body></html>`
    const text = stripTags(html)
    expect(text).not.toContain('evil()')
    expect(text).not.toContain('color:red')
    // 段落之间靠块级标签分隔：邮件正文的可读性全靠这一步
    expect(text).toContain('标题\n第一段&内容')
    expect(text).toContain('第二段 带空格')
    expect(text).toContain('甲\n乙')
  })

  it('连续空行压成最多一个空行', () => {
    expect(stripTags('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })

  it('纯文本原样返回（去掉首尾空白）', () => {
    expect(stripTags('  裸文本  ')).toBe('裸文本')
  })

  it('空输入不抛错', () => {
    expect(stripTags('')).toBe('')
  })
})

describe('findTextPart', () => {
  it('多部件优先取 text/plain', () => {
    const node = {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'text/html', part: '2' }
      ]
    }
    expect(findTextPart(node)).toEqual({ path: '1', type: 'text/plain' })
  })

  it('只有 HTML 时退到 text/html，由调用方剥标签', () => {
    const node = { type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '1.2' }] }
    expect(findTextPart(node)).toEqual({ path: '1.2', type: 'text/html' })
  })

  it('嵌套结构能递归找到', () => {
    const node = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [{ type: 'text/plain', part: '2.1' }] }
      ]
    }
    expect(findTextPart(node)).toEqual({ path: '2.1', type: 'text/plain' })
  })

  it('没有可读文本（纯附件邮件）返回 null', () => {
    expect(findTextPart({ type: 'application/pdf', part: '1' })).toBeNull()
    expect(findTextPart(null)).toBeNull()
  })

  it('深度超过上限就停，不会无限递归', () => {
    let node: any = { type: 'text/plain', part: 'x' }
    for (let i = 0; i < 20; i++) node = { type: 'multipart/mixed', childNodes: [node] }
    expect(findTextPart(node)).toBeNull()
  })
})
