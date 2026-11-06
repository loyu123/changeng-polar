import type { ChatMessage, ModelConfig, ToolCall } from '../../shared/types'

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export class LlmError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/** 允许用户直接粘贴 .../v1 或 .../v1/chat/completions 两种写法 */
export function normalizeBaseUrl(raw: string): string {
  let base = (raw || '').trim().replace(/\/+$/, '')
  base = base.replace(/\/chat\/completions$/i, '')
  return base
}

function buildBody(
  config: ModelConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => ({
      role: m.role,
      // OpenAI 协议要求无内容的 assistant 消息 content 为 null
      content: m.content ?? null,
      // tool_calls 必须补齐 type:function，DeepSeek 等后端缺这个字段会直接 422
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments }
            }))
          }
        : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.role === 'tool' && m.name ? { name: m.name } : {})
    })),
    stream,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.2
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
    body.tool_choice = 'auto'
  }
  return body
}

async function post(
  config: ModelConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  const base = normalizeBaseUrl(config.baseUrl)
  if (!base) throw new LlmError('未配置模型地址（设置 → base_url）')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey?.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`

  const timeout = AbortSignal.timeout(180_000)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: composed
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new LlmError(
      `模型接口 ${res.status}：${text.slice(0, 400) || res.statusText}`,
      res.status
    )
  }
  return res
}

interface PendingCall {
  id: string
  name: string
  arguments: string
}

async function readStream(
  res: Response,
  onDelta?: (t: string) => void
): Promise<ModelResponse> {
  const contentType = res.headers.get('content-type') || ''
  // 有些网关忽略 stream:true，直接返回整包 JSON
  if (!contentType.includes('event-stream')) {
    const json = (await res.json()) as any
    return fromJson(json)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new LlmError('模型接口未返回可读流')

  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = ''
  let usage: ModelResponse['usage']
  const calls: PendingCall[] = []
  let done = false

  const handlePayload = (payload: string): void => {
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') done = true
      return
    }
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      return
    }
    if (json.usage) usage = json.usage
    const choice = json.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    const rawCalls = delta.tool_calls
    if (Array.isArray(rawCalls)) {
      for (const tc of rawCalls) {
        const index = typeof tc.index === 'number' ? tc.index : 0
        if (!calls[index]) calls[index] = { id: '', name: '', arguments: '' }
        const acc = calls[index]
        if (tc.id) acc.id = tc.id
        const fnName = tc.function?.name
        if (typeof fnName === 'string' && fnName) acc.name += fnName
        const args = tc.function?.arguments
        if (typeof args === 'string') acc.arguments += args
        else if (args && typeof args === 'object') acc.arguments += JSON.stringify(args)
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  while (!done) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const chunk = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        handlePayload(trimmed.slice(5).trim())
      }
      if (done) break
      sep = buffer.indexOf('\n\n')
    }
  }
  // 收尾：处理没有以空行结尾的最后一个事件
  if (!done && buffer.trim().startsWith('data:')) {
    const payload = buffer.trim().slice(5).trim()
    if (payload !== '[DONE]') handlePayload(payload)
  }

  return {
    content,
    toolCalls: calls.filter((c) => c.name).map(finalizeCall),
    finishReason: finishReason || 'stop',
    usage
  }
}

function finalizeCall(c: PendingCall, i: number): ToolCall {
  return {
    id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
    name: c.name,
    arguments: c.arguments?.trim() ? c.arguments : '{}'
  }
}

function fromJson(json: any): ModelResponse {
  const message = json.choices?.[0]?.message ?? {}
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls: ToolCall[] = rawCalls
    .filter((c: any) => c?.function?.name)
    .map((c: any, i: number) => ({
      id: c.id || `call_${i}`,
      name: c.function.name,
      arguments:
        typeof c.function.arguments === 'string'
          ? c.function.arguments || '{}'
          : JSON.stringify(c.function.arguments ?? {})
    }))
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
    usage: json.usage
  }
}

/** 非流式请求的响应解析：有些网关即使传 stream:false 也回 SSE，这里两种都吃 */
async function readNonStream(res: Response, onDelta?: (t: string) => void): Promise<ModelResponse> {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('event-stream')) return readStream(res, onDelta)
  const json = (await res.json()) as any
  const parsed = fromJson(json)
  if (parsed.content) onDelta?.(parsed.content)
  return parsed
}

export async function chatCompletion(opts: {
  config: ModelConfig
  messages: ChatMessage[]
  tools: ToolSchema[]
  onDelta?: (t: string) => void
  signal?: AbortSignal
}): Promise<ModelResponse> {
  const { config, messages, tools, onDelta, signal } = opts
  const wantStream = config.stream !== false

  if (wantStream) {
    let emitted = false
    try {
      const res = await post(config, buildBody(config, messages, tools, true), signal)
      return await readStream(res, (t) => {
        emitted = true
        onDelta?.(t)
      })
    } catch (err) {
      // 一个字都没吐出去才允许降级重试，避免正文重复
      if (emitted) throw err
      if (signal?.aborted) throw err
      const res = await post(config, buildBody(config, messages, tools, false), signal)
      return readNonStream(res, onDelta)
    }
  }

  const res = await post(config, buildBody(config, messages, tools, false), signal)
  return readNonStream(res, onDelta)
}

export async function pingModel(config: ModelConfig): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const started = Date.now()
  try {
    const res = await chatCompletion({
      config: { ...config, stream: false },
      messages: [{ role: 'user', content: '回复两个字：在线' }],
      tools: []
    })
    return {
      ok: true,
      detail: `模型返回：${(res.content || '(空)').slice(0, 40)}`,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started
    }
  }
}
