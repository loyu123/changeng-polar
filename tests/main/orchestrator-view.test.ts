import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listProjects, recheckProject } from '../../src/main/orchestrator/view'
import { ProjectStore } from '../../src/main/orchestrator/store'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'

/**
 * 界面读的那一层。
 *
 * 锁三件事：
 * 1. 坏掉的项目文件不能把整页拖垮
 * 2. 只报真实存在的产出（"应该有"的文件不算结果）
 * 3. 重新核对不改状态——它是复核，不是修状态
 */

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-view-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

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

async function makeProject(name: string, tasks: OrchestrationTask[]): Promise<{ store: ProjectStore; root: string }> {
  const root = path.join(dir, `proj-${name}`)
  await fs.mkdir(root, { recursive: true })
  const store = new ProjectStore(root)
  await store.create(name, tasks)
  return { store, root }
}

describe('listProjects', () => {
  it('没有项目时返回空数组，不抛错', async () => {
    expect(await listProjects(path.join(dir, '不存在'))).toEqual([])
  })

  it('列出项目、进度与任务', async () => {
    const { store } = await makeProject('示例', [task('a'), task('b', { dependsOn: ['a'] })])
    await store.updateTask('a', { status: 'done' })

    const list = await listProjects(dir)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('示例')
    expect(list[0].progress.total).toBe(2)
    expect(list[0].progress.done).toBe(1)
    expect(list[0].tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('坏掉的项目文件跳过，不拖垮整页', async () => {
    await makeProject('好的', [task('a')])
    const broken = path.join(dir, 'broken', '.orchestrator')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'project.json'), '{ 这不是 JSON', 'utf8')

    const list = await listProjects(dir)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('好的')
  })

  it('只报真实存在的产出，"应该有"的文件不列', async () => {
    const { store, root } = await makeProject('产出', [
      task('a', {
        acceptance: [
          { kind: 'file-exists', path: 'exists.md' },
          { kind: 'file-exists', path: 'ghost.md' }
        ]
      })
    ])
    await fs.writeFile(path.join(root, 'tasks', 'a', 'exists.md'), 'ok', 'utf8')
    await store.updateTask('a', { status: 'done' })

    const list = await listProjects(dir)
    const artifacts = list[0].tasks[0].artifacts
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toContain('exists.md')
  })

  it('按更新时间倒序：最近动的在最前', async () => {
    const a = await makeProject('早', [task('x')])
    const b = await makeProject('晚', [task('y')])
    await a.store.updateTask('x', { status: 'done' })
    await new Promise((r) => setTimeout(r, 10))
    await b.store.updateTask('y', { status: 'done' })

    const list = await listProjects(dir)
    expect(list.map((p) => p.name)).toEqual(['晚', '早'])
  })

  it('统计派发次数与最后派发时间', async () => {
    const { store } = await makeProject('记录', [task('a')])
    await store.appendRun({
      runId: 'r1',
      projectId: 'p',
      taskId: 'a',
      startedAt: '2026-11-10T00:00:00.000Z',
      endedAt: '2026-11-10T00:00:05.000Z',
      ok: true,
      exitCode: 0,
      toolCalls: [],
      outputChars: 10
    })
    const list = await listProjects(dir)
    expect(list[0].runCount).toBe(1)
    expect(list[0].lastRunAt).toBe('2026-11-10T00:00:05.000Z')
  })
})

describe('recheckProject', () => {
  it('按磁盘现状复核，但不改任务状态', async () => {
    const { store, root } = await makeProject('复核', [
      task('a', { acceptance: [{ kind: 'contains', path: 'out.md', text: '必须这句' }] })
    ])
    // 状态说完成，磁盘上却没有合格的文件：复核要说没过
    await store.updateTask('a', { status: 'done' })
    await fs.writeFile(path.join(root, 'tasks', 'a', 'out.md'), '别的内容', 'utf8')

    const r = await recheckProject(dir, 'proj-复核')
    expect(r).toHaveLength(1)
    expect(r[0].taskId).toBe('a')
    expect(r[0].passed).toBe(false)

    // 状态没被复核改掉
    const after = await store.load()
    expect(after?.tasks[0].status).toBe('done')
  })

  it('目录不存在时返回空数组', async () => {
    expect(await recheckProject(dir, '不存在')).toEqual([])
  })
})
