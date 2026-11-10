import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRunner } from '../../src/main/orchestrator/runner'
import { ProjectStore } from '../../src/main/orchestrator/store'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'
import type { WorkerConfig, WorkerRunOptions, WorkerRunResult } from '../../src/main/orchestrator/worker'

/**
 * 按任务分配后端。
 *
 * 一个项目里可以按活的性质分配：整理资料给 codebuddy、跑代码给 pi。
 * 这里锁的是**调度真把任务交给了指定的那家**，以及没指定时走默认。
 */

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-perbackend-'))
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
    acceptance: [{ kind: 'file-exists', path: 'out.txt' }],
    attempts: 0,
    ...over
  }
}

const defaultWorker: WorkerConfig = { backend: 'pi', provider: 'p', model: 'm', tools: ['read'] }

describe('按任务分配后端', () => {
  it('任务指定了后端就走那家；没指定走默认', async () => {
    const calls: { taskId: string; backend: string }[] = []
    const store = new ProjectStore(dir)
    await store.create('分后端', [
      task('a'),
      task('b', { worker: { backend: 'claude' } }),
      task('c', { worker: { backend: 'codebuddy' } })
    ])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => defaultWorker,
      runWorkerImpl: async (opts: WorkerRunOptions & { config: WorkerConfig }): Promise<WorkerRunResult> => {
        // 从 workDir 的末段反推是哪个任务
        const taskId = path.basename(opts.workDir)
        calls.push({ taskId, backend: opts.config.backend ?? '?' })
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    await runner.runAllConcurrent(project, 1)

    const byTask = new Map(calls.map((c) => [c.taskId, c.backend]))
    expect(byTask.get('a')).toBe('pi') // 默认
    expect(byTask.get('b')).toBe('claude')
    expect(byTask.get('c')).toBe('codebuddy')
  })

  it('任务自己的能力词覆盖配置里的', async () => {
    const seen: string[][] = []
    const store = new ProjectStore(dir)
    await store.create('能力词', [task('a', { worker: { tools: ['read', 'write'] } })])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => ({ ...defaultWorker, tools: ['read'] }),
      runWorkerImpl: async (opts: WorkerRunOptions & { config: WorkerConfig }): Promise<WorkerRunResult> => {
        seen.push(opts.config.tools)
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    await runner.runAllConcurrent(project, 1)
    expect(seen[0]).toEqual(['read', 'write'])
  })

  it('没写能力词就继承默认后端的', async () => {
    const seen: string[][] = []
    const store = new ProjectStore(dir)
    await store.create('继承', [task('a')])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => ({ ...defaultWorker, tools: ['read', 'edit'] }),
      runWorkerImpl: async (opts: WorkerRunOptions & { config: WorkerConfig }): Promise<WorkerRunResult> => {
        seen.push(opts.config.tools)
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    await runner.runAllConcurrent(project, 1)
    expect(seen[0]).toEqual(['read', 'edit'])
  })
})
