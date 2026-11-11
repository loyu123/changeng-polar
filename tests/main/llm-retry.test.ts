import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatCompletion } from '../../src/main/agent/llm'
import type { ModelConfig } from '../../src/shared/types'

/**
 * 模型请求的重试边界。
 *
 * 这几条是「重试」最容易写歪的地方：把 4xx 也重试（Key 错了白等）、
 * 把用户点的「停止」当成网络故障重试、或者重试没有上限。
 * 工具执行不在这条链路上，所以这里只管请求本身。
 */

const config: ModelConfig = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'k',
  model: 'm',
  stream: false,
  temperature: 0.2
}

const okBody = {
  choices: [{ message: { content: '好了' }, finish_reason: 'stop' }]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('模型请求重试', () => {
  it('5xx 之后重试一次并成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse(okBody))
    vi.stubGlobal('fetch', fetchMock)

    const res = await chatCompletion({ config, messages: [], tools: [] })
    expect(res.content).toBe('好了')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('429 也重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429))
      .mockResolvedValueOnce(jsonResponse(okBody))
    vi.stubGlobal('fetch', fetchMock)

    const res = await chatCompletion({ config, messages: [], tools: [] })
    expect(res.content).toBe('好了')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('4xx 不重试：请求本身有问题，重试只是白等', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad key' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(chatCompletion({ config, messages: [], tools: [] })).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('只重试一次：连续 5xx 就如实失败，不无限重来', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 503))
    vi.stubGlobal('fetch', fetchMock)

    await expect(chatCompletion({ config, messages: [], tools: [] })).rejects.toThrow(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('用户取消不重试：停止就是停止', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      chatCompletion({ config, messages: [], tools: [], signal: controller.signal })
    ).rejects.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
