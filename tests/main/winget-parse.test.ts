import { describe, expect, it } from 'vitest'
import { parseListedRow, parseWingetTable } from '../../src/main/node/install'

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

/**
 * winget **list** 的输出与 search 不同，不能复用它上面的表格解析。
 *
 * 真机抓到的原样输出（注意整行只有单空格分隔：名称比列宽长时，
 * winget 不再补空格对齐，列就挤在一起了）：
 *
 *   名称              ID        版本  可用  源
 *   ----------------------------------------------
 *   7-Zip 26.05 (x64) 7zip.7zip 26.05 26.06 winget
 */
describe('parseListedRow', () => {
  const realListOutput = [
    '名称              ID        版本  可用  源',
    '----------------------------------------------',
    '7-Zip 26.05 (x64) 7zip.7zip 26.05 26.06 winget'
  ].join('\r\n')

  it('单空格分隔的真实输出也能切出显示名与版本', () => {
    // 这条是真机抓的原文：按 2+ 空格切列会一条都切不出来，
    // 原来靠"输出里有这个 Id"兜底，于是显示名和版本全丢了
    expect(parseListedRow(realListOutput, '7zip.7zip')).toEqual({
      name: '7-Zip 26.05 (x64)',
      version: '26.05'
    })
  })

  it('搜索风格的宽对齐输出同样能切', () => {
    const text = ['名称              ID                 版本', '-----', '网易云音乐        NetEase.CloudMusic 2.10.6  winget'].join(
      '\n'
    )
    expect(parseListedRow(text, 'NetEase.CloudMusic')).toEqual({ name: '网易云音乐', version: '2.10.6' })
  })

  it('不去命中更长 Id 的那一行（前缀相同的两个包）', () => {
    // 查 NetEase.CloudMusic 时不能把 NetEase.CloudMusic.Beta 那行当成自己
    const text = [
      '名称        ID                        版本',
      '------------',
      '网易云音乐  NetEase.CloudMusic         2.10.6',
      '网易云内测  NetEase.CloudMusic.Beta    3.0.0'
    ].join('\n')
    expect(parseListedRow(text, 'NetEase.CloudMusic')).toEqual({ name: '网易云音乐', version: '2.10.6' })
  })

  it('没装 / 空输出返回 null，不抛错', () => {
    expect(parseListedRow('找不到与输入条件匹配的已安装程序', '7zip.7zip')).toBeNull()
    expect(parseListedRow('', '7zip.7zip')).toBeNull()
  })

  it('表头行不会被当成数据行', () => {
    // 表头里也有 "ID" 两个字，但它不是包 Id
    expect(parseListedRow('名称              ID        版本', 'ID')).toBeNull()
  })
})
