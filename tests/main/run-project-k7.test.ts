import { describe, expect, it } from 'vitest'
import { createTools } from '../../src/main/agent/tools'
import type { ToolContext } from '../../src/main/agent/tool-types'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * K7 不变量：候选卡上用户点的那个 value，必须能从"解析出来的目标"里找回来。
 *
 * 真机踩过：run_project 的 target 写成纯人话（"4 个任务 · 串行"），
 * 里面不含候选卡的原始值 `serial`，于是闸门的 `target.includes(picked)` 永远是假，
 * **每次选串行都被判成"解析结果与你的选择不一致"而拒绝**。
 *
 * 这条测试锁的是：所有会弹候选卡的工具，target 里都要带上原始 value。
 */

const CTX: ToolContext = {
  config: {} as ButlerConfig,
  record: (e) => ({ ...e, id: 'x', ts: '' })
}

const deps = { delegate: { rootDir: 'C:/tmp/orch', worker: { provider: 'p', model: 'm' } } }

function tasks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `任务${i}`,
    prompt: `做${i}`,
    dependsOn: [] as string[],
    acceptance: [{ kind: 'file-exists', path: `o${i}.md` }]
  }))
}

describe('run_project 的 K7 不变量', () => {
  it('选了 serial 之后，target 里必须能找回 "serial"', async () => {
    const def = createTools(deps as never).find((t) => t.name === 'run_project')!
    const plan = await def.plan!(
      { name: '示例', tasks: tasks(3), mode: 'serial' },
      CTX
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // 这就是闸门做的那件事
    expect(plan.target.target.includes('serial')).toBe(true)
  })

  it('选了 parallel:2 之后，target 里必须能找回 "parallel:2"', async () => {
    const def = createTools(deps as never).find((t) => t.name === 'run_project')!
    const plan = await def.plan!(
      { name: '示例', tasks: tasks(4), mode: 'parallel:2' },
      CTX
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.target.target.includes('parallel:2')).toBe(true)
  })

  it('候选卡给出的每个选项值，选中后都能在 target 里找回', async () => {
    const def = createTools(deps as never).find((t) => t.name === 'run_project')!
    // 先不带 mode，让它弹卡，拿到选项
    const first = await def.plan!({ name: '示例', tasks: tasks(4) }, CTX)
    expect(first.ok).toBe(false)
    if (first.ok || !first.choice) return
    const values = first.choice.options.map((o) => o.value)
    expect(values.length).toBeGreaterThan(1)

    // 每个选项都真的选一遍，验证闸门的检查能通过
    for (const value of values) {
      const plan = await def.plan!({ name: '示例', tasks: tasks(4), mode: value }, CTX)
      expect(plan.ok, `选项 ${value} 应当能继续`).toBe(true)
      if (!plan.ok) continue
      expect(
        plan.target.target.includes(value),
        `target「${plan.target.target}」里找不到选项值 ${value}`
      ).toBe(true)
    }
  })

  it('用户没选 mode、但计划只有串行一种时，target 也要能找回 serial', async () => {
    const def = createTools(deps as never).find((t) => t.name === 'run_project')!
    // 链式计划：分层宽度 1/1，候选卡只会给 serial 一项，所以不必弹卡
    const chain = [
      { id: 'a', title: 'A', prompt: 'a', dependsOn: [] as string[], acceptance: [{ kind: 'file-exists', path: 'a.md' }] },
      { id: 'b', title: 'B', prompt: 'b', dependsOn: ['a'], acceptance: [{ kind: 'file-exists', path: 'b.md' }] }
    ]
    const plan = await def.plan!({ name: '链式', tasks: chain }, CTX)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.target.target.includes('serial')).toBe(true)
  })
})
