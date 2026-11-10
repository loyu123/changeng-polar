import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveProjectStatus, ProjectRunner } from '../../src/main/orchestrator/runner'
import { ProjectStore } from '../../src/main/orchestrator/store'
import type { OrchestrationProject, OrchestrationTask } from '../../src/main/orchestrator/types'
import type { WorkerConfig, WorkerRunOptions, WorkerRunResult } from '../../src/main/orchestrator/worker'

/**
 * 项目整体状态。
 *
 * 真机见到的毛病：任务 4/4 全完成，编排页上项目状态还写着 `planning`——
 * 因为 status 只在创建时设过一次，之后没人更新。界面上自相矛盾。
 */

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-status-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function task(id: string, status: OrchestrationTask['status'] = 'pending'): OrchestrationTask {
  return {
    id,
    title: id,
    prompt: `做 ${id}`,
    dependsOn: [],
    status,
    acceptance: [{ kind: 'file-exists', path: 'out.txt' }],
    attempts: 0
  }
}

function project(tasks: OrchestrationTask[]): OrchestrationProject {
  return {
    id: 'p',
    name: '示例',
    createdAt: '',
    updatedAt: '',
    status: 'planning',
    rootDir: 'C:/tmp',
    tasks
  }
}

describe('deriveProjectStatus', () => {
  it('全完成 → done', () => {
    expect(deriveProjectStatus(project([task('a', 'done'), task('b', 'done')]))).toBe('done')
  })

  it('有一个失败 → failed', () => {
    expect(deriveProjectStatus(project([task('a', 'done'), task('b', 'failed')]))).toBe('failed')
  })

  it('结果未知也算失败（它可能做了一半，不能当成功）', () => {
    expect(deriveProjectStatus(project([task('a', 'done'), task('b', 'unknown')]))).toBe('failed')
  })

  it('还有没跑完的 → running，哪怕已经有一部分失败了', () => {
    expect(deriveProjectStatus(project([task('a', 'failed'), task('b', 'pending')]))).toBe('running')
    expect(deriveProjectStatus(project([task('a', 'done'), task('b', 'running')]))).toBe('running')
    expect(deriveProjectStatus(project([task('a', 'done'), task('b', 'blocked')]))).toBe('running')
  })

  it('空项目 → planning（还没东西可跑）', () => {
    expect(deriveProjectStatus(project([]))).toBe('planning')
  })
})

describe('跑完之后项目状态会更新', () => {
  const worker: WorkerConfig = { backend: 'pi', provider: 'p', model: 'm', tools: [] }

  const okWorker = async (opts: WorkerRunOptions): Promise<WorkerRunResult> => {
    await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
    return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
  }

  it('全部通过 → 项目标 done，不再是 planning', async () => {
    const store = new ProjectStore(dir)
    await store.create('全过', [task('a'), task('b')])
    const p = (await store.load())!

    const runner = new ProjectRunner({ store, resolveWorker: () => worker, runWorkerImpl: okWorker })
    const done = await runner.runAllConcurrent(p, 2)

    expect(done.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(done.status).toBe('done')

    // 也落盘了
    expect((await store.load())?.status).toBe('done')
    expect((await store.load())?.status).not.toBe('planning')
  })

  it('有失败 → 项目标 failed', async () => {
    const store = new ProjectStore(dir)
    await store.create('有一个失败', [task('a')])
    const p = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => worker,
      runWorkerImpl: async () => ({
        ok: false,
        text: '',
        toolCalls: [],
        exitCode: 1,
        failureReason: '故意失败'
      })
    })
    const done = await runner.runAllConcurrent(p, 1)
    expect(done.status).toBe('failed')
  })

  it('新建项目就是 running，不是 planning', async () => {
    const store = new ProjectStore(dir)
    const created = await store.create('新建', [task('a')])
    expect(created.status).toBe('running')
  })
})
