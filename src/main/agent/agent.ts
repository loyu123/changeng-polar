import type {
  ButlerConfig,
  ChatMessage,
  ChatPayload,
  Evidence,
  ToolTrace,
  TurnResult
} from '../../shared/types'
import { executeThroughGate, type GateHooks } from './gate'
import { chatCompletion, type ToolSchema } from './llm'
import type { ToolContext, ToolDef, ToolResult } from './tool-types'

export type { GateHooks } from './gate'
export type { ToolContext, ToolDef, ToolResult, ToolTarget } from './tool-types'

const MAX_TOOL_CHARS = 6000

/**
 * 一轮回答最多几"步"（每步是一次模型往返，一步里可以并行调多个工具）。
 * prompt 里的工具预算也从这里读，两处不能再各写一个数——
 * 之前提示词写"最多 3 次"、代码给 5 步，模型按 3 停、实际允许 5，口径是分裂的。
 */
export const TOOL_BUDGET_STEPS = 5

function schemaOf(tools: ToolDef[]): ToolSchema[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}

/** 超长时收缩 data 数组而不是截断字符串，保证交给模型的永远是合法 JSON */
function trimToolPayload(result: ToolResult): string {
  const full = { ok: result.ok, summary: result.summary, data: result.data, undo: result.undo }
  const payload = JSON.stringify(full)
  if (payload.length <= MAX_TOOL_CHARS) return payload

  if (Array.isArray(full.data) && full.data.length > 1) {
    let items = full.data.slice(0, Math.max(2, Math.floor(full.data.length / 2)))
    while (items.length >= 1) {
      const candidate = JSON.stringify({
        ok: full.ok,
        summary: full.summary,
        data: items,
        note: `共 ${full.data.length} 条，已截断为前 ${items.length} 条`
      })
      if (candidate.length <= MAX_TOOL_CHARS) return candidate
      if (items.length === 1) break
      items = items.slice(0, Math.max(1, Math.floor(items.length / 2)))
    }
  }

  return JSON.stringify({
    ok: full.ok,
    summary: full.summary,
    note: `明细过长（${payload.length} 字符），已省略，请依据 summary 回答或缩小查询范围`
  })
}

export interface RunTurnOptions {
  messages: ChatMessage[]
  config: ButlerConfig
  tools: ToolDef[]
  ctx: ToolContext
  /** 授权闸门：所有工具调用都从这里穿过 */
  gate: GateHooks
  emit?: (event: ChatPayload) => void
  maxSteps?: number
  signal?: AbortSignal
}

export interface RunTurnOutput {
  result: TurnResult
  /** 本轮新增的消息（不含传入的历史），可直接追加到会话历史 */
  appended: ChatMessage[]
}

export async function runTurn(opts: RunTurnOptions): Promise<RunTurnOutput> {
  const { config, tools, ctx, emit, signal, gate } = opts
  const maxSteps = opts.maxSteps ?? TOOL_BUDGET_STEPS
  const appended: ChatMessage[] = []
  const evidence: Evidence[] = []
  const traces: ToolTrace[] = []
  const schemas = schemaOf(tools)
  const turnCache = new Map<string, ToolResult>()
  let finalText = ''
  let usage: TurnResult['usage']
  let steps = 0

  const history: ChatMessage[] = [...opts.messages]

  while (steps < maxSteps) {
    if (signal?.aborted) throw new Error('已取消')
    steps += 1
    emit?.({ type: 'status', text: steps === 1 ? '思考中…' : '整理结果…' })

    const response = await chatCompletion({
      config,
      messages: history,
      tools: schemas,
      signal,
      onDelta: (text) => emit?.({ type: 'delta', text })
    })
    if (response.usage) usage = response.usage

    const assistant: ChatMessage = {
      role: 'assistant',
      content: response.content || null,
      ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls } : {})
    }
    history.push(assistant)
    appended.push(assistant)

    if (response.toolCalls.length === 0) {
      finalText = response.content.trim()
      break
    }

    for (const call of response.toolCalls) {
      const def = tools.find((t) => t.name === call.name)
      let parsedArgs: Record<string, any> = {}
      try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        parsedArgs = {}
      }

      let toolResult: ToolResult
      if (!def) {
        // 只有"没注册过的工具"这一种拒绝。不按工具名做关键词黑名单：
        // 那会把以后合法注册的 uninstall_app 一起拦死，也拦不住真正危险的东西。
        toolResult = { ok: false, summary: `被拒绝：不存在名为 ${call.name} 的能力，可用的只有 ${tools.map((t) => t.name).join('、')}` }
        gate.record({
          kind: 'refuse',
          title: `拒绝：调用未注册的能力 ${call.name}`,
          sub: '不在工具白名单内',
          result: 'rejected',
          reversible: false
        })
        emit?.({ type: 'tool', name: call.name, label: '被拒绝：无此能力', effect: 'read' })
      } else {
        // 读写类结果可以在同一轮里复用；销毁/写必须每次重新过闸门
        const cacheable = def.effect === 'read' || def.effect === 'ui'
        const cacheKey = `${call.name}:${JSON.stringify(parsedArgs)}`
        const cached = cacheable ? turnCache.get(cacheKey) : undefined
        if (cached) {
          toolResult = {
            ...cached,
            summary: `${cached.summary}（本轮已调用过完全相同的参数，未重复执行）`
          }
          emit?.({ type: 'tool', name: call.name, label: `${def.label}（复用本次结果）`, effect: def.effect })
        } else {
          emit?.({ type: 'tool', name: call.name, label: def.label, effect: def.effect })
          try {
            toolResult = await executeThroughGate(def, parsedArgs, ctx, gate)
          } catch (err) {
            toolResult = {
              ok: false,
              summary: `工具执行失败：${err instanceof Error ? err.message : String(err)}`
            }
          }
          if (cacheable) turnCache.set(cacheKey, toolResult)
        }
      }

      if (toolResult.evidence?.length) {
        for (const item of toolResult.evidence) {
          if (!evidence.some((existing) => existing.id === item.id)) evidence.push(item)
        }
      }
      traces.push({
        name: call.name,
        label: def?.label ?? call.name,
        ok: toolResult.ok,
        effect: def?.effect ?? 'read',
        blocked: toolResult.blocked === true,
        args: parsedArgs
      })

      const toolMessage: ChatMessage = {
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: trimToolPayload(toolResult)
      }
      history.push(toolMessage)
      appended.push(toolMessage)
    }
  }

  // 步数用尽还没出结论：强制收口一次（关掉工具，禁止继续检索）
  if (!finalText && traces.length > 0) {
    emit?.({ type: 'status', text: '整理结论…' })
    try {
      const closing = await chatCompletion({
        config,
        tools: [],
        signal,
        messages: [
          ...history,
          {
            role: 'user',
            content:
              '时间到了，请停止检索，直接基于上面已经拿到的结果给出结论。没有证据的部分明确说「查不到」，不要再申请调用任何工具。'
          }
        ],
        onDelta: (text) => emit?.({ type: 'delta', text })
      })
      finalText = closing.content.trim()
      if (closing.usage) usage = closing.usage
      if (finalText) appended.push({ role: 'assistant', content: finalText })
    } catch (err) {
      if (signal?.aborted) throw err
      /* 收口失败就落到下面的兜底文案 */
    }
  }

  if (!finalText) {
    const blocked = traces.some((t) => t.blocked)
    finalText = blocked
      ? '这次操作被拦在授权那一步，什么都没改动。'
      : traces.length
        ? '我查到了数据，但没能整理成结论。需要我换个说法再查一次吗？'
        : '这次没有拿到结果。'
  }

  const result: TurnResult = {
    text: finalText,
    evidence,
    tools: traces,
    unsourced: evidence.length === 0,
    steps,
    usage
  }
  return { result, appended }
}
