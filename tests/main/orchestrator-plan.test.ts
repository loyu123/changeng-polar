import { describe, expect, it } from 'vitest'
import {
  blockedTasks,
  findCycle,
  projectProgress,
  readyTasks,
  topoLayers,
  validatePlan
} from '../../src/main/orchestrator/plan'
import type { OrchestrationProject, OrchestrationTask } from '../../src/main/orchestrator/types'

/**
 * 计划校验锁的是"派发前的安全"：
 * 环、悬空依赖、没有验收项——这三种错一旦放过，并行就会拿上游还没产出的文件
 * 去跑下游，最后交上来一份看起来完整、其实空心的报告。
 */

function task(id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id,
    title: `任务 ${id}`,
    prompt: `做 ${id}`,
    dependsOn: [],
    status: 'pending',
    acceptance: [{ kind: 'file-exists', path: 'out.md' }],
    attempts: 0,
    ...over
  }
}

function project(tasks: OrchestrationTask[]): OrchestrationProject {
  return {
    id: 'p1',
    name: '示例',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    status: 'running',
    rootDir: 'C:/tmp/proj',
    tasks
  }
}

describe('validatePlan', () => {
  it('正常计划通过', () => {
    const r = validatePlan([task('a'), task('b', { dependsOn: ['a'] })])
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('空计划直接不通过', () => {
    expect(validatePlan([]).ok).toBe(false)
  })

  it('没有验收项不算合法计划', () => {
    // 任务不带可执行验收，等于"做完了"由工作体自己说了算
    const r = validatePlan([task('a', { acceptance: [] })])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('没有验收项'))).toBe(true)
  })

  it('没有提示词的任务拦下', () => {
    const r = validatePlan([task('a', { prompt: '   ' })])
    expect(r.ok).toBe(false)
  })

  it('id 重复拦下', () => {
    const r = validatePlan([task('a'), task('a')])
    expect(r.errors.some((e) => e.message.includes('重复'))).toBe(true)
  })

  it('依赖不存在的任务拦下', () => {
    const r = validatePlan([task('a', { dependsOn: ['ghost'] })])
    expect(r.errors.some((e) => e.message.includes('不存在的任务'))).toBe(true)
  })

  it('依赖自己拦下', () => {
    const r = validatePlan([task('a', { dependsOn: ['a'] })])
    expect(r.errors.some((e) => e.message.includes('依赖了自己'))).toBe(true)
  })

  it('成环拦下，并指出环上的节点', () => {
    const r = validatePlan([
      task('a', { dependsOn: ['c'] }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] })
    ])
    expect(r.ok).toBe(false)
    const cycleError = r.errors.find((e) => e.message.includes('成环'))
    expect(cycleError).toBeTruthy()
    expect(cycleError?.message).toMatch(/a|b|c/)
  })
})

describe('findCycle', () => {
  it('无环返回 null', () => {
    expect(findCycle([task('a'), task('b', { dependsOn: ['a'] })])).toBeNull()
  })

  it('自环能找出来', () => {
    expect(findCycle([task('a', { dependsOn: ['a'] })])).toEqual(['a', 'a'])
  })

  it('二元环能找出来', () => {
    const c = findCycle([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])
    expect(c).not.toBeNull()
    expect(new Set(c)).toEqual(new Set(['a', 'b']))
  })
})

describe('topoLayers', () => {
  it('按依赖分层，同层可以并行', () => {
    const layers = topoLayers([
      task('c', { dependsOn: ['a', 'b'] }),
      task('a'),
      task('b')
    ])
    expect(layers[0]).toEqual(['a', 'b'])
    expect(layers[1]).toEqual(['c'])
  })

  it('分层顺序稳定（汇报和评测才对得上）', () => {
    const l1 = topoLayers([task('b'), task('a'), task('c')])
    const l2 = topoLayers([task('c'), task('a'), task('b')])
    expect(l1).toEqual(l2)
  })

  it('有环也不会死循环', () => {
    const layers = topoLayers([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])
    expect(layers.flat().sort()).toEqual(['a', 'b'])
  })
})

describe('readyTasks / blockedTasks', () => {
  it('依赖没完成的任务不可派发', () => {
    const p = project([task('a'), task('b', { dependsOn: ['a'] })])
    expect(readyTasks(p).map((t) => t.id)).toEqual(['a'])
    expect(blockedTasks(p).map((t) => t.id)).toEqual(['b'])
  })

  it('上游成功后下游才进 ready', () => {
    const p = project([task('a', { status: 'done' }), task('b', { dependsOn: ['a'] })])
    expect(readyTasks(p).map((t) => t.id)).toEqual(['b'])
  })

  it('上游失败，下游永远不进 ready（不拿空原料硬跑）', () => {
    const p = project([
      task('a', { status: 'failed' }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] })
    ])
    expect(readyTasks(p)).toEqual([])
    expect(blockedTasks(p).map((t) => t.id)).toEqual(['b', 'c'])
  })

  it('上游结果未知也不算完成', () => {
    const p = project([task('a', { status: 'unknown' }), task('b', { dependsOn: ['a'] })])
    expect(readyTasks(p)).toEqual([])
  })
})

describe('projectProgress', () => {
  it('有失败时不冒充 100%', () => {
    const p = project([task('a', { status: 'done' }), task('b', { status: 'failed' })])
    const r = projectProgress(p)
    expect(r.done).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.ratio).toBeCloseTo(0.5)
  })

  it('被上游卡住的 pending 单独计数', () => {
    const p = project([task('a', { status: 'failed' }), task('b', { dependsOn: ['a'] })])
    const r = projectProgress(p)
    expect(r.blocked).toBe(1)
    expect(r.pending).toBe(0)
  })
})
