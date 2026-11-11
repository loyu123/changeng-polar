import { describe, expect, it } from 'vitest'
import { pptText } from '../../src/main/node/legacy-office'
import { readOle } from '../../src/main/node/ole'
import {
  buildOle,
  buildPptDocument,
  buildPptFile,
  pptBytes,
  pptChars,
  pptIndexList,
  pptPageContainer,
  pptPersistDirectory,
  pptRecord,
  pptSlidePersist,
  pptTextHeader,
  pptTextList,
  pptUserEdit
} from './ole-fixture'

/**
 * 老式 .ppt（PowerPoint 97–2003）的文字提取。
 *
 * 结构是照**真实文件**（Office 自带的 .PPT 模板）定的，不是照规范想象定的：
 * 文字挂在每一页自己的容器（1006 / 1008）里，文档容器里那份「分页表」只给出
 * 谁在第几页；把编号翻成流里的位置，靠的是持久化目录（6002）。按字节顺序猜页
 * 会在改过页序的文件上串页，所以这一层的测试专门盯"页序"。
 *
 * 目标是"读得出、且不编"：页与页要分开、编码要读对、没有文字时要明说。
 */

/** 文字在页容器里、文档里只有编号的排版（97–2003 常见） */
function pptWithPageContainers(pages: string[][], notes: string[][] = []): Buffer {
  return buildPptFile((at) => {
    // 0 = 文档容器，1 = 持久化目录，2 = 保存记录，3.. = 各页容器，最后的 = 备注容器
    const slideIds = pages.map((_, i) => 100 + i)
    const noteIds = notes.map((_, i) => 200 + i)
    const entries: Array<[number, number]> = [
      ...slideIds.map((id, i) => [id, at(3 + i)] as [number, number]),
      ...noteIds.map((id, i) => [id, at(3 + pages.length + i)] as [number, number])
    ]
    return [
      buildPptDocument([pptIndexList(slideIds, 0), ...(notes.length > 0 ? [pptIndexList(noteIds, 2)] : [])]),
      pptPersistDirectory(entries),
      pptUserEdit(0),
      ...pages.map((paragraphs) => pptPageContainer(1006, paragraphs)),
      ...notes.map((paragraphs) => pptPageContainer(1008, paragraphs))
    ]
  })
}

const fileOf = (buffer: Buffer) => readOle(buffer)

describe('legacy .ppt', () => {
  it('文字在页容器里时，按分页表的顺序读出每一页', () => {
    const file = fileOf(pptWithPageContainers([['季度总结', '营收同比增长 12%'], ['下一步']]))
    const { text, warnings } = pptText(file)
    expect(text).toContain('[第 1 张幻灯片]\n季度总结\n营收同比增长 12%')
    expect(text).toContain('[第 2 张幻灯片]\n下一步')
    expect(warnings).toEqual([])
  })

  it('页序按分页表走，不按字节顺序：文件里第 2 页写在前面也照样是第 2 页', () => {
    // 这正是"改过页序"的文件长什么样：页容器在流里的先后 ≠ 放映顺序。
    // 只看字节顺序的实现会把它读反，而且读得理直气壮
    const file = fileOf(
      buildPptFile((at) => [
        buildPptDocument([pptIndexList([7, 9], 0)]),
        // 7 是第一页、9 是第二页；而它们在流里的位置正好相反
        pptPersistDirectory([
          [9, at(3)],
          [7, at(4)]
        ]),
        pptUserEdit(0),
        // 流里先放"第二页"，再放"第一页"
        pptPageContainer(1006, ['这其实是第二页']),
        pptPageContainer(1006, ['这其实是第一页'])
      ])
    )
    const { text } = pptText(file)
    expect(text.indexOf('这其实是第一页')).toBeLessThan(text.indexOf('这其实是第二页'))
    expect(text).toContain('[第 1 张幻灯片]\n这其实是第一页')
    expect(text).toContain('[第 2 张幻灯片]\n这其实是第二页')
  })

  it('文字直接写在分页表里（老一点的存法）也读得出', () => {
    const file = fileOf(buildPptFile([buildPptDocument([pptTextList([['表里存的字'], ['第二页的字']])])]))
    const { text } = pptText(file)
    expect(text).toContain('[第 1 张幻灯片]\n表里存的字')
    expect(text).toContain('[第 2 张幻灯片]\n第二页的字')
  })

  it('TextBytesAtom 按"一个字节就是一个字符"读，不当代码页', () => {
    // 0x80–0x9F 这一段是 latin1 和 cp1252 唯一不同的地方；按 UTF-8 或 GBK 解都会跑偏
    const file = fileOf(
      buildPptFile([
        buildPptDocument([
          pptRecord(4080, 0, Buffer.concat([pptSlidePersist(1), pptBytes('café \u0093ok\u0094')]), true)
        ])
      ])
    )
    const { text } = pptText(file)
    expect(text).toContain('café')
    expect(text).toContain('\u0093ok\u0094')
  })

  it('空白页不输出，但后面的页码不会跟着往前挤', () => {
    // 一页只有图片时整页没有字：这时说"第 2 张"仍然是第 2 张，不能编成第 1 张
    const file = fileOf(pptWithPageContainers([[], ['第三页才有字']]))
    const { text } = pptText(file)
    expect(text).not.toContain('[第 1 张幻灯片]')
    expect(text).toContain('[第 2 张幻灯片]')
    expect(text).toContain('第三页才有字')
  })

  it('备注单独归一段，不混进幻灯片正文', () => {
    const file = fileOf(pptWithPageContainers([['正文']], [['演讲者备注：先讲背景']]))
    const { text } = pptText(file)
    expect(text).toContain('[第 1 张幻灯片]\n正文')
    expect(text).toContain('[备注 1]\n演讲者备注：先讲背景')
    expect(text.indexOf('正文')).toBeLessThan(text.indexOf('先讲背景'))
  })

  it('增量保存过多次：只听最后一版，并说明听的是哪一版', () => {
    const file = fileOf(
      buildPptFile([
        buildPptDocument([pptTextList([['旧版本里的一句话']])]),
        buildPptDocument([pptTextList([['改完之后的话']])])
      ])
    )
    const { text, warnings } = pptText(file)
    expect(text).toContain('改完之后的话')
    // 旧版本那页还在文件里，读出来就会变成"同一页有两个说法"
    expect(text).not.toContain('旧版本里的一句话')
    expect(warnings.join()).toContain('2 版')
  })

  it('段落符 \\r 和软换行 \\x0b 都变成换行', () => {
    const file = fileOf(buildPptFile([buildPptDocument([pptTextList([['第一段\r第二段\x0b第三行']])])]))
    const { text } = pptText(file)
    expect(text).toContain('第一段\n第二段\n第三行')
    expect(text).not.toContain('\r')
  })

  it('分页表对不上（更早的结构）：按文件顺序收字，并明说页序可能不准', () => {
    const file = fileOf(
      buildPptFile([
        buildPptDocument([]),
        pptPageContainer(1006, ['老结构里的第一页']),
        pptPageContainer(1006, ['老结构里的第二页'])
      ])
    )
    const { text, warnings } = pptText(file)
    expect(text).toContain('老结构里的第一页')
    expect(text).toContain('老结构里的第二页')
    expect(warnings.join()).toContain('页与页的先后可能不准')
  })

  it('一页字都没有：如实报页数，不吐一段空内容', () => {
    const file = fileOf(pptWithPageContainers([[], [], []]))
    expect(() => pptText(file)).toThrow(/没有可提取的文字/)
    expect(() => pptText(file)).toThrow(/3 张幻灯片/)
  })

  it('加了密的老 PPT：直接说读不了，不试着解密文', () => {
    const encrypted = readOle(
      buildOle([
        { name: 'PowerPoint Document', data: Buffer.concat([buildPptDocument([pptTextList([['看得见才怪']])])]) },
        { name: 'EncryptedSummary', data: Buffer.alloc(64) }
      ])
    )
    expect(() => pptText(encrypted)).toThrow(/加了密/)
  })

  it('没有正文流：说清这不是 PowerPoint 文件', () => {
    const other = readOle(buildOle([{ name: 'Workbook', data: Buffer.alloc(32) }]))
    expect(() => pptText(other)).toThrow(/没有正文流/)
  })

  it('记录长度越界（文件被截断）：停下来报错，不顺着偏移读出垃圾', () => {
    const whole = Buffer.concat([buildPptDocument([pptTextList([['完整的一页']])])])
    const truncated = whole.subarray(0, whole.length - 10)
    expect(() => pptText(fileOf(buildPptFile([truncated])))).toThrow(/损坏|截断|没有可提取的文字/)
  })

  it('「第 N 张幻灯片」按分页表数，一页一条', () => {
    const file = fileOf(
      buildPptFile([
        buildPptDocument([
          pptRecord(
            4080,
            0,
            Buffer.concat([
              pptSlidePersist(1),
              pptTextHeader(0),
              pptChars('A'),
              pptSlidePersist(2),
              pptTextHeader(0),
              pptChars('B'),
              pptSlidePersist(3),
              pptTextHeader(0),
              pptChars('C')
            ]),
            true
          )
        ])
      ])
    )
    const { text } = pptText(file)
    expect(text).toBe('[第 1 张幻灯片]\nA\n\n[第 2 张幻灯片]\nB\n\n[第 3 张幻灯片]\nC')
  })

  it('文本头原子只说明这段字的用途，它的 4 个字节不会混进正文', () => {
    // 头原子里的那 4 个字节要是被当成文字读进来，会是几个看不见的控制字符，
    // 谁都发现不了——所以这里连长度一起钉住
    const file = fileOf(
      buildPptFile([
        buildPptDocument([
          pptRecord(4080, 0, Buffer.concat([pptSlidePersist(1), pptRecord(3999, 0, Buffer.alloc(4)), pptChars('BODY')]), true)
        ])
      ])
    )
    expect(pptText(file).text).toBe('[第 1 张幻灯片]\nBODY')
  })
})
