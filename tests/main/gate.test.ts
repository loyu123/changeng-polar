import { describe, expect, it, vi } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import type { ToolContext, ToolDef } from '../../src/main/agent/tool-types'
import type { AuthAnswer, AuthRequest, RecordEntry } from '../../src/shared/types'

/**
 * 授权闸门的三档状态机。
 *
 * 这是整个产品最关键的一段代码：判错的后果是"用户没批准，东西已经被删掉了"。
 * 全部用注入的假 requestAuth 驱动，不碰 Electron、不碰真实文件。
 */

const ctx: ToolContext = {
  config: {} as ToolContext['config'],
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

/** 造一个只回显结果的工具，用来观察闸门到底执行了没有 */
function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'demo_destroy',
    label: '演示销毁',
    description: '用于测试',
    effect: 'destroy',
    parameters: { type: 'object', properties: {} },
    describeTarget: () => ({ title: '删掉演示文件', target: 'C:\\demo.txt', impact: '不可撤回' }),
    run: vi.fn(async () => ({ ok: true, summary: '已执行' })),
    ...overrides
  }
}

function makeHooks(answer: AuthAnswer, remembered = false) {
  const records: Array<Omit<RecordEntry, 'id' | 'ts'>> = []
  const requested: AuthRequest[] = []
  const rememberedKeys: string[] = []
  const hooks: GateHooks = {
    requestAuth: async (req) => {
      requested.push(req)
      return answer
    },
    isRemembered: (key) => remembered || rememberedKeys.includes(key),
    remember: (key) => {
      rememberedKeys.push(key)
    },
    record: (entry) => {
      records.push(entry)
    }
  }
  return { hooks, records, requested, rememberedKeys }
}

describe('授权闸门 · 销毁类', () => {
  it('用户点「允许这一次」→ 真正执行，审计记 user_once', async () => {
    const tool = makeTool()
    const { hooks, records } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(tool.run).toHaveBeenCalledOnce()
    expect(records.at(-1)).toMatchObject({ result: 'ok', authz: 'user_once' })
  })

  it('用户点「拒绝」→ 一次都不执行，审计记 denied', async () => {
    const tool = makeTool()
    const { hooks, records } = makeHooks('deny')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)).toMatchObject({ result: 'rejected', authz: 'denied' })
  })

  it('60 秒超时 → 等同拒绝，但审计单独记 expired（和主动拒绝区分开）', async () => {
    const tool = makeTool()
    const { hooks, records } = makeHooks('expired')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)).toMatchObject({ result: 'rejected', authz: 'expired' })
    // 提示语要说清是超时，不能说成"用户拒绝了"
    expect(result.summary).toMatch(/60 秒/)
  })

  it('畸形答案（undefined / 任意字符串）一律按拒绝处理', async () => {
    for (const bogus of [undefined, 'yes', 'allow', 1, null, {}] as unknown[]) {
      const tool = makeTool()
      const { hooks } = makeHooks('once')
      const result = await executeThroughGate(tool, {}, ctx, {
        ...hooks,
        requestAuth: async () => bogus as AuthAnswer
      })
      expect(result.ok, String(bogus)).toBe(false)
      expect(tool.run, String(bogus)).not.toHaveBeenCalled()
    }
  })
})

describe('授权闸门 · 「始终允许」', () => {
  it('allowAlways 的工具点「始终允许」→ 写进记忆并执行', async () => {
    const tool = makeTool({ effect: 'install', allowAlways: true })
    const { hooks, rememberedKeys } = makeHooks('always')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(rememberedKeys).toEqual(['demo_destroy::C:\\demo.txt'])
  })

  it('记忆命中时不再弹卡，直接执行', async () => {
    const tool = makeTool({ effect: 'install', allowAlways: true })
    const { hooks, requested } = makeHooks('deny', true)
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(requested).toHaveLength(0)
  })

  it('销毁类即使被写进记忆，也必须每次弹卡', async () => {
    // allowAlways 缺省为 false：删除/卸载永远逐次授权
    const tool = makeTool({ effect: 'destroy' })
    const { hooks, requested } = makeHooks('once', true)
    await executeThroughGate(tool, {}, ctx, hooks)
    expect(requested).toHaveLength(1)
  })

  it('目标变了，旧记忆不生效（key 含 target）', async () => {
    const tool = makeTool({ effect: 'install', allowAlways: true })
    const { hooks, requested } = makeHooks('deny')
    await executeThroughGate(tool, {}, ctx, {
      ...hooks,
      isRemembered: () => false // 模拟 key 不匹配
    })
    expect(requested).toHaveLength(1)
  })
})

describe('授权闸门 · 读/写与失败处理', () => {
  it('read 自动放行，不弹卡', async () => {
    const tool = makeTool({ effect: 'read' })
    const { hooks, requested } = makeHooks('deny')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(requested).toHaveLength(0)
  })

  it('write 自动放行，但备份失败就不执行', async () => {
    const tool = makeTool({
      effect: 'write',
      backup: async () => ({ ok: false, detail: '磁盘满' })
    })
    const { hooks, records } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)).toMatchObject({ result: 'rejected' })
  })

  it('effect 未声明或非法 → 不执行（宁可少做一次，也不猜它危不危险）', async () => {
    const tool = makeTool({ effect: 'wat' as ToolDef['effect'] })
    const { hooks, records } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('refuse')
  })

  it('plan 解析不出唯一目标 → 不弹卡、不执行（不让人批准"还没确定的东西"）', async () => {
    const tool = makeTool({
      plan: async () => ({ ok: false, reason: 'winget 里有多条匹配' })
    })
    const { hooks, requested, records } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(requested).toHaveLength(0)
    expect(records.at(-1)?.kind).toBe('refuse')
  })

  it('演练模式：判定照走，但不真正执行', async () => {
    const tool = makeTool()
    const { hooks } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, { ...hooks, dryRun: true })
    expect(result.ok).toBe(true)
    expect(tool.run).not.toHaveBeenCalled()
    expect(result.summary).toMatch(/没有真正执行/)
  })
})
