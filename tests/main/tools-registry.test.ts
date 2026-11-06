import { describe, expect, it } from 'vitest'
import { TOOL_BUDGET_STEPS } from '../../src/main/agent/agent'
import { buildSystemPrompt } from '../../src/main/agent/prompt'
import { capabilityBrief, createTools } from '../../src/main/agent/tools'

/**
 * 工具注册表与系统提示词的口径一致性。
 *
 * 模型"否认自己的能力"和"夸大自己的能力"都是从提示词与注册表漂移来的，
 * 所以这里锁的是"两处说的是同一件事"。
 */
describe('系统提示词与工具注册表', () => {
  const env = {
    machineName: 'TEST-PC',
    userName: 'tester',
    osVersion: 'Windows 11',
    today: '2026/1/1',
    hasSearch: true,
    toolBudget: TOOL_BUDGET_STEPS
  }

  it('能力段由注册表生成：改动机器的工具都在提示词里', () => {
    const tools = createTools()
    const brief = capabilityBrief(tools)
    const mutating = tools.filter((t) => ['write', 'destroy', 'install'].includes(t.effect))
    expect(mutating.length).toBeGreaterThan(0)
    for (const tool of mutating) {
      expect(brief).toContain(tool.name)
    }
  })

  it('只读工具不进"能改动机器"那一段（避免夸大）', () => {
    const tools = createTools()
    const brief = capabilityBrief(tools)
    for (const tool of tools.filter((t) => t.effect === 'read')) {
      expect(brief).not.toContain(tool.name)
    }
  })

  it('提示词里的工具预算与代码里的步数上限是同一个数', () => {
    const prompt = buildSystemPrompt(env, '')
    expect(prompt).toContain(`最多 ${TOOL_BUDGET_STEPS} 步`)
  })

  it('没有检索能力时，提示词明确要求回答"查不到"', () => {
    const prompt = buildSystemPrompt({ ...env, hasSearch: false }, '')
    expect(prompt).toMatch(/没有任何联网检索能力/)
    expect(prompt).toMatch(/查不到/)
  })
})

describe('工具定义完整性', () => {
  const tools = createTools()

  it('工具名唯一', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个工具都声明了合法分档', () => {
    const valid = new Set(['read', 'ui', 'write', 'destroy', 'install'])
    for (const tool of tools) {
      expect(valid.has(tool.effect), tool.name).toBe(true)
    }
  })

  it('销毁类工具一律不允许「始终允许」', () => {
    for (const tool of tools.filter((t) => t.effect === 'destroy')) {
      expect(tool.allowAlways, tool.name).not.toBe(true)
    }
  })

  it('每个工具都有给人看的标签与参数 schema', () => {
    for (const tool of tools) {
      expect(tool.label.length, tool.name).toBeGreaterThan(0)
      expect(tool.description.length, tool.name).toBeGreaterThan(0)
      expect(tool.parameters, tool.name).toMatchObject({ type: 'object' })
    }
  })

  it('必需参数都出现在 properties 里（模型否则会一直传空）', () => {
    for (const tool of tools) {
      const required = (tool.parameters as { required?: string[] }).required ?? []
      const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      for (const name of required) {
        expect(Object.keys(props), `${tool.name}.${name}`).toContain(name)
      }
    }
  })

  it('带 plan 的工具，run 直接调用一定被拒（防止绕过授权解析）', async () => {
    const planned = tools.filter((t) => typeof t.plan === 'function')
    expect(planned.length).toBeGreaterThan(0)
    for (const tool of planned) {
      const result = await tool.run({}, {
        config: {} as never,
        record: (e) => ({ ...e, id: '', ts: '' })
      })
      expect(result.ok, tool.name).toBe(false)
    }
  })
})
