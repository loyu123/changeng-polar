import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import { createTools } from '../../src/main/agent/tools'
import type { ToolContext, ToolDef } from '../../src/main/agent/tool-types'
import {
  inspectDocument,
  isInsideOutput,
  MAX_DOC_CHARS,
  OUTPUT_FOLDER,
  resolveDocument,
  sanitizeDocumentName,
  writeDocumentOnce
} from '../../src/main/node/document'
import type { RecordEntry } from '../../src/shared/types'
import { officeText } from '../../src/main/node/office'

/**
 * 写文件（write_document）。
 *
 * 这是长庚第一个往**用户真实目录**里写的工具，所以这里锁的不是"能写"，
 * 而是四条不能松的边界：落点唯一、只写文本、永不覆盖、写完要能回读核对。
 * 每一条都是模型给的参数管不住的——它写错一个字符，就可能是写到别处或覆盖掉别的文件。
 */

const ctx: ToolContext = {
  config: {} as ToolContext['config'],
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

function makeHooks(answer: 'once' | 'deny' = 'once'): GateHooks & {
  records: Array<Omit<RecordEntry, 'id' | 'ts'>>
  cards: string[]
} {
  const records: Array<Omit<RecordEntry, 'id' | 'ts'>> = []
  const cards: string[] = []
  return {
    records,
    cards,
    requestAuth: async (request) => {
      cards.push(`${request.impact}|${request.target}`)
      return answer
    },
    isRemembered: () => false,
    remember: () => {},
    record: (entry) => {
      records.push(entry)
    }
  }
}

let desktopRoot = ''

beforeAll(async () => {
  desktopRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'changeng-docs-'))
})

afterAll(async () => {
  if (desktopRoot) await fs.rm(desktopRoot, { recursive: true, force: true })
})

const toolOf = (deps: Parameters<typeof createTools>[0] = {}): ToolDef =>
  createTools(deps).find((t) => t.name === 'write_document')!

describe('文件名：认不出来的直接拒绝，不替它猜', () => {
  /** 只看名字：format / swappedFrom 在下面单独的用例里测 */
  const named = (raw: unknown): string | null => {
    const checked = sanitizeDocumentName(raw)
    return checked.ok ? checked.name : null
  }

  it('没写后缀按 .md 存', () => {
    expect(named('周报')).toBe('周报.md')
  })

  it('文本类后缀保留', () => {
    expect(named('清单.csv')).toBe('清单.csv')
    expect(named('合同.txt')).toBe('合同.txt')
  })

  it('Word / PowerPoint 新格式照写', () => {
    const docx = sanitizeDocumentName('周报.docx')
    expect(docx).toEqual({ ok: true, name: '周报.docx', format: 'docx', swappedFrom: null })
    const pptx = sanitizeDocumentName('汇报.pptx')
    expect(pptx).toEqual({ ok: true, name: '汇报.pptx', format: 'pptx', swappedFrom: null })
  })

  it('老格式 .doc / .ppt 换名存新格式，并记下换过什么', () => {
    // 不照写 .doc：那是 1997 年的 OLE 二进制，塞一份 ZIP 进去 Word 只会报"文件已损坏"
    expect(sanitizeDocumentName('周报.doc')).toEqual({
      ok: true,
      name: '周报.docx',
      format: 'docx',
      swappedFrom: '.doc'
    })
    expect(sanitizeDocumentName('汇报.ppt')).toEqual({
      ok: true,
      name: '汇报.pptx',
      format: 'pptx',
      swappedFrom: '.ppt'
    })
    // 后缀大小写不影响判断
    expect(named('周报.DOC')).toBe('周报.docx')
  })

  it('会执行的后缀不给写（落进这个目录也是双击就跑）', () => {
    for (const name of ['跑一下.bat', '脚本.ps1', 'setup.exe', '快捷方式.lnk', '宏.docm', '程序.js']) {
      const checked = sanitizeDocumentName(name)
      expect(checked.ok, name).toBe(false)
    }
  })

  it('带目录的一律拒绝，而不是切掉目录（切掉就成了"写 A 落 B"）', () => {
    for (const name of ['..\\evil.md', 'sub/evil.md', 'C:\\Windows\\evil.md', 'C:x.md', 'a..b.md']) {
      expect(sanitizeDocumentName(name).ok, name).toBe(false)
    }
  })

  it('Windows 不接受的字符换成下划线（卡片上展示的就是改写后的名字）', () => {
    expect(named('10月报销: 明细?.md')).toBe('10月报销_ 明细_.md')
  })

  it('结尾的点和空格去掉（这两个后缀 Windows 会悄悄砍掉）', () => {
    expect(named('周报. ')).toBe('周报.md')
  })

  it('保留设备名拒绝（叫 CON 的文件根本建不出来）', () => {
    for (const name of ['CON', 'nul.md', 'COM1.txt', 'LPT9.md']) {
      expect(sanitizeDocumentName(name).ok, name).toBe(false)
    }
  })

  it('空名字、只有后缀 → 拒绝', () => {
    expect(sanitizeDocumentName('   ').ok).toBe(false)
    expect(sanitizeDocumentName('.md').ok).toBe(false)
    expect(sanitizeDocumentName(undefined).ok).toBe(false)
  })

  it('名字太长要截断，但后缀留着', () => {
    const checked = sanitizeDocumentName('很长'.repeat(80) + '.md')
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.name.endsWith('.md')).toBe(true)
      expect(checked.name.length).toBeLessThanOrEqual(63)
    }
  })

  it('拒绝的理由里写明能写哪些，模型才有机会换一个', () => {
    const checked = sanitizeDocumentName('东西.zip')
    expect(checked.ok).toBe(false)
    if (!checked.ok) {
      expect(checked.reason).toContain('.docx')
      expect(checked.reason).toContain('.doc')
    }
  })
})

/**
 * 真正的落点由主进程注入，注入的那两行是唯一决定"写到哪"的地方。
 *
 * 这里读源码而不是跑一遍：`app.getPath()` 只在 Electron 主进程里存在，
 * vitest 里起不来；而只测注入一个临时目录，就把"到底注入的是哪个盘哪个目录"漏掉了——
 * 上一版正是靠这种漏法，文档目录写错位也不会有人发现。
 *
 * 顺带锁住一处容易漏的一致：`shell:reveal` 的守卫必须和写入用同一个根，
 * 否则两边一分叉，"打开所在位置"会对每个文件都返回 false，而且不报错。
 */
describe('落点注入：桌面，不是「文档」', () => {
  const read = (rel: string): string => readFileSync(path.join(import.meta.dirname, '../..', rel), 'utf8')

  it('runtime 注入的是桌面路径', () => {
    const source = read('src/main/runtime.ts')
    expect(source).toMatch(/outputRoot:\s*app\.getPath\('desktop'\)/)
    // 曾经的落点：留着就等于随时可能被改回去
    expect(source).not.toContain("getPath('documents')")
  })

  it('「打开所在位置」的守卫用的是同一个根（分叉=这个按钮永远失效）', () => {
    const source = read('src/main/ipc/app.ts')
    expect(source).toMatch(/isInsideOutput\(app\.getPath\('desktop'\)/)
    expect(source).not.toContain("getPath('documents')")
  })
})

describe('落点：只写「桌面\\长庚产出」，同名永不覆盖', () => {
  it('解析出来的路径就在产出目录里', async () => {
    const planned = await resolveDocument(desktopRoot, '甲.md')
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.path).toBe(path.join(desktopRoot, OUTPUT_FOLDER, '甲.md'))
      expect(planned.renamed).toBe(false)
    }
  })

  it('同名已存在 → 换成 (2)、(3)，并标明换过名字', async () => {
    const first = await resolveDocument(desktopRoot, '乙.md')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await writeDocumentOnce(first, '第一份')
    const second = await resolveDocument(desktopRoot, '乙.md')
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.name).toBe('乙 (2).md')
      expect(second.renamed).toBe(true)
    }
    if (second.ok) await writeDocumentOnce(second, '第二份')
    const third = await resolveDocument(desktopRoot, '乙.md')
    if (third.ok) expect(third.name).toBe('乙 (3).md')
  })

  it('没有注入桌面路径 → 拒绝，而不是写到进程当前目录', async () => {
    const planned = await resolveDocument('', '丙.md')
    expect(planned.ok).toBe(false)
  })
})

describe('写入与回读', () => {
  it('写进去的字节与回读出来的 sha 一致', async () => {
    const planned = await resolveDocument(desktopRoot, '丁.md')
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const content = '# 标题\n\n正文一行。\n'
    const outcome = await writeDocumentOnce(planned, content)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.bytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(await fs.readFile(planned.path, 'utf8')).toBe(content)
    const now = await inspectDocument(planned.path)
    expect(now.ok && now.sha256).toBe(outcome.sha256)
  })

  it('同一个路径再写一次：独占创建失败，原文件一个字节都没动', async () => {
    const planned = await resolveDocument(desktopRoot, '戊.md')
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    await writeDocumentOnce(planned, '原件')
    const again = await writeDocumentOnce(planned, '覆盖尝试')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.exists).toBe(true)
    expect(await fs.readFile(planned.path, 'utf8')).toBe('原件')
  })
})

describe('「打开所在位置」的作用域', () => {
  // 注意：desktopRoot 是 beforeAll 里才赋值的，所以 out 必须在 it 里面算，
  // 不能在 describe 体里提前求值（那时 desktopRoot 还是空串）
  const outNow = (): string => path.join(desktopRoot, OUTPUT_FOLDER)

  it('产出目录里的文件才认', () => {
    expect(isInsideOutput(desktopRoot, path.join(outNow(), '周报.md'))).toBe(true)
    expect(isInsideOutput(desktopRoot, path.join(outNow(), '子目录', '周报.md'))).toBe(true)
  })

  it('边上那个前缀相同的目录不算（startsWith 会误判的那种）', () => {
    expect(isInsideOutput(desktopRoot, path.join(desktopRoot, OUTPUT_FOLDER + '2', '周报.md'))).toBe(false)
    expect(isInsideOutput(desktopRoot, path.join(desktopRoot, OUTPUT_FOLDER + '-备份', '周报.md'))).toBe(false)
  })

  it('目录本身、别处的文件、往上跳的路径都不算', () => {
    expect(isInsideOutput(desktopRoot, outNow())).toBe(false)
    expect(isInsideOutput(desktopRoot, path.join(desktopRoot, '别的.md'))).toBe(false)
    expect(isInsideOutput(desktopRoot, path.join(outNow(), '..', '..', 'Windows', 'win.ini'))).toBe(false)
    expect(isInsideOutput(desktopRoot, 'C:\\Windows\\win.ini')).toBe(false)
    expect(isInsideOutput(desktopRoot, '')).toBe(false)
  })
})

describe('工具本身', () => {
  it('是写档、必须过卡、不给「始终允许」', () => {
    const tool = toolOf()
    expect(tool.effect).toBe('write')
    expect(tool.requiresConfirmation).toBe(true)
    expect(tool.allowAlways).not.toBe(true)
  })

  it('直接 run 一定被拒（路径没解析过）', async () => {
    const result = await toolOf({ outputRoot: desktopRoot }).run({ name: '甲', content: 'x' }, ctx)
    expect(result.ok).toBe(false)
  })

  it('空内容 / 超长内容 / 没有桌面路径 → 解析阶段就拒绝，不弹卡', async () => {
    const tool = toolOf({ outputRoot: desktopRoot })
    expect((await tool.plan!({ name: '甲', content: '   ' }, ctx)).ok).toBe(false)
    const tooLong = await tool.plan!({ name: '甲', content: 'x'.repeat(MAX_DOC_CHARS + 1) }, ctx)
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.reason).toContain('上限')
    const noDir = await createTools().find((t) => t.name === 'write_document')!.plan!(
      { name: '甲', content: 'x' },
      ctx
    )
    expect(noDir.ok).toBe(false)
  })

  it('过卡之后写进产出目录，事后核对是回读比对出来的', async () => {
    const hooks = makeHooks('once')
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '周会纪要', content: '结论：先做完闸门。\n' },
      ctx,
      hooks
    )
    expect(result.ok).toBe(true)
    const data = result.data as { path: string; name: string; bytes: number }
    expect(data.path).toBe(path.join(desktopRoot, OUTPUT_FOLDER, '周会纪要.md'))
    expect(await fs.readFile(data.path, 'utf8')).toBe('结论：先做完闸门。\n')
    expect(result.verify?.state).toBe('confirmed')
    expect(result.verify?.fact).toContain('内容与这次写进去的完全一致')
    // 卡片上写的路径就是真正写下那个（K7）
    expect(hooks.cards).toHaveLength(1)
    expect(hooks.cards[0]).toContain(data.path)
    // 核对结论进审计
    expect(hooks.records[0]?.verified).toBe('confirmed')
    expect(hooks.records[0]?.result).toBe('ok')
  })

  it('用户拒绝 → 一个文件都不建', async () => {
    const hooks = makeHooks('deny')
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '这份不该有', content: 'x' },
      ctx,
      hooks
    )
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    await expect(
      fs.access(path.join(desktopRoot, OUTPUT_FOLDER, '这份不该有.md'))
    ).rejects.toThrow()
  })

  it('文件写完之后被改动 → 核对报 mismatch，不报"存好了"', async () => {
    const hooks = makeHooks('once')
    const tool = toolOf({ outputRoot: desktopRoot })
    const result = await executeThroughGate(tool, { name: '会被改的', content: '原始内容' }, ctx, hooks)
    const data = result.data as { path: string }
    await fs.writeFile(data.path, '别的内容', 'utf8')
    const check = await tool.verify!({}, ctx, result)
    expect(check.state).toBe('mismatch')
    expect(check.fact).toContain('对不上')
  })

  it('文件不见了 → 核对报 mismatch（不是 unavailable：这一步本该写成功）', async () => {
    const hooks = makeHooks('once')
    const tool = toolOf({ outputRoot: desktopRoot })
    const result = await executeThroughGate(tool, { name: '会被删的', content: '内容' }, ctx, hooks)
    const data = result.data as { path: string }
    await fs.rm(data.path)
    const check = await tool.verify!({}, ctx, result)
    expect(check.state).toBe('mismatch')
  })
})

/**
 * Office 格式：模型写 Markdown，长庚生成真文件。
 *
 * 这里不测"XML 长什么样"（那是 office-write.test.ts 的事），测的是**用户能不能拿到**：
 * 文件真的落盘了、能被我方读取器读回同样的字、老格式换名时回执里说清楚了。
 */
describe('写出 .docx / .pptx', () => {
  const md = '# 季度小结\n\n本季处理工单 **128** 件。\n\n## 主要工作\n\n- 巡检 12 次\n- 迁移 2 套\n'

  it('.docx：落盘的是合法的 OOXML 包，正文能读回来', async () => {
    const hooks = makeHooks('once')
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '季度小结.docx', content: md },
      ctx,
      hooks
    )
    expect(result.ok).toBe(true)
    const data = result.data as { path: string; format: string }
    expect(data.format).toBe('docx')
    const buf = await fs.readFile(data.path)
    // 头两个字节是 ZIP 的 "PK"：用 utf8 写出去的话这里就不是了
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(officeText('docx', buf)).toContain('本季处理工单 128 件')
    // 核对回读的是文件真实的字节
    expect(result.verify?.state).toBe('confirmed')
    // 卡片上写的是最终路径（K7）
    expect(hooks.cards[0]).toContain(data.path)
  })

  it('.pptx：一页一个一级标题，页数出现在回执里', async () => {
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '季度汇报.pptx', content: md },
      ctx,
      makeHooks('once')
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('共 1 页')
    const data = result.data as { path: string }
    const buf = await fs.readFile(data.path)
    expect(officeText('pptx', buf)).toContain('巡检 12 次')
  })

  it('用户要 .doc → 落盘 .docx，回执里如实说换过名', async () => {
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '老格式.doc', content: md },
      ctx,
      makeHooks('once')
    )
    expect(result.ok).toBe(true)
    const data = result.data as { path: string; name: string; format: string; requestedFormat: string }
    expect(data.format).toBe('docx')
    expect(data.requestedFormat).toBe('doc')
    expect(data.name).toBe('老格式.docx')
    expect(result.summary).toContain('你要的是 .doc')
    await expect(fs.access(path.join(desktopRoot, OUTPUT_FOLDER, '老格式.doc'))).rejects.toThrow()
  })

  it('幻灯片页数超上限时**不弹卡**就拒绝（点完才发现是 200 页也来不及了）', async () => {
    const hooks = makeHooks('once')
    const many = Array.from({ length: 120 }, (_, i) => `# 第 ${i + 1} 页\n内容`).join('\n')
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '太长.pptx', content: many },
      ctx,
      hooks
    )
    expect(result.ok).toBe(false)
    expect(hooks.cards).toHaveLength(0)
    expect(result.summary).toContain('上限')
  })

  it('二进制内容按字节写：中文不会因为编码被改一个字节', async () => {
    const result = await executeThroughGate(
      toolOf({ outputRoot: desktopRoot }),
      { name: '编码核对.docx', content: '# 中文标题\n\n金额：￥1,280.00\n' },
      ctx,
      makeHooks('once')
    )
    const data = result.data as { path: string }
    const text = officeText('docx', await fs.readFile(data.path))
    expect(text).toContain('金额：￥1,280.00')
  })
})
