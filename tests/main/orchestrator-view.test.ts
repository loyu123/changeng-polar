import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listProjects, recheckProject } from '../../src/main/orchestrator/view'
import { isInsideAnyRoot, isInsideRoot, normalizeRoot } from '../../src/main/orchestrator/roots'
import { ProjectStore } from '../../src/main/orchestrator/store'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'

/**
 * 界面读的那一层。
 *
 * 锁四件事：
 * 1. 坏掉的项目文件不能把整页拖垮
 * 2. 只报真实存在的产出（"应该有"的文件不算结果）
 * 3. 重新核对不改状态——它是复核，不是修状态
 * 4. 多个根里出现同名项目时，身份是目录而不是名字
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

async function makeProject(
  name: string,
  tasks: OrchestrationTask[],
  base = dir
): Promise<{ store: ProjectStore; root: string }> {
  const root = path.join(base, `proj-${name}`)
  await fs.mkdir(root, { recursive: true })
  const store = new ProjectStore(root)
  await store.create(name, tasks)
  return { store, root }
}

describe('listProjects', () => {
  it('没有项目时返回空数组，不抛错', async () => {
    // 根不存在：pickRoot 靠这个结果判定"这里没有项目"
    expect(await listProjects([path.join(dir, '不存在')])).toEqual([])
  })

  it('根目录空着（子目录里也没有项目）时返回空数组', async () => {
    const empty = path.join(dir, '空目录')
    await fs.mkdir(empty, { recursive: true })
    expect(await listProjects([empty])).toEqual([])
  })

  it('列出项目、进度与任务', async () => {
    const { store } = await makeProject('示例', [task('a'), task('b', { dependsOn: ['a'] })])
    await store.updateTask('a', { status: 'done' })

    const list = await listProjects([dir])
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

    const list = await listProjects([dir])
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

    const list = await listProjects([dir])
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

    const list = await listProjects([dir])
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
    const list = await listProjects([dir])
    expect(list[0].runCount).toBe(1)
    expect(list[0].lastRunAt).toBe('2026-11-10T00:00:05.000Z')
  })

  it('根本身就是一个项目时也认得（用户直接挑了项目目录）', async () => {
    const { root } = await makeProject('单层', [task('a')])
    const list = await listProjects([root])
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('单层')
    // 挑进来的就是项目本身时，不能把它自己重复列一次
    expect(list[0].projectDir).toBe(path.resolve(root))
    expect(list[0].scanRoot).toBe(path.resolve(root))
  })

  it('多根同时扫：每个项目都带上是哪个根找到的', async () => {
    const baseA = path.join(dir, '根A')
    const baseB = path.join(dir, '根B')
    await fs.mkdir(baseA, { recursive: true })
    await fs.mkdir(baseB, { recursive: true })
    await makeProject('甲的', [task('a')], baseA)
    await makeProject('乙的', [task('b')], baseB)

    const list = await listProjects([baseA, baseB])
    expect(list.map((p) => p.name).sort()).toEqual(['乙的', '甲的'].sort())
    const scanRootOf = (name: string): string | undefined => list.find((p) => p.name === name)?.scanRoot
    expect(scanRootOf('甲的')).toBe(path.resolve(baseA))
    expect(scanRootOf('乙的')).toBe(path.resolve(baseB))
  })

  it('两个根里出现同名子目录：两条都在，靠 projectDir 区分', async () => {
    const baseA = path.join(dir, '根A')
    const baseB = path.join(dir, '根B')
    await fs.mkdir(baseA, { recursive: true })
    await fs.mkdir(baseB, { recursive: true })
    // 项目名一样。之前用「根下的目录名」当键时，这两个会互相吃掉一个
    await makeProject('同名', [task('a')], baseA)
    await makeProject('同名', [task('b')], baseB)

    const list = await listProjects([baseA, baseB])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((p) => p.projectDir)).size).toBe(2)
  })

  it('同一个根被写了两遍（应用目录 + 用户又挑了一次）不会重复列出', async () => {
    await makeProject('一次就够', [task('a')])
    const list = await listProjects([dir, dir, path.join(dir, '.')])
    expect(list).toHaveLength(1)
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

    const r = await recheckProject(root)
    expect(r).toHaveLength(1)
    expect(r[0].taskId).toBe('a')
    expect(r[0].passed).toBe(false)

    // 状态没被复核改掉
    const after = await store.load()
    expect(after?.tasks[0].status).toBe('done')
  })

  it('目录不存在时返回空数组', async () => {
    expect(await recheckProject(path.join(dir, '不存在'))).toEqual([])
  })
})

describe('roots：这一页能看哪些目录', () => {
  it('含入判断按路径算，不按字符串前缀', () => {
    // `C:\编排2` 与 `C:\编排` 前缀相同却不是同一个目录。
    // 用 startsWith 会把这个放进去，path.relative 不会。
    expect(isInsideRoot('C:\\编排', 'C:\\编排2\\x')).toBe(false)
    expect(isInsideRoot('C:\\编排', 'C:\\编排\\p1')).toBe(true)
    expect(isInsideRoot('C:\\编排', 'C:\\编排')).toBe(true)
    expect(isInsideRoot('C:\\编排', 'C:\\编排\\..\\别的')).toBe(false)
  })

  it('任意一个根包含就算允许；空根列表什么都不允许', () => {
    expect(isInsideAnyRoot(['C:\\a', 'C:\\b'], 'C:\\b\\p')).toBe(true)
    expect(isInsideAnyRoot(['C:\\a', 'C:\\b'], 'C:\\c\\p')).toBe(false)
    expect(isInsideAnyRoot([], 'C:\\a\\p')).toBe(false)
  })

  it('空字符串不当成"什么都允许"', () => {
    // normalizeRoot 把空值压成当前工作目录这种事会让边界完全失效
    expect(isInsideRoot('', 'C:\\任何地方')).toBe(false)
    expect(normalizeRoot('')).not.toBe('')
  })
})
