import { describe, expect, it } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import type { ToolDef } from '../../src/main/agent/tool-types'
import type { AuthRequest, ButlerConfig, RecordEntry } from '../../src/shared/types'
import type { ToolContext } from '../../src/main/agent/tool-types'

const CTX: ToolContext = {
  config: {} as ButlerConfig,
  record: (e) => ({ ...e, id: 'x', ts: '2026-11-10T00:00:00.000Z' })
}

/**
 * requiresConfirmation 的语义锁定。
 *
 * 委派这类工具在文件系统层面只是"写了几个文件"，但它把内容交给一个无人值守的
 * 外部智能体。如果它按普通 write 自动放行，等于没人同意过；如果它允许「始终允许」，
 * 等于一次同意就永久放行。这两条都不能退。
 */

function hooks(answer: AuthRequest['allowAlways'] extends never ? never : 'once' | 'always' | 'deny', remembered = false) {
  const cards: AuthRequest[] = []
  const records: Omit<RecordEntry, 'id' | 'ts'>[] = []
  const h: GateHooks = {
    requestAuth: async (req) => {
      cards.push(req)
      return answer
    },
    isRemembered: () => remembered,
    remember: () => undefined,
    record: (e) => records.push(e)
  }
  return { h, cards, records }
}

function delegateLike(effect: 'write' | 'install', requiresConfirmation?: boolean): ToolDef {
  return {
    name: 'delegate_to_agent',
    label: '委派',
    description: '',
    effect,
    requiresConfirmation,
    allowAlways: requiresConfirmation ? false : undefined,
    parameters: { type: 'object', properties: {} },
    describeTarget: () => ({ title: '委派', target: '某任务', impact: '会发出去' }),
    run: async () => ({ ok: true, summary: '跑了' })
  }
}

describe('requiresConfirmation', () => {
  it('普通 write 自动放行，不弹卡', async () => {
    const { h, cards } = hooks('deny')
    const r = await executeThroughGate(delegateLike('write'), { a: 1 }, CTX, h)
    expect(cards.length).toBe(0)
    expect(r.ok).toBe(true)
  })

  it('带 requiresConfirmation 的 write 必须弹卡', async () => {
    const { h, cards } = hooks('once')
    const r = await executeThroughGate(
      delegateLike('write', true),
      { a: 1 },
      CTX,
      h
    )
    expect(cards.length).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('用户拒绝时什么都不执行', async () => {
    let ran = false
    const tool = delegateLike('write', true)
    tool.run = async () => {
      ran = true
      return { ok: true, summary: '跑了' }
    }
    const { h } = hooks('deny')
    const r = await executeThroughGate(tool, {}, CTX, h)
    expect(r.ok).toBe(false)
    expect(r.blocked).toBe(true)
    expect(ran).toBe(false)
  })

  it('卡片上的「始终允许」是关的，即便模型或界面传 always 也不写进记忆', async () => {
    let remembered = false
    const cards: AuthRequest[] = []
    const h: GateHooks = {
      requestAuth: async (req) => {
        cards.push(req)
        return 'always'
      },
      isRemembered: () => false,
      remember: () => {
        remembered = true
      },
      record: () => undefined
    }
    await executeThroughGate(delegateLike('write', true), {}, CTX, h)
    expect(cards[0].allowAlways).toBe(false)
    expect(remembered).toBe(false)
  })

  it('即使记忆里已经有这条，也照样弹卡', async () => {
    const { h, cards } = hooks('deny', true)
    const r = await executeThroughGate(delegateLike('write', true), {}, CTX, h)
    expect(cards.length).toBe(1) // 没被记忆短路
    expect(r.blocked).toBe(true)
  })
})
