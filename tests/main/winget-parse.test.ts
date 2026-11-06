import { describe, expect, it } from 'vitest'
import { parseWingetTable } from '../../src/main/node/install'

/**
 * winget search 的对齐文本表解析。
 * 这里每条用例都对应一次真机踩坑，不是构造出来的。
 */
describe('parseWingetTable', () => {
  it('中文表头 + 中文名（等宽对齐，显示宽度是字符数两倍）', () => {
    // 真机症状：按表头字符位置切列，中文名后面永远切错，于是"有结果却匹配不到 Id"
    const text = [
      '名称               ID                       版本',
      '-----------------------------------------------',
      '网易云音乐         NetEase.CloudMusic       2.10.6  winget',
      '微信               Tencent.WeChat           3.9.10  winget'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([
      { name: '网易云音乐', id: 'NetEase.CloudMusic', version: '2.10.6' },
      { name: '微信', id: 'Tencent.WeChat', version: '3.9.10' }
    ])
  })

  it('英文表头同样解析', () => {
    const text = [
      'Name        Id                     Version',
      '------------------------------------------',
      '7-Zip       7zip.7zip              24.09  winget'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([{ name: '7-Zip', id: '7zip.7zip', version: '24.09' }])
  })

  it('版本列与「匹配」列粘连（单空格）时只取版本号本体', () => {
    const text = [
      '名称    ID                 版本',
      '---------------------------------',
      '某软件  Vendor.SomeApp     1.2.3 winget'
    ].join('\n')
    expect(parseWingetTable(text)[0].version).toBe('1.2.3')
  })

  it('名称里带单空格不影响切分（按 2+ 空格分列）', () => {
    const text = [
      '名称                ID                    版本',
      '-----------------------------------------------',
      'Microsoft PC Manager  Microsoft.PCManager  3.0.1  winget'
    ].join('\n')
    const rows = parseWingetTable(text)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Microsoft PC Manager', id: 'Microsoft.PCManager' })
  })

  it('Id 不含点号的行被丢弃（防止误切出垃圾列）', () => {
    const text = ['名称    ID    版本', '--------------------------', '某软件  noDot  1.0'].join('\n')
    expect(parseWingetTable(text)).toEqual([])
  })

  it('没有表头（例如报错输出）返回空数组，不抛错', () => {
    expect(parseWingetTable('winget 源连接失败 0x8A150017')).toEqual([])
    expect(parseWingetTable('')).toEqual([])
  })

  it('「无匹配」这类提示不会被当成包', () => {
    const text = [
      '名称    ID    版本',
      '-------------------------',
      '未找到与输入条件匹配的已安装程序包。'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([])
  })
})
