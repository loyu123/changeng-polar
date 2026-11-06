import { describe, expect, it } from 'vitest'
import { conclusionOf } from '../../src/renderer/src/utils/speech'

/**
 * 播报稿提取。
 * 口径是"只读结论句，不读正文"：取错了就是把整篇回答念出来，用户会烦。
 */
describe('conclusionOf', () => {
  it('只取第一段结论，不念正文', () => {
    const text = '这台机器上装了 125 个程序。\n\n下面逐个说明：\n- 微信\n- QQ'
    expect(conclusionOf(text)).toBe('这台机器上装了 125 个程序。')
  })

  it('剥掉 Markdown 标记再念', () => {
    expect(conclusionOf('**结论**：可以删。')).toBe('结论：可以删。')
    expect(conclusionOf('`code` 是行内代码')).toBe('code 是行内代码')
  })

  it('代码块整段跳过（念出来毫无意义）', () => {
    const text = '先说结论：没问题。\n\n```js\nconst a = 1\n```'
    expect(conclusionOf(text)).toBe('先说结论：没问题。')
  })

  it('列表符号被剥掉', () => {
    expect(conclusionOf('- 第一件事\n- 第二件事')).toBe('第一件事')
  })

  it('超过 120 字按句子收口，宁短不长', () => {
    const long = `${'这是一句比较长的结论。'.repeat(20)}`
    const out = conclusionOf(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('。')).toBe(true)
  })

  it('第一句就超长时退化为硬截断，不留空结果', () => {
    const out = conclusionOf('啊'.repeat(300))
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(120)
  })

  it('没有句号的短文本原样返回', () => {
    expect(conclusionOf('可以')).toBe('可以')
  })

  it('空输入返回空串，不抛错', () => {
    expect(conclusionOf('')).toBe('')
    expect(conclusionOf('\n\n  \n')).toBe('')
  })

  it('标题行被剥成正文', () => {
    expect(conclusionOf('## 结论\n可以装。')).toBe('结论')
  })
})
