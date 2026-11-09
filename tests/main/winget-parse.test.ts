import { describe, expect, it } from 'vitest'
import { matchedByName, parseListedRow, parseWingetTable, rankCandidates } from '../../src/main/node/install'

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
      { name: '网易云音乐', id: 'NetEase.CloudMusic', version: '2.10.6', match: 'winget' },
      { name: '微信', id: 'Tencent.WeChat', version: '3.9.10', match: 'winget' }
    ])
  })

  it('英文表头同样解析', () => {
    const text = [
      'Name        Id                     Version',
      '------------------------------------------',
      '7-Zip       7zip.7zip              24.09  winget'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([{ name: '7-Zip', id: '7zip.7zip', version: '24.09', match: 'winget' }])
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

  /**
   * 名称超出列宽时 winget 不补空格，name 与 Id 之间只剩一个空格。
   * 真机原文（2026-11-09）：`winget search --id Bilibili.Bilibili --exact` 的输出
   * 就是这种，旧实现按 2+ 空格切列，切不开 → 整行丢弃 → 报"仓库里没有找到"。
   * 后果是装中文软件时死循环：报中文名→多条匹配→模型改用 Id→却说找不到→再报中文名。
   */
  it('名称超宽、整行单空格（真机原文）：仍要解析出来', () => {
    const text = [
      '名称     ID                版本',
      '---------------------------------',
      '哔哩哔哩 Bilibili.Bilibili 1.20.0'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([{ name: '哔哩哔哩', id: 'Bilibili.Bilibili', version: '1.20.0' }])
  })

  it('同一份输出里多空格行与单空格行混排', () => {
    const text = [
      '名称                 ID                            版本         匹配',
      '------------------------------------------------------------------------------',
      '哔哩哔哩             Bilibili.Bilibili              1.20.0',
      'BiliSail             CKopoer.BiliSail               1.2.8005     Tag: 哔哩哔哩',
      'Tube_Ultimate_Player davidchiu66.TubeUltimatePlayer 0.2.31       Tag: 哔哩哔哩'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([
      { name: '哔哩哔哩', id: 'Bilibili.Bilibili', version: '1.20.0', match: undefined },
      { name: 'BiliSail', id: 'CKopoer.BiliSail', version: '1.2.8005', match: 'Tag: 哔哩哔哩' },
      { name: 'Tube_Ultimate_Player', id: 'davidchiu66.TubeUltimatePlayer', version: '0.2.31', match: 'Tag: 哔哩哔哩' }
    ])
  })

  it('单空格行里名称本身带点（Node.js）不会把 name 当成 Id', () => {
    const text = [
      '名称     ID                版本',
      '---------------------------------',
      'Node.js 10 OpenJS.NodeJS.10 10.24.1'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([
      { name: 'Node.js 10', id: 'OpenJS.NodeJS.10', version: '10.24.1' }
    ])
  })

  it('单空格行里名称带空格与括号，也切得对', () => {
    const text = [
      '名称     ID                版本',
      '---------------------------------',
      'Microsoft .NET Host - 7.0.20 (x64) Microsoft.DotNet.Host 7.0.20'
    ].join('\n')
    expect(parseWingetTable(text)).toEqual([
      { name: 'Microsoft .NET Host - 7.0.20 (x64)', id: 'Microsoft.DotNet.Host', version: '7.0.20' }
    ])
  })

  it('切不出 Id 的行（纯文本提示）仍然丢弃', () => {
    const text = [
      '名称    ID    版本',
      '-------------------------',
      '正在下载安装包 请稍候'
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

/**
 * 候选排序与"是不是名字命中"。
 *
 * 真机输出（winget search kimi，2026-11）：前三条名字里有 kimi，
 * 后面七条是清单里打了 kimi 标签的——ChatALL、LM Studio、Chatbox 都不是
 * 「Kimi 客户端」。用户说「Kimi」时，卡上前几项必须是他想的那几个。
 */
describe('rankCandidates / matchedByName', () => {
  const kimiRows = parseWingetTable(
    [
      '名称                                             ID                                   版本     匹配',
      '------------------------------------------------------------------------------------------------------------',
      'Kimi                                             MoonshotAI.Kimi                      3.2.24   ',
      'Kimi CLI                                         MoonshotAI.KimiCLI                   1.52.0   Command: kimi',
      'Kimi Code CLI                                    MoonshotAI.KimiCodeCLI               2.5.2    Command: kimi',
      'ChatALL                                          AI-Shifu.ChatALL                     1.85.110 Tag: kimi',
      'LM Studio                                        ElementLabs.LMStudio                 0.4.28+2 Tag: kimi'
    ].join('\n')
  )

  it('名字命中的排在只靠标签命中的前面', () => {
    const ranked = rankCandidates(kimiRows, 'kimi')
    expect(ranked.slice(0, 3).map((p) => p.id)).toEqual([
      'MoonshotAI.Kimi',
      'MoonshotAI.KimiCLI',
      'MoonshotAI.KimiCodeCLI'
    ])
  })

  it('完全同名排第一，其次是同前缀', () => {
    const ranked = rankCandidates(kimiRows, 'kimi')
    expect(ranked[0].name).toBe('Kimi')
  })

  it('名字命中与标签命中分得开（Chatbox 类不算「Kimi 客户端」）', () => {
    const byName = kimiRows.filter((p) => matchedByName(p, 'kimi'))
    expect(byName.map((p) => p.id)).toEqual(['MoonshotAI.Kimi', 'MoonshotAI.KimiCLI', 'MoonshotAI.KimiCodeCLI'])
  })

  it('检索词为空时原样返回，不乱排', () => {
    expect(rankCandidates(kimiRows, '  ').map((p) => p.id)).toEqual(kimiRows.map((p) => p.id))
  })

  it('排序不改动入参数组（上层还要拿原顺序做别的判断）', () => {
    const before = kimiRows.map((p) => p.id)
    rankCandidates(kimiRows, 'kimi')
    expect(kimiRows.map((p) => p.id)).toEqual(before)
  })

  /**
   * 真机踩到的假阳性：Id `XINGInc.AkasakiMinato` 里 "akasak**imi**nato" 藏着 kimi。
   * 对 Id 做子串匹配会把「赤咲 湊」这种毫不相干的包塞进候选卡。
   */
  it('Id 按段比，不按子串（AkasakiMinato 不算 kimi）', () => {
    const noise = { name: 'CeVIO Voice Package - 赤咲 湊', id: 'XINGInc.AkasakiMinato', version: '1.1.2' }
    expect(matchedByName(noise, 'kimi')).toBe(false)
    expect(matchedByName({ name: 'Kimi CLI', id: 'MoonshotAI.KimiCLI', version: '1.5' }, 'kimi')).toBe(true)
  })

  /**
   * 另一个真机排序错：`7-Zip` 与用户敲的 `7zip` 只差一个连字符，
   * 按原字符串比既不 startsWith 也不 includes，于是排到了 Dark7zip、Py7Zip 后面。
   */
  it('名字标点归一后，7-Zip 排在 Dark7zip / Py7Zip 前面', () => {
    const rows = [
      { name: 'Dark7zip', id: 'ozone10.7zip.Dark', version: '26.02' },
      { name: 'Py7Zip', id: 'Gabtyss.Py7z', version: '2.0.0' },
      { name: '7-Zip', id: '7zip.7zip', version: '26.06' }
    ]
    expect(rankCandidates(rows, '7zip')[0].name).toBe('7-Zip')
  })
})
