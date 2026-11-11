import { describe, expect, it, vi } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import { trimToolPayload } from '../../src/main/agent/agent'
import type { ToolContext, ToolDef } from '../../src/main/agent/tool-types'
import type { RecordEntry } from '../../src/shared/types'

/**
 * 写操作之后的事实核对。
 *
 * 这一段的存在理由只有一个：在此之前，"装好了 / 删干净了 / 传上去了"全靠模型
 * 照着工具那句回执念，于是回执就成了事实。核对要挡住三种会悄悄退回去的情况：
 * 没核对却看起来像通过了、核对了对不上却报成成功、以及动作本身失败时还去"核对"。
 */

const ctx: ToolContext = {
  config: {} as ToolContext['config'],
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

function makeTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'demo_write',
    label: '演示写入',
    description: '用于测试',
    effect: 'write',
    parameters: { type: 'object', properties: {} },
    describeTarget: () => ({ title: '写一个演示文件', target: 'C:\\demo.txt', impact: '可撤回' }),
    run: vi.fn(async () => ({ ok: true, summary: '已执行' })),
    ...overrides
  }
}

function makeHooks(): GateHooks & { records: Array<Omit<RecordEntry, 'id' | 'ts'>> } {
  const records: Array<Omit<RecordEntry, 'id' | 'ts'>> = []
  return {
    records,
    requestAuth: async () => 'once',
    isRemembered: () => false,
    remember: () => {},
    record: (entry) => {
      records.push(entry)
    }
  }
}

describe('事后核对 · 谁来跑', () => {
  it('工具声明了 verify → 动作成功后自动跑，结论跟着结果回去', async () => {
    const verify = vi.fn(async () => ({ state: 'confirmed' as const, fact: '重新查了一次：在' }))
    const tool = makeTool({ verify })
    const hooks = makeHooks()
    const result = await executeThroughGate(tool, { path: 'x' }, ctx, hooks)
    expect(verify).toHaveBeenCalledOnce()
    expect(result.verify).toEqual({ state: 'confirmed', fact: '重新查了一次：在' })
  })

  it('工具没声明 verify → 填一条 unavailable，而不是让它看起来像通过了', async () => {
    const tool = makeTool()
    const hooks = makeHooks()
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(result.verify?.state).toBe('unavailable')
    expect(result.verify?.fact).toContain('没有实现事后核对')
  })

  it('工具自己在结果里填了 verify（执行过程中已经查过）→ 不再重复跑一遍', async () => {
    const verify = vi.fn(async () => ({ state: 'confirmed' as const, fact: '不该被调用' }))
    const tool = makeTool({
      verify,
      run: vi.fn(async () => ({
        ok: true,
        summary: '装完了',
        verify: { state: 'confirmed' as const, fact: '装的过程中查过了' }
      }))
    })
    const result = await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(verify).not.toHaveBeenCalled()
    expect(result.verify?.fact).toBe('装的过程中查过了')
  })

  it('read / ui 不核对：它们不改东西，没有"事后"可言', async () => {
    const verify = vi.fn(async () => ({ state: 'mismatch' as const, fact: '不该被调用' }))
    const tool = makeTool({ effect: 'read', verify })
    const result = await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(verify).not.toHaveBeenCalled()
    expect(result.verify).toBeUndefined()
  })

  it('动作本身失败 → 不核对（失败时没有可核对的东西）', async () => {
    const verify = vi.fn(async () => ({ state: 'confirmed' as const, fact: '不该被调用' }))
    const tool = makeTool({
      verify,
      run: vi.fn(async () => ({ ok: false, summary: '没写成' }))
    })
    const result = await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(verify).not.toHaveBeenCalled()
    expect(result.verify).toBeUndefined()
  })

  it('核对自己抛异常 → 降级成 unavailable 并带上原因，绝不当成通过', async () => {
    const tool = makeTool({
      verify: async () => {
        throw new Error('注册表读不了')
      }
    })
    const result = await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(result.verify?.state).toBe('unavailable')
    expect(result.verify?.fact).toContain('注册表读不了')
  })
})

describe('事后核对 · 结论与审计', () => {
  it('对不上时也照常返回结果，但结论是 mismatch（不许改写成成功）', async () => {
    const tool = makeTool({ verify: async () => ({ state: 'mismatch' as const, fact: '文件还在原处' }) })
    const result = await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(result.ok).toBe(true)
    expect(result.verify?.state).toBe('mismatch')
  })

  it('核对结果进审计记录：能回答"那次到底查没查、查到什么"', async () => {
    const tool = makeTool({ verify: async () => ({ state: 'confirmed' as const, fact: '重新查了一次：在册' }) })
    const hooks = makeHooks()
    await executeThroughGate(tool, {}, ctx, hooks)
    expect(hooks.records.at(-1)).toMatchObject({ verified: 'confirmed', verifyFact: '重新查了一次：在册' })
  })

  it('销毁类（要过卡）同样核对', async () => {
    const verify = vi.fn(async () => ({ state: 'confirmed' as const, fact: '没了' }))
    const tool = makeTool({ effect: 'destroy', verify })
    await executeThroughGate(tool, {}, ctx, makeHooks())
    expect(verify).toHaveBeenCalledOnce()
  })

  it('演练模式（dryRun）不核对：什么都没执行', async () => {
    const verify = vi.fn(async () => ({ state: 'confirmed' as const, fact: '不该被调用' }))
    const tool = makeTool({ effect: 'destroy', verify })
    const hooks = { ...makeHooks(), dryRun: true }
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(verify).not.toHaveBeenCalled()
    expect(result.verify).toBeUndefined()
  })
})

describe('事后核对 · 交给模型的那一份', () => {
  it('verify 随结果一起给模型（否则它只有回执那句话可念）', () => {
    const payload = trimToolPayload({
      ok: true,
      summary: '已删除',
      verify: { state: 'mismatch', fact: '文件还在原处' }
    })
    expect(JSON.parse(payload)).toMatchObject({ verify: { state: 'mismatch', fact: '文件还在原处' } })
  })

  it('结果超长被截断时，verify 仍然在（它不参与截断）', () => {
    const data = Array.from({ length: 400 }, (_, i) => ({ i, text: 'x'.repeat(60) }))
    const payload = trimToolPayload({
      ok: true,
      summary: '装完了',
      data,
      verify: { state: 'confirmed', fact: '程序清单里查到了' }
    })
    expect(payload.length).toBeLessThan(6500)
    expect(JSON.parse(payload)).toMatchObject({ verify: { state: 'confirmed', fact: '程序清单里查到了' } })
  })

  it('没有核对时不凭空造一个字段', () => {
    const parsed = JSON.parse(trimToolPayload({ ok: true, summary: '读完了' }))
    expect(parsed).not.toHaveProperty('verify')
  })
})
