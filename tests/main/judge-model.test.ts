import { describe, expect, it } from 'vitest'
import { judgeModelOf } from '../../scripts/judge'
import { DEFAULT_CONFIG } from '../../src/main/node/store'
import type { ButlerConfig, ModelConfig } from '../../src/shared/types'

/**
 * 判分模型的选取。
 *
 * 这段的作用不是"能跑"，而是**不许悄悄回落到主模型**：
 * 判分与智能体共用同一个模型时，分数是自己给自己打的，不能当能力证据。
 */

const withJudge = (over: Partial<ModelConfig>): ButlerConfig => ({
  ...DEFAULT_CONFIG,
  judge: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-judge', model: 'deepseek-chat', stream: true, temperature: 0.7, ...over }
})

describe('judgeModelOf', () => {
  it('没配判分模型时返回 null（不回落主模型）', () => {
    expect(judgeModelOf(DEFAULT_CONFIG)).toBeNull()
  })

  it('配齐时返回判分模型，并强制非流式、温度 0', () => {
    const model = judgeModelOf(withJudge({}))
    expect(model).not.toBeNull()
    expect(model?.model).toBe('deepseek-chat')
    // 判分要可复现：流式和随机温度都不该带进来
    expect(model?.stream).toBe(false)
    expect(model?.temperature).toBe(0)
  })

  it('缺 Key（且不是本机端点）时返回 null', () => {
    expect(judgeModelOf(withJudge({ apiKey: '' }))).toBeNull()
    expect(judgeModelOf(withJudge({ apiKey: '   ' }))).toBeNull()
  })

  it('本机端点允许留空 Key（本地模型没有 Key）', () => {
    const model = judgeModelOf(withJudge({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }))
    expect(model).not.toBeNull()
  })

  it('缺模型名或地址时返回 null', () => {
    expect(judgeModelOf(withJudge({ model: '' }))).toBeNull()
    expect(judgeModelOf(withJudge({ baseUrl: '' }))).toBeNull()
  })

  it('返回的是判分配置，不是主配置（防止误用主模型打分）', () => {
    const config: ButlerConfig = { ...withJudge({ model: 'judge-model' }), model: 'worker-model' }
    expect(judgeModelOf(config)?.model).toBe('judge-model')
  })
})
