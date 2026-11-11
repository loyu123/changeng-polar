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

/**
 * 候选卡：名字有歧义时先问「是哪一个」，选完**重新解析**再走授权卡。
 *
 * 这里要钉住的是三步都是必要步骤，少一步就回到"用户点了 A、实际装 B"：
 *   1. 用户的选择必须写回参数并重新 plan（不能拿"用户选了"当执行许可）
 *   2. 重新 plan 出的目标必须真的包含用户选的值（工具实现错了就停下）
 *   3. 授权卡照旧弹（选候选 ≠ 同意安装）
 */
describe('授权闸门 · 候选卡（歧义选择）', () => {
  /** 一个"名字有歧义"的安装类工具：args.name 是包 Id 才认 */
  function makeChooser(execute: (args: Record<string, any>) => Promise<{ ok: boolean; summary: string }>) {
    const seen: Array<Record<string, any>> = []
    const tool = makeTool({
      name: 'install_demo',
      label: '安装演示软件',
      effect: 'install',
      allowAlways: false,
      plan: async (args) => {
        const id = String(args.name ?? '')
        // 只有拿到包 Id 才算唯一目标；否则就是要用户选
        if (!id.includes('.')) {
          return {
            ok: false,
            reason: '有多个候选',
            choice: {
              title: '你要装哪一个？',
              pickInto: 'name',
              options: [
                { value: 'Pub.Kimi', label: 'Kimi' },
                { value: 'Pub.KimiCLI', label: 'Kimi CLI' }
              ]
            }
          }
        }
        return {
          ok: true,
          target: { title: `安装：${id}`, target: `${id} 1.0.0`, impact: '会弹安装器，要用户自己点完' },
          execute: async () => execute(args)
        }
      },
      run: vi.fn(async () => ({ ok: true, summary: '不该走到 run' }))
    })
    return { tool, seen }
  }

  function hooksWith(picked: string | null | undefined, answer: AuthAnswer = 'once') {
    const base = makeHooks(answer)
    const asked: string[] = []
    if (picked === undefined) return { ...base, asked } // 不提供 requestChoice
    return {
      ...base,
      asked,
      hooks: {
        ...base.hooks,
        requestChoice: async (req: { options: Array<{ value: string }> }) => {
          asked.push(...req.options.map((o: { value: string }) => o.value))
          return picked
        }
      }
    }
  }

  it('用户选了候选 → 写回参数、重新解析、再弹授权卡，执行的正是他选的那个', async () => {
    const executed: string[] = []
    const { tool } = makeChooser(async (args) => {
      executed.push(String(args.name))
      return { ok: true, summary: '装好了' }
    })
    const { hooks, records, requested, asked } = hooksWith('Pub.KimiCLI')
    const result = await executeThroughGate(tool, { name: 'kimi' }, ctx, hooks)

    expect(asked).toEqual(['Pub.Kimi', 'Pub.KimiCLI'])
    expect(result.ok).toBe(true)
    // 执行的是用户点的那个 Id，不是最初那个模糊名字
    expect(executed).toEqual(['Pub.KimiCLI'])
    // 授权卡照旧弹了一次，而且卡上的目标与最终执行出自同一次解析（K7）
    expect(requested).toHaveLength(1)
    expect(requested[0].target).toContain('Pub.KimiCLI')
    // 审计要能回答"我点了哪一个"
    expect(records.some((r) => r.title.startsWith('选择：'))).toBe(true)
  })

  it('用户取消选择 → 不弹授权卡、不执行，审计留一条"什么都没改动"', async () => {
    const { tool } = makeChooser(async () => ({ ok: true, summary: '装好了' }))
    const { hooks, records, requested } = hooksWith(null)
    const result = await executeThroughGate(tool, { name: 'kimi' }, ctx, hooks)

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(requested).toHaveLength(0)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)?.kind).toBe('refuse')
    expect(records.at(-1)?.sub).toMatch(/取消/)
  })

  it('没有候选卡能力的环境（评测/定时任务）→ 退回旧行为：拒绝', async () => {
    const { tool } = makeChooser(async () => ({ ok: true, summary: '装好了' }))
    const { hooks, requested } = hooksWith(undefined)
    const result = await executeThroughGate(tool, { name: 'kimi' }, ctx, hooks)

    expect(result.ok).toBe(false)
    expect(requested).toHaveLength(0)
    expect(tool.run).not.toHaveBeenCalled()
  })

  it('选完重新解析出的目标不含所选值 → 拒绝（工具实现错了不能将就）', async () => {
    const tool = makeTool({
      name: 'install_demo',
      label: '安装演示软件',
      effect: 'install',
      // 无论选什么，都解析成同一个写死的目标
      plan: async (args) =>
        String(args.name ?? '').includes('.')
          ? {
              ok: true,
              target: { title: '安装：别的东西', target: 'Pub.Other 9.9.9', impact: '会弹安装器，要用户自己点完' },
              execute: async () => ({ ok: true, summary: '装了别的' })
            }
          : {
              ok: false,
              reason: '有多个候选',
              choice: { title: '选一个', pickInto: 'name', options: [{ value: 'Pub.Kimi', label: 'Kimi' }] }
            },
      run: vi.fn(async () => ({ ok: true, summary: '不该走到 run' }))
    })
    const { hooks, requested, records } = hooksWith('Pub.Kimi')
    const result = await executeThroughGate(tool, { name: 'kimi' }, ctx, hooks)

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(requested).toHaveLength(0)
    expect(tool.run).not.toHaveBeenCalled()
    expect(records.at(-1)?.sub).toMatch(/不一致/)
  })

  it('选完仍然解析不出唯一目标 → 拒绝', async () => {
    const tool = makeTool({
      name: 'install_demo',
      label: '安装演示软件',
      effect: 'install',
      plan: async () => ({ ok: false, reason: '还是不确定', choice: { title: '选一个', pickInto: 'name', options: [{ value: 'Pub.Kimi', label: 'Kimi' }] } }),
      run: vi.fn(async () => ({ ok: true, summary: '不该走到 run' }))
    })
    const { hooks, requested } = hooksWith('Pub.Kimi')
    const result = await executeThroughGate(tool, { name: 'kimi' }, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(requested).toHaveLength(0)
  })

  it('选完工具自己拒绝了 → 原样转述它的理由，不改口说成「解析不出唯一目标」', async () => {
    // 典型场景：用户选了「哔哩哔哩」，工具发现它已经装着了。
    // 这时候我们知道得很清楚，说成"没能确认要做什么"就是在替用户瞎猜
    let pass = 0
    const tool = makeTool({
      name: 'install_demo',
      label: '安装演示软件',
      effect: 'install',
      plan: async () => {
        pass += 1
        if (pass === 1) {
          return { ok: false, reason: '有多个候选', choice: { title: '选一个', pickInto: 'name', options: [{ value: 'Pub.Bili', label: '哔哩哔哩' }] } }
        }
        return { ok: false, reason: '「哔哩哔哩」已经装在这台机器上了，这一轮没有安装任何东西' }
      },
      run: vi.fn(async () => ({ ok: true, summary: '不该走到 run' }))
    })
    const { hooks, records } = hooksWith('Pub.Bili')
    const result = await executeThroughGate(tool, { name: '哔哩哔哩' }, ctx, hooks)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('已经装在这台机器上了')
    expect(result.summary).not.toContain('未能确认')
    expect(result.summary).not.toMatch(/解析不出/)
    expect(records.at(-1)?.sub).toContain('已经装在这台机器上了')
  })
})

describe('授权闸门 · 后台任务（安装）', () => {
  /**
   * 安装不再占住整轮对话：工具把活放到后台，立刻返回。
   *
   * 这里锁的是记账的时机——**不能在安装器刚弹出来的时候就记一条 ok**。
   * 记账晚一点没问题，记错是另一回事：那条 ok 会进应用台账，
   * 于是"管家装的"变成一句没根据的话。
   */
  const deferredTool = (final: () => Promise<{ ok: boolean; summary: string; verify?: { state: 'confirmed'; fact: string } }>) => {
    let settle!: (r: Awaited<ReturnType<typeof final>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof final>>>((resolve) => {
      settle = resolve
    })
    const tool = makeTool({
      effect: 'install',
      allowAlways: true,
      run: vi.fn(async () => ({
        ok: true,
        summary: '「哔哩哔哩」的安装已经开始了',
        deferred: pending.then(() => final())
      }))
    })
    return { tool, settle }
  }

  it('立刻返回，不在这一刻记账', async () => {
    const { tool } = deferredTool(async () => ({ ok: true, summary: '装好了' }))
    const { hooks, records } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.summary).toContain('安装已经开始了')
    expect(records).toHaveLength(0)
  })

  it('返回给调用方的那一份不带 deferred（Promise 不该跟着结果流出去）', async () => {
    const { tool } = deferredTool(async () => ({ ok: true, summary: '装好了' }))
    const { hooks } = makeHooks('once')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect('deferred' in result).toBe(false)
  })

  it('落定之后才写审计，且只写一条，authz 仍是用户批的那次', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const tool = makeTool({
      effect: 'install',
      allowAlways: true,
      run: vi.fn(async () => ({
        ok: true,
        summary: '安装已经开始了',
        deferred: gate.then(() => ({ ok: true, summary: '已通过 winget 安装「哔哩哔哩」', verify: { state: 'confirmed' as const, fact: '核过程序清单：在册' } }))
      }))
    })
    const { hooks, records } = makeHooks('once')
    await executeThroughGate(tool, {}, ctx, hooks)
    expect(records).toHaveLength(0)

    release()
    // 让 then 链跑完（含事实核对那一跳）
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      result: 'ok',
      authz: 'user_once',
      tool: 'demo_destroy',
      // 核对结果要跟着记录走：没有它，记录页只能说"装成功了"而说不出查到了什么
      verified: 'confirmed'
    })
  })

  it('后台失败了也留痕：不能出现"装过但不知道怎么样"的记录', async () => {
    const tool = makeTool({
      effect: 'install',
      allowAlways: true,
      run: vi.fn(async () => ({
        ok: true,
        summary: '安装已经开始了',
        deferred: Promise.reject(new Error('winget 进程被系统杀掉'))
      }))
    })
    const { hooks, records } = makeHooks('once')
    await executeThroughGate(tool, {}, ctx, hooks)
    await new Promise((r) => setTimeout(r, 0))
    expect(records).toHaveLength(1)
    expect(records[0].result).toBe('partial')
    expect(records[0].sub).toContain('winget 进程被系统杀掉')
  })

  it('后台最终没装成 → 审计记 partial，不写成 ok', async () => {
    const tool = makeTool({
      effect: 'install',
      allowAlways: true,
      run: vi.fn(async () => ({
        ok: true,
        summary: '安装已经开始了',
        deferred: Promise.resolve({ ok: false, summary: '你在安装器里取消了安装' })
      }))
    })
    const { hooks, records } = makeHooks('once')
    await executeThroughGate(tool, {}, ctx, hooks)
    await new Promise((r) => setTimeout(r, 0))
    expect(records.at(-1)?.result).toBe('partial')
  })

  it('用户拒绝时根本不会执行，也就没有后台任务', async () => {
    const run = vi.fn(async () => ({ ok: true, summary: 'x', deferred: Promise.resolve({ ok: true, summary: 'x' }) }))
    const tool = makeTool({ effect: 'install', allowAlways: true, run })
    const { hooks, records } = makeHooks('deny')
    const result = await executeThroughGate(tool, {}, ctx, hooks)
    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(records.at(-1)?.result).toBe('rejected')
  })
})
