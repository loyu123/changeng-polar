import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTools } from '../../src/main/agent/tools'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import { resetFileIndex, setFileIndexRoots } from '../../src/main/node/file'
import { trimToolPayload } from '../../src/main/agent/agent'
import type { ToolContext, ToolDef } from '../../src/main/agent/tool-types'

/**
 * 「打开文件」和「读文件」这两个工具的行为。
 *
 * 锁的是四条：
 *  1. open_file 不执行会执行的程序（那是 launch_app 的事）
 *  2. read_file 真的把字读出来，而且长文件会说明只读了一部分
 *  3. 同名歧义弹候选卡，用户点哪个就读哪个
 *  4. read_file 标记了 readsPrivateData（读过之后外发要单独确认）
 */

const sandboxes: string[] = []

function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'butler-rf-'))
  sandboxes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
  setFileIndexRoots(null)
  resetFileIndex()
})

const ctx: ToolContext = {
  config: {} as never,
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

const find = (name: string, deps: Parameters<typeof createTools>[0] = {}): ToolDef => {
  const def = createTools(deps).find((t) => t.name === name)
  if (!def) throw new Error(`工具清单里没有 ${name}`)
  return def
}

/** 只记审计、不弹授权卡的闸门（read / ui 档本来也不会弹） */
function gate(hooks: Partial<GateHooks> = {}): GateHooks {
  return {
    requestAuth: async () => 'once' as const,
    isRemembered: () => false,
    remember: () => undefined,
    record: () => undefined,
    ...hooks
  }
}

function writeFile(dir: string, name: string, content: string): string {
  const full = path.join(dir, name)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

describe('open_file · 不执行程序', () => {
  it('exe 被拒，并指向 launch_app', async () => {
    const dir = sandbox()
    const exe = writeFile(dir, 'setup.exe', 'MZ fake')
    let opened = ''
    const def = find('open_file', {
      openFile: async (p) => {
        opened = p
        return ''
      }
    })
    const result = await executeThroughGate(def, { path: exe }, ctx, gate())
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('launch_app')
    expect(opened).toBe('')
  })

  it('bat / ps1 / lnk / msi / reg 同样拒绝', async () => {
    const dir = sandbox()
    const def = find('open_file', { openFile: async () => '' })
    for (const name of ['a.bat', 'a.ps1', 'a.lnk', 'a.msi', 'a.reg']) {
      const full = writeFile(dir, name, 'x')
      const result = await executeThroughGate(def, { path: full }, ctx, gate())
      expect(result.ok, name).toBe(false)
    }
  })
})

describe('open_file · 正常打开', () => {
  it('普通文档交给外壳打开，并留一条本地证据', async () => {
    const dir = sandbox()
    const doc = writeFile(dir, '报告.txt', '内容')
    let opened = ''
    const def = find('open_file', {
      openFile: async (p) => {
        opened = p
        return ''
      }
    })
    const result = await executeThroughGate(def, { path: doc }, ctx, gate())
    expect(result.ok).toBe(true)
    expect(opened).toBe(path.resolve(doc))
    expect(result.evidence?.[0].title).toContain('报告.txt')
  })

  it('外壳报错时如实说没打开，不让模型换名字重试', async () => {
    const dir = sandbox()
    const doc = writeFile(dir, '报告.txt', '内容')
    const def = find('open_file', { openFile: async () => '没有关联的程序' })
    const result = await executeThroughGate(def, { path: doc }, ctx, gate())
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('不要换个名字重试')
  })
})

describe('read_file · 把字读出来', () => {
  it('读到的正文进 data.text，summary 说明读了多少', async () => {
    const dir = sandbox()
    const doc = writeFile(dir, '会议纪要.txt', '结论：先做完闸门，再谈删除。')
    const def = find('read_file')
    const result = await executeThroughGate(def, { path: doc }, ctx, gate())
    expect(result.ok).toBe(true)
    const data = result.data as { text: string; complete: boolean; totalChars: number }
    expect(data.text).toBe('结论：先做完闸门，再谈删除。')
    expect(data.complete).toBe(true)
    expect(result.summary).toContain('全文')
  })

  it('长文件只读一段时，summary 明确说"只读到一部分"并给出 nextOffset', async () => {
    const dir = sandbox()
    const doc = writeFile(dir, '长文.txt', '甲'.repeat(5000))
    const def = find('read_file')
    const result = await executeThroughGate(def, { path: doc, maxChars: 1000 }, ctx, gate())
    expect(result.ok).toBe(true)
    const data = result.data as { nextOffset: number | null; complete: boolean; text: string }
    expect(data.complete).toBe(false)
    expect(data.nextOffset).toBe(1000)
    expect(data.text.length).toBe(1000)
    expect(result.summary).toContain('只读到一部分')
  })

  it('PDF 在读之前就拒绝，不留一条"读失败"的审计', async () => {
    const dir = sandbox()
    const pdf = path.join(dir, '合同.pdf')
    writeFileSync(pdf, '%PDF-1.7')
    const def = find('read_file')
    const result = await executeThroughGate(def, { path: pdf }, ctx, gate())
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('PDF')
  })

  it('read_file 标了 readsPrivateData（读过之后外发要确认）', () => {
    expect(find('read_file').readsPrivateData).toBe(true)
    // 反过来：open_file 只是摆个窗口，没有内容进上下文
    expect(find('open_file').readsPrivateData).toBeUndefined()
  })

  it('读 tier：不弹授权卡', async () => {
    const dir = sandbox()
    const doc = writeFile(dir, 'a.txt', 'x')
    let asked = 0
    const def = find('read_file')
    await executeThroughGate(
      def,
      { path: doc },
      ctx,
      gate({
        requestAuth: async () => {
          asked++
          return 'once' as const
        }
      })
    )
    expect(asked).toBe(0)
    expect(def.effect).toBe('read')
  })
})

describe('同名歧义 · 弹候选卡', () => {
  const twoFiles = (ext = 'docx'): { root: string; a: string; b: string } => {
    const root = sandbox()
    const a = writeFile(root, `甲/报告.${ext}`, 'A')
    const b = writeFile(root, `乙/报告.${ext}`, 'B')
    setFileIndexRoots([root])
    resetFileIndex()
    return { root, a, b }
  }

  it('两个同名文件 → 弹卡，每个候选都带完整路径', async () => {
    const { b } = twoFiles('docx')
    const asked: Array<Array<{ value: string; detail?: string }>> = []
    let opened = ''
    const def = find('open_file', {
      openFile: async (p) => {
        opened = p
        return ''
      }
    })
    const result = await executeThroughGate(def, { path: '报告.docx' }, ctx, gate({
      requestChoice: async (request) => {
        asked.push(request.options)
        return b
      }
    }))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toHaveLength(2)
    for (const opt of asked[0]) expect(opt.detail).toBe(opt.value)
    expect(result.ok).toBe(true)
    expect(opened).toBe(path.resolve(b))
  })

  it('read_file 的候选卡也一样：点哪个读哪个', async () => {
    // 用 .txt：这一段验的是"选完读的是哪一个"，不是 docx 能不能解
    const { a } = twoFiles('txt')
    const def = find('read_file')
    const result = await executeThroughGate(def, { path: '报告.txt' }, ctx, gate({
      requestChoice: async () => a
    }))
    expect(result.ok).toBe(true)
    expect((result.data as { text: string }).text).toBe('A')
  })

  it('没有候选卡能力的环境（评测/定时任务）→ 拒绝，不卡住', async () => {
    twoFiles('txt')
    const def = find('read_file')
    const result = await executeThroughGate(def, { path: '报告.txt' }, ctx, gate())
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })
})

describe('超长正文不会被整包丢掉', () => {
  /**
   * 这一段是 trimToolPayload 的回归：以前任何非数组的 data 超长都会变成
   * "明细过长已省略"，模型于是对用户说"读不了"——可文件明明读到了。
   */
  it('正文超长时截短正文并说明，而不是只剩一句"已省略"', () => {
    const text = '字'.repeat(20000)
    const payload = trimToolPayload({
      ok: true,
      summary: '读取「大文件.txt」',
      data: { text, complete: true, totalChars: text.length }
    })
    const parsed = JSON.parse(payload) as { data?: { text?: string }; note?: string }
    expect(parsed.data?.text?.length).toBeGreaterThan(0)
    expect(parsed.data?.text?.length).toBeLessThan(text.length)
    expect(parsed.note).toContain('截断')
    expect(payload.length).toBeLessThanOrEqual(6000)
  })
})
