import { promises as fs } from 'node:fs'
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

let docsRoot = ''

beforeAll(async () => {
  docsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'changeng-docs-'))
})

afterAll(async () => {
  if (docsRoot) await fs.rm(docsRoot, { recursive: true, force: true })
})

const toolOf = (deps: Parameters<typeof createTools>[0] = {}): ToolDef =>
  createTools(deps).find((t) => t.name === 'write_document')!

describe('文件名：认不出来的直接拒绝，不替它猜', () => {
  it('没写后缀按 .md 存', () => {
    expect(sanitizeDocumentName('周报')).toEqual({ ok: true, name: '周报.md' })
  })

  it('文本类后缀保留', () => {
    expect(sanitizeDocumentName('清单.csv')).toEqual({ ok: true, name: '清单.csv' })
    expect(sanitizeDocumentName('合同.txt')).toEqual({ ok: true, name: '合同.txt' })
  })

  it('会执行的后缀不给写（落进这个目录也是双击就跑）', () => {
    for (const name of ['跑一下.bat', '脚本.ps1', 'setup.exe', '快捷方式.lnk', '报表.docx']) {
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
    expect(sanitizeDocumentName('10月报销: 明细?.md')).toEqual({ ok: true, name: '10月报销_ 明细_.md' })
  })

  it('结尾的点和空格去掉（这两个后缀 Windows 会悄悄砍掉）', () => {
    expect(sanitizeDocumentName('周报. ')).toEqual({ ok: true, name: '周报.md' })
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
})

describe('落点：只写「文档\\长庚产出」，同名永不覆盖', () => {
  it('解析出来的路径就在产出目录里', async () => {
    const planned = await resolveDocument(docsRoot, '甲.md')
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.path).toBe(path.join(docsRoot, OUTPUT_FOLDER, '甲.md'))
      expect(planned.renamed).toBe(false)
    }
  })

  it('同名已存在 → 换成 (2)、(3)，并标明换过名字', async () => {
    const first = await resolveDocument(docsRoot, '乙.md')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await writeDocumentOnce(first, '第一份')
    const second = await resolveDocument(docsRoot, '乙.md')
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.name).toBe('乙 (2).md')
      expect(second.renamed).toBe(true)
    }
    if (second.ok) await writeDocumentOnce(second, '第二份')
    const third = await resolveDocument(docsRoot, '乙.md')
    if (third.ok) expect(third.name).toBe('乙 (3).md')
  })

  it('没有注入文档目录 → 拒绝，而不是写到进程当前目录', async () => {
    const planned = await resolveDocument('', '丙.md')
    expect(planned.ok).toBe(false)
  })
})

describe('写入与回读', () => {
  it('写进去的字节与回读出来的 sha 一致', async () => {
    const planned = await resolveDocument(docsRoot, '丁.md')
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
    const planned = await resolveDocument(docsRoot, '戊.md')
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
  // 注意：docsRoot 是 beforeAll 里才赋值的，所以 out 必须在 it 里面算，
  // 不能在 describe 体里提前求值（那时 docsRoot 还是空串）
  const outNow = (): string => path.join(docsRoot, OUTPUT_FOLDER)

  it('产出目录里的文件才认', () => {
    expect(isInsideOutput(docsRoot, path.join(outNow(), '周报.md'))).toBe(true)
    expect(isInsideOutput(docsRoot, path.join(outNow(), '子目录', '周报.md'))).toBe(true)
  })

  it('边上那个前缀相同的目录不算（startsWith 会误判的那种）', () => {
    expect(isInsideOutput(docsRoot, path.join(docsRoot, OUTPUT_FOLDER + '2', '周报.md'))).toBe(false)
    expect(isInsideOutput(docsRoot, path.join(docsRoot, OUTPUT_FOLDER + '-备份', '周报.md'))).toBe(false)
  })

  it('目录本身、别处的文件、往上跳的路径都不算', () => {
    expect(isInsideOutput(docsRoot, outNow())).toBe(false)
    expect(isInsideOutput(docsRoot, path.join(docsRoot, '别的.md'))).toBe(false)
    expect(isInsideOutput(docsRoot, path.join(outNow(), '..', '..', 'Windows', 'win.ini'))).toBe(false)
    expect(isInsideOutput(docsRoot, 'C:\\Windows\\win.ini')).toBe(false)
    expect(isInsideOutput(docsRoot, '')).toBe(false)
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
    const result = await toolOf({ documentsDir: docsRoot }).run({ name: '甲', content: 'x' }, ctx)
    expect(result.ok).toBe(false)
  })

  it('空内容 / 超长内容 / 没有文档目录 → 解析阶段就拒绝，不弹卡', async () => {
    const tool = toolOf({ documentsDir: docsRoot })
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
      toolOf({ documentsDir: docsRoot }),
      { name: '周会纪要', content: '结论：先做完闸门。\n' },
      ctx,
      hooks
    )
    expect(result.ok).toBe(true)
    const data = result.data as { path: string; name: string; bytes: number }
    expect(data.path).toBe(path.join(docsRoot, OUTPUT_FOLDER, '周会纪要.md'))
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
      toolOf({ documentsDir: docsRoot }),
      { name: '这份不该有', content: 'x' },
      ctx,
      hooks
    )
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    await expect(
      fs.access(path.join(docsRoot, OUTPUT_FOLDER, '这份不该有.md'))
    ).rejects.toThrow()
  })

  it('文件写完之后被改动 → 核对报 mismatch，不报"存好了"', async () => {
    const hooks = makeHooks('once')
    const tool = toolOf({ documentsDir: docsRoot })
    const result = await executeThroughGate(tool, { name: '会被改的', content: '原始内容' }, ctx, hooks)
    const data = result.data as { path: string }
    await fs.writeFile(data.path, '别的内容', 'utf8')
    const check = await tool.verify!({}, ctx, result)
    expect(check.state).toBe('mismatch')
    expect(check.fact).toContain('对不上')
  })

  it('文件不见了 → 核对报 mismatch（不是 unavailable：这一步本该写成功）', async () => {
    const hooks = makeHooks('once')
    const tool = toolOf({ documentsDir: docsRoot })
    const result = await executeThroughGate(tool, { name: '会被删的', content: '内容' }, ctx, hooks)
    const data = result.data as { path: string }
    await fs.rm(data.path)
    const check = await tool.verify!({}, ctx, result)
    expect(check.state).toBe('mismatch')
  })
})
