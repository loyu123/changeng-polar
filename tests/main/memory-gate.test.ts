import { describe, expect, it } from 'vitest'
import { createTools } from '../../src/main/agent/tools'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import type { ToolContext } from '../../src/main/agent/tool-types'
import type { AuthRequest, ButlerConfig, RecordEntry } from '../../src/shared/types'

/**
 * 记忆必须过卡。
 *
 * 真机实测抓到的原状：日志里 `save_memory ... authz=auto` —— 自动放行，
 * 一次卡都没弹，而标签上明明写着「需确认」。
 *
 * 为什么记忆要过卡而不是像普通 write 那样自动放行：它改变的是
 * "长庚以后怎么看你"。一句记错的偏好会一直生效，而下次对话你看不到
 * 它是被什么时候写进去的。删记忆同理。
 */

const CTX: ToolContext = {
  config: {} as ButlerConfig,
  record: (e) => ({ ...e, id: 'x', ts: '' })
}

const deps = {
  memory: {
    list: async () => [],
    save: async () => undefined
  }
}

function hooks(answer: 'once' | 'always' | 'deny') {
  const cards: AuthRequest[] = []
  const recorded: Omit<RecordEntry, 'id' | 'ts'>[] = []
  const h: GateHooks = {
    requestAuth: async (req) => {
      cards.push(req)
      return answer
    },
    isRemembered: () => false,
    remember: () => undefined,
    record: (e) => recorded.push(e)
  }
  return { h, cards, recorded }
}

function tool(name: string) {
  const def = createTools(deps as never).find((t) => t.name === name)
  if (!def) throw new Error(`没有工具 ${name}`)
  return def
}

describe('记忆类工具必须过卡', () => {
  it('save_memory 带 requiresConfirmation，且不允许「始终允许」', () => {
    const def = tool('save_memory')
    expect(def.requiresConfirmation).toBe(true)
    expect(def.allowAlways).toBe(false)
  })

  it('forget_memory 带 requiresConfirmation，且不允许「始终允许」', () => {
    const def = tool('forget_memory')
    expect(def.requiresConfirmation).toBe(true)
    expect(def.allowAlways).toBe(false)
  })

  it('记住一件事时真的弹了卡（不再是 authz=auto）', async () => {
    const { h, cards } = hooks('once')
    const r = await executeThroughGate(tool('save_memory'), { text: '我在做长庚项目' }, CTX, h)
    expect(cards).toHaveLength(1)
    expect(cards[0].tool).toBe('save_memory')
    expect(r.ok).toBe(true)
  })

  it('卡片上写清楚它会一直生效，而不是只说「记条笔记」', async () => {
    const { h, cards } = hooks('once')
    await executeThroughGate(tool('save_memory'), { text: 'x' }, CTX, h)
    expect(cards[0].impact).toMatch(/每次对话|一直生效/)
  })

  it('用户拒绝时什么都不写', async () => {
    let saved = false
    const def = createTools({
      memory: {
        list: async () => [],
        save: async () => {
          saved = true
        }
      }
    } as never).find((t) => t.name === 'save_memory')!
    const { h } = hooks('deny')
    const r = await executeThroughGate(def, { text: 'x' }, CTX, h)
    expect(r.blocked).toBe(true)
    expect(saved).toBe(false)
  })

  it('卡片上的「始终允许」是关的，传 always 也不写进记忆', async () => {
    const { h, cards } = hooks('always')
    await executeThroughGate(tool('save_memory'), { text: 'x' }, CTX, h)
    expect(cards[0].allowAlways).toBe(false)
  })

  it('删记忆也弹卡', async () => {
    const { h, cards } = hooks('once')
    await executeThroughGate(tool('forget_memory'), { ref: '旧记忆' }, CTX, h)
    expect(cards).toHaveLength(1)
    expect(cards[0].tool).toBe('forget_memory')
  })
})
