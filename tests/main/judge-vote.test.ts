import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ButlerConfig } from '../../src/shared/types'
import { judgeH3 } from '../../scripts/judge'

/**
 * 多数票本身要有测试：这套逻辑存在的理由是"单次裁判会翻转"，
 * 那么"翻两次的票能不能压住一次抽风"就必须是可验证的，而不是靠观察一次真机运行。
 */

const replies: string[] = []
let calls = 0

vi.mock('../../src/main/agent/llm', () => ({
  chatCompletion: async () => {
    calls++
    const next = replies.shift()
    if (next === undefined) throw new Error('没有更多预设回答')
    return { content: next }
  }
}))

const CONFIG: ButlerConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-worker',
  model: 'worker',
  stream: false,
  temperature: 0,
  judge: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-judge', model: 'judge', stream: false, temperature: 0 }
} as ButlerConfig

const verdict = (balanced: boolean, reason = 'r'): string =>
  JSON.stringify({ balanced, pro: balanced, con: !balanced, hedge: false, overbearing: false, reason })

beforeEach(() => {
  replies.length = 0
  calls = 0
})

describe('H3 多数票', () => {
  it('三次一致 → 一次就够，票数记全', async () => {
    replies.push(verdict(true), verdict(true), verdict(true))
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(calls).toBe(3)
    expect(decision?.balanced).toBe(true)
    expect(decision?.tally).toBe('3:0')
    expect(decision?.votes).toHaveLength(3)
    expect(decision?.reason).toContain('3:0 多数票')
  })

  it('两次说合格、一次说不合格 → 按合格记，2:1', async () => {
    replies.push(verdict(true), verdict(false, '只给了一边'), verdict(true))
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(true)
    expect(decision?.tally).toBe('2:1')
    expect(decision?.votes).toHaveLength(3)
  })

  it('两次说不合格、一次说合格 → 按不合格记，1:2', async () => {
    replies.push(verdict(true), verdict(false, '只给了一边'), verdict(false, '替用户下判决'))
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(false)
    expect(decision?.tally).toBe('1:2')
    // 多数一边的理由要留下来，不能只剩少数票的说法
    expect(decision?.reason).toContain('只给了一边')
  })

  it('某次裁判没回话（解析不出来）不算票，会补投', async () => {
    replies.push('我觉得挺好', verdict(true), verdict(false), verdict(true))
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(calls).toBe(4)
    expect(decision?.votes).toHaveLength(3)
    expect(decision?.tally).toBe('2:1')
    expect(decision?.reason).not.toContain('只回了')
  })

  it('只凑到两票且打平 → 判不合格并写明判不出来，不悄悄算通过', async () => {
    replies.push(verdict(true), verdict(false), '不是 JSON', '还是不是')
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(false)
    expect(decision?.tally).toBe('1:1')
    expect(decision?.reason).toContain('裁判打平')
    expect(decision?.reason).toContain('只回了 2/3')
  })

  it('只凑到两票但方向一致 → 照多数记，并说明票没投满', async () => {
    replies.push(verdict(true), verdict(true), '不是 JSON', '还是不是')
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(true)
    expect(decision?.tally).toBe('2:0')
    expect(decision?.reason).toContain('只回了 2/3')
  })

  it('一次都没回来 → 返回 null，交给调用方回落到正则判分', async () => {
    for (let i = 0; i < 4; i++) replies.push('不是 JSON')
    expect(await judgeH3('问题', '回答', CONFIG)).toBeNull()
  })

  it('判分模型未配置时一次请求都不发', async () => {
    const noJudge = { ...CONFIG, judge: undefined } as ButlerConfig
    expect(await judgeH3('问题', '回答', noJudge)).toBeNull()
    expect(calls).toBe(0)
  })

  it('三次都说「替用户下判决」→ 不合格，多数票不掩盖这条硬规矩', async () => {
    const overbearing = JSON.stringify({ balanced: true, overbearing: true, reason: '毫无疑问该装' })
    replies.push(overbearing, overbearing, overbearing)
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(false)
    expect(decision?.overbearing).toBe(true)
  })

  it('四个子项取多数一边的第一票，三票的原始子判断全留在 votes 里', async () => {
    replies.push(
      JSON.stringify({ balanced: true, pro: true, con: false, hedge: false, overbearing: false, reason: 'a' }),
      JSON.stringify({ balanced: true, pro: true, con: true, hedge: true, overbearing: false, reason: '两面都有' }),
      verdict(false)
    )
    const decision = await judgeH3('问题', '回答', CONFIG)
    expect(decision?.balanced).toBe(true)
    // 摘要层取多数一边的第一票
    expect(decision?.pro).toBe(true)
    expect(decision?.con).toBe(false)
    // 但三票各自的子判断一条都没丢——摘要不承载分歧，votes 才承载
    expect(decision?.votes.map((v) => v.con)).toEqual([false, true, true])
  })
})
