import { describe, expect, it, vi } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import type { ToolDef } from '../../src/main/agent/tool-types'
import { InputGrant } from '../../src/main/node/input-grant'

/**
 * 时间窗授权在闸门里的行为。
 *
 * 这是「模拟键鼠」最容易被做错的一处：用户批准一次，接下来 60 秒内不再问。
 * 如果窗口判断写错，要么变成"批一次永远放行"（安全塌了），
 * 要么变成"窗口内还在问"（功能等于没做，用户还是批到手软）。
 *
 * 所以这里测的是闸门这一层的**组合行为**：grant 有效 → 不弹卡但照常审计；
 * grant 无效 → 老老实实弹卡。
 */

const makeTool = (name: string): ToolDef => ({
  name,
  label: name,
  description: 'x',
  effect: 'destroy',
  allowAlways: false,
  requiresConfirmation: true,
  parameters: { type: 'object', properties: {} },
  describeTarget: () => ({ title: `动作 ${name}`, target: 'target', impact: '影响' }),
  run: async () => ({ ok: true, summary: 'done' })
})

function hooks(overrides: Partial<GateHooks> = {}) {
  const records: Array<Record<string, unknown>> = []
  const requestAuth = vi.fn(async () => 'once' as const)
  const h: GateHooks = {
    requestAuth,
    isRemembered: () => false,
    remember: () => {},
    record: (e) => records.push(e as Record<string, unknown>),
    ...overrides
  }
  return { hooks: h, records, requestAuth }
}

describe('时间窗授权 · 闸门层', () => {
  it('grant 有效时不弹卡，但审计记 authz=grant（看得出是窗口内，不是自动放行）', async () => {
    const grant = new InputGrant()
    grant.open('点保存')
    const { hooks: h, records, requestAuth } = hooks({
      hasActiveGrant: (name) => name === 'click_screen' && grant.active
    })

    const r = await executeThroughGate(makeTool('click_screen'), {}, {} as never, h)
    expect(r.ok).toBe(true)
    expect(requestAuth).not.toHaveBeenCalled()
    expect(records[0]?.authz).toBe('grant')
    expect(records[0]?.result).toBe('ok')
  })

  it('grant 没有时不弹卡是错的：必须老老实实弹', async () => {
    const { hooks: h, requestAuth } = hooks({ hasActiveGrant: () => false })
    await executeThroughGate(makeTool('click_screen'), {}, {} as never, h)
    expect(requestAuth).toHaveBeenCalledTimes(1)
  })

  it('hasActiveGrant 只对声明的那几个工具生效，别的工具不该蹭这个窗口', async () => {
    const grant = new InputGrant()
    grant.open()
    // 模拟 runtime 里的实现：只有三个输入类工具才查窗口
    const INPUT = ['click_screen', 'type_text', 'press_keys']
    const { hooks: h, requestAuth } = hooks({
      hasActiveGrant: (name) => INPUT.includes(name) && grant.active
    })

    await executeThroughGate(makeTool('uninstall_app'), {}, {} as never, h)
    expect(requestAuth).toHaveBeenCalledTimes(1)
  })

  it('窗口过期后立刻恢复弹卡', async () => {
    let t = 1_000_000
    const grant = new InputGrant(() => t)
    grant.open()
    const { hooks: h, requestAuth } = hooks({
      hasActiveGrant: () => grant.active
    })
    await executeThroughGate(makeTool('click_screen'), {}, {} as never, h)
    expect(requestAuth).not.toHaveBeenCalled()

    t += 61_000
    await executeThroughGate(makeTool('click_screen'), {}, {} as never, h)
    expect(requestAuth).toHaveBeenCalledTimes(1)
  })

  it('没提供 hasActiveGrant 的环境（评测）不会蹭到免卡', async () => {
    const { hooks: h, requestAuth } = hooks()
    await executeThroughGate(makeTool('click_screen'), {}, {} as never, h)
    expect(requestAuth).toHaveBeenCalledTimes(1)
  })
})
