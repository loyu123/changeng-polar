import { describe, expect, it } from 'vitest'
import { capabilityBrief, createTools } from '../../src/main/agent/tools'
import { buildSystemPrompt } from '../../src/main/agent/prompt'
import { filterTools } from '../../src/main/runtime'

/**
 * 只读模式。
 *
 * 关键不是"开关能切换"，而是打开之后**写类工具真的不在清单里**：
 * 如果只是弹卡时拒绝，模型还会反复申请，用户看到的就是"我说了不要它还在试"。
 *
 * 这里直接调 runtime 里那个 filterTools——插件页和对话装配共用它，
 * 测它就等于测了两条路径。
 */

const MUTATING = new Set(['write', 'destroy', 'install'])

const toolsWith = (options: { readOnly?: boolean; toggles?: Record<string, boolean> } = {}) =>
  filterTools(createTools({}), options)

describe('只读模式 · 工具装配', () => {
  it('打开后没有任何 write / destroy / install 工具', () => {
    const tools = toolsWith({ readOnly: true })
    expect(tools.filter((t) => MUTATING.has(t.effect))).toEqual([])
  })

  it('只读工具与界面工具仍然在（否则等于把管家废了）', () => {
    const tools = toolsWith({ readOnly: true })
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(['read', 'ui']).toContain(tool.effect)
    }
    // 读本机清单这类核心能力必须保留
    expect(tools.map((t) => t.name)).toContain('list_installed_apps')
  })

  it('关闭时写类工具回来', () => {
    const tools = toolsWith({ readOnly: false })
    expect(tools.filter((t) => MUTATING.has(t.effect)).length).toBeGreaterThan(0)
  })

  it('缺省（老配置里没有这个字段）视为关闭', () => {
    expect(toolsWith({}).map((t) => t.name)).toEqual(toolsWith({ readOnly: false }).map((t) => t.name))
  })

  it('与能力开关叠加：只读优先级更高，两者都关掉的工具不会复活', () => {
    const tools = toolsWith({ readOnly: true, toggles: { install_app: true } })
    expect(tools.map((t) => t.name)).not.toContain('install_app')
  })

  it('定时任务走同一条链路，只读模式对它同样生效', () => {
    // runTaskOnce → executeTurn → toolsFor(config, config.readOnly)，没有旁路
    const scheduled = toolsWith({ readOnly: true })
    expect(scheduled.some((t) => t.name === 'uninstall_app')).toBe(false)
  })
})

describe('只读模式 · 提示词一致性', () => {
  const env = {
    machineName: 'TEST-PC',
    userName: 'tester',
    osVersion: 'Windows 11',
    today: '2026/1/1',
    hasSearch: true,
    toolBudget: 5
  }

  it('只读时能力段不再列出任何可改动机器的工具', () => {
    const brief = capabilityBrief(toolsWith({ readOnly: true }))
    for (const name of ['install_app', 'uninstall_app', 'delete_to_recycle', 'save_memory', 'forget_memory']) {
      expect(brief).not.toContain(name)
    }
  })

  it('只读时能力段明说「没有能改动机器的工具」，模型不会声称自己能装软件', () => {
    const brief = capabilityBrief(toolsWith({ readOnly: true }))
    expect(brief).toContain('没有能改动机器的工具')
    expect(buildSystemPrompt(env, brief)).toContain('没有能改动机器的工具')
  })

  it('非只读时能力段与工具注册表一致（不会因为这次改动而漂移）', () => {
    const tools = toolsWith({ readOnly: false })
    const brief = capabilityBrief(tools)
    for (const tool of tools.filter((t) => MUTATING.has(t.effect))) {
      expect(brief).toContain(tool.name)
    }
  })
})
