import { describe, expect, it } from 'vitest'
import { executeThroughGate, type GateHooks } from '../../src/main/agent/gate'
import type { ToolDef } from '../../src/main/agent/tool-types'

/**
 * 拒绝记录必须能回答「它想干什么」。
 *
 * 真机踩到过：点击屏幕被拒，记录里只有「没有执行：点击屏幕（需授权）」，
 * 没有工具名、没有当时的参数。想知道"是模型选错了坐标还是白名单不让"，
 * 只能翻聊天记录去猜。
 *
 * 现在的口径：拒绝记录必须带 `tool`（哪个工具）、`sub`（为什么拒）、
 * `argsPreview`（它给的什么参数）。三样缺一，事后就查不清。
 */

function recorder(): { hooks: GateHooks; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = []
  return {
    records,
    hooks: {
      requestAuth: async () => 'once',
      isRemembered: () => false,
      remember: () => {},
      record: (e) => records.push(e as Record<string, unknown>)
    }
  }
}

/** plan 直接失败的工具（模拟"坐标上没有窗口"这类） */
const failingTool = (name: string, reason: string): ToolDef => ({
  name,
  label: `${name}（需授权）`,
  description: 'x',
  effect: 'destroy',
  allowAlways: false,
  requiresConfirmation: true,
  parameters: { type: 'object', properties: {} },
  plan: async () => ({ ok: false, reason }),
  run: async () => ({ ok: true, summary: '不应执行' })
})

describe('拒绝记录 · 三样都要有', () => {
  it('plan 失败时记下工具名、拒绝原因、当时的参数', async () => {
    const { hooks, records } = recorder()
    await executeThroughGate(
      failingTool('click_screen', '坐标 (450, 300) 上没有可操作的窗口'),
      { x: 450, y: 300, reason: '点一下' },
      {} as never,
      hooks
    )

    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.tool).toBe('click_screen')
    expect(r.sub).toContain('没有可操作的窗口')
    expect(r.result).toBe('rejected')
    // 参数是判断"模型选错目标"的唯一依据
    expect(String(r.argsPreview)).toContain('450')
    expect(String(r.argsPreview)).toContain('300')
  })

  it('参数为空时不硬塞一个空对象（避免界面上多一行空内容）', async () => {
    const { hooks, records } = recorder()
    await executeThroughGate(failingTool('click_screen', '拒绝原因'), {}, {} as never, hooks)
    expect(records[0].argsPreview).toBeUndefined()
  })

  it('参数过长时截断，不把整段塞进审计', async () => {
    const { hooks, records } = recorder()
    await executeThroughGate(
      failingTool('type_text', '内容太长'),
      { text: 'x'.repeat(5000), reason: '输入' },
      {} as never,
      hooks
    )
    expect(String(records[0].argsPreview).length).toBeLessThanOrEqual(310)
  })

  it('效果分档非法时也记工具名（否则不知道是哪个工具配错了）', async () => {
    const { hooks, records } = recorder()
    const bad: ToolDef = {
      ...failingTool('weird_tool', 'x'),
      effect: 'nonsense' as never
    }
    await executeThroughGate(bad, {}, {} as never, hooks)
    expect(records[0].tool).toBe('weird_tool')
    expect(records[0].kind).toBe('refuse')
  })

  it('plan 抛异常时，异常消息也要落到记录里（不是只留一句"没有执行"）', async () => {
    const { hooks, records } = recorder()
    const throwing: ToolDef = {
      ...failingTool('click_screen', ''),
      plan: async () => {
        throw new Error('PowerShell 执行失败：拒绝访问')
      }
    }
    await executeThroughGate(throwing, { x: 1, y: 2 }, {} as never, hooks)
    expect(String(records[0].sub)).toContain('拒绝访问')
    expect(records[0].tool).toBe('click_screen')
  })
})
