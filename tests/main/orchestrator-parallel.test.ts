import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_CONCURRENCY, ProjectRunner } from '../../src/main/orchestrator/runner'
import { ProjectStore } from '../../src/main/orchestrator/store'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'
import type { WorkerConfig, WorkerRunOptions, WorkerRunResult } from '../../src/main/orchestrator/worker'

/**
 * 并行调度的可测部分：谁跟谁能同时跑。
 *
 * 真起工作体的部分（worker.ts）不在这里测——那要花额度和时间，
 * 由 scripts/orchestrator-parallel.ts 在真机上跑。这里把 runWorker 换掉，
 * 只验调度：并发上限、同目录冲突、失败不传染。
 */

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-par-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function task(id: string, over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id,
    title: id,
    prompt: `做 ${id}`,
    dependsOn: [],
    status: 'pending',
    acceptance: [{ kind: 'file-exists', path: 'out.txt' }],
    attempts: 0,
    ...over
  }
}

const cfg: WorkerConfig = { provider: 'p', model: 'm', tools: [] }

describe('并行调度', () => {
  it('并发上限被夹在 1~MAX_CONCURRENCY，且真的同时跑', async () => {
    // 记下同时有多少个 worker 在跑，以及峰值
    const active = { now: 0, peak: 0 }
    const seen: string[] = []

    const { ProjectRunner: R } = await import('../../src/main/orchestrator/runner')
    expect(R).toBe(ProjectRunner)

    const store = new ProjectStore(dir)
    await store.create('并发上限', [task('a'), task('b'), task('c'), task('d')])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => cfg,
      // 用假 worker 替换掉真起进程的那层
      runWorkerImpl: async (opts: WorkerRunOptions): Promise<WorkerRunResult> => {
        active.now += 1
        active.peak = Math.max(active.peak, active.now)
        seen.push(opts.workDir)
        await new Promise((r) => setTimeout(r, 30))
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        active.now -= 1
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    await runner.runAllConcurrent(project, 99)

    expect(active.peak).toBeLessThanOrEqual(MAX_CONCURRENCY)
    expect(active.peak).toBeGreaterThan(1) // 确认真的并发了
    expect(seen.length).toBe(4)
  })

  it('同一工作目录的两个任务不会被同时派发', async () => {
    const overlap: string[] = []
    const active = new Set<string>()

    const store = new ProjectStore(dir)
    // 两个任务显式指向同一个目录
    await store.create('冲突', [
      task('a', { workDir: 'tasks/shared' }),
      task('b', { workDir: 'tasks/shared' })
    ])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => cfg,
      onEvent: (e) => {
        if (e.kind === 'deferred') overlap.push(e.taskId)
      },
      runWorkerImpl: async (opts): Promise<WorkerRunResult> => {
        if (active.has(opts.workDir)) throw new Error('同一目录被并发写入')
        active.add(opts.workDir)
        await new Promise((r) => setTimeout(r, 20))
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        active.delete(opts.workDir)
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    await runner.runAllConcurrent(project, 4)

    // 至少有一个被推迟，且两个最终都跑了
    expect(overlap.length).toBeGreaterThanOrEqual(1)
    const after = (await store.load())!
    expect(after.tasks.every((t) => t.status === 'done')).toBe(true)
  })

  it('一个失败不传染：它的下游卡住，无关的照跑', async () => {
    const store = new ProjectStore(dir)
    await store.create('失败不传染', [
      task('bad'),
      task('dep', { dependsOn: ['bad'] }),
      task('free1'),
      task('free2')
    ])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => cfg,
      runWorkerImpl: async (opts): Promise<WorkerRunResult> => {
        const isBad = opts.workDir.endsWith('bad')
        await new Promise((r) => setTimeout(r, 10))
        if (isBad) {
          return { ok: false, text: '', toolCalls: [], exitCode: 1, failureReason: '故意失败' }
        }
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
        return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
      }
    })

    const done = await runner.runAllConcurrent(project, 2)
    const byId = new Map(done.tasks.map((t) => [t.id, t.status]))
    expect(byId.get('bad')).toBe('failed')
    expect(byId.get('dep')).toBe('pending') // 上游没产出，不硬跑
    expect(byId.get('free1')).toBe('done')
    expect(byId.get('free2')).toBe('done')
  })

  it('验收不过 = 失败，工作体说成功也不算', async () => {
    const store = new ProjectStore(dir)
    await store.create('验收硬门', [
      task('sloppy', { acceptance: [{ kind: 'contains', path: 'out.txt', text: '必须有这句' }] })
    ])
    const project = (await store.load())!

    const runner = new ProjectRunner({
      store,
      resolveWorker: () => cfg,
      runWorkerImpl: async (opts): Promise<WorkerRunResult> => {
        // 工作体自称成功，但没写出要求的内容
        await fs.writeFile(path.join(opts.workDir, 'out.txt'), '我写完了', 'utf8')
        return { ok: true, text: '已完成', toolCalls: [], exitCode: 0 }
      }
    })

    const done = await runner.runAllConcurrent(project, 1)
    const t = done.tasks.find((x) => x.id === 'sloppy')!
    expect(t.status).toBe('failed')
    expect(t.failureReason).toContain('验收未通过')
  })
})
