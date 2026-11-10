import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchOptions,
  parseMode,
  previewDispatch,
  runProject
} from '../../src/main/orchestrator/project'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'
import type { WorkerRunOptions, WorkerRunResult } from '../../src/main/orchestrator/worker'

/**
 * 派发方式候选卡。
 *
 * 核心一条：**链式计划不给并行选项**。A→B→C 开多少路都一样快，
 * 把并行摆上去是骗人的——用户点了也不会快，还多烧几倍并发。
 */

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-proj-'))
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

describe('parseMode', () => {
  it('parallel:N 解析成 N', () => {
    expect(parseMode('parallel:3')).toBe(3)
  })

  it('串行和非法值一律按 1，不猜', () => {
    expect(parseMode('serial')).toBe(1)
    expect(parseMode(undefined)).toBe(1)
    expect(parseMode('parallel:0')).toBe(1)
    expect(parseMode('parallel:abc')).toBe(1)
    expect(parseMode('')).toBe(1)
  })
})

describe('previewDispatch', () => {
  it('四个互不依赖 → 一层四宽，可并行', () => {
    const p = previewDispatch([task('a'), task('b'), task('c'), task('d')])
    expect(p.layerWidths).toEqual([4])
    expect(p.maxWidth).toBe(4)
    expect(p.parallelizable).toBe(true)
  })

  it('链式 A→B→C → 三层各一，不可并行', () => {
    const p = previewDispatch([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] })
    ])
    expect(p.layerWidths).toEqual([1, 1, 1])
    expect(p.maxWidth).toBe(1)
    expect(p.parallelizable).toBe(false)
  })

  it('三路汇一 → 第一批三宽、第二批一宽', () => {
    const p = previewDispatch([
      task('a'),
      task('b'),
      task('c'),
      task('all', { dependsOn: ['a', 'b', 'c'] })
    ])
    expect(p.layerWidths).toEqual([3, 1])
    expect(p.maxWidth).toBe(3)
    expect(p.parallelizable).toBe(true)
  })

  it('单任务不算可并行（并行没有意义）', () => {
    expect(previewDispatch([task('a')]).parallelizable).toBe(false)
  })
})

describe('dispatchOptions', () => {
  it('链式计划只给串行，不给并行', () => {
    const opts = dispatchOptions(previewDispatch([task('a'), task('b', { dependsOn: ['a'] })]))
    expect(opts.map((o) => o.value)).toEqual(['serial'])
  })

  it('四路并行给串行 + 2 路 + 4 路（不列 3，因为最宽层就是 4）', () => {
    const opts = dispatchOptions(previewDispatch([task('a'), task('b'), task('c'), task('d')]))
    expect(opts.map((o) => o.value)).toEqual(['serial', 'parallel:4'])
  })

  it('两路并行给串行和 2 路', () => {
    const opts = dispatchOptions(previewDispatch([task('a'), task('b')]))
    expect(opts.map((o) => o.value)).toEqual(['serial', 'parallel:2'])
  })

  it('选项都带人话说明', () => {
    const opts = dispatchOptions(previewDispatch([task('a'), task('b')]))
    for (const o of opts) {
      expect(o.label.length).toBeGreaterThan(0)
      expect(o.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('runProject', () => {
  it('计划不合法直接拒绝，不在磁盘上留下半截项目', async () => {
    await expect(
      runProject(
        { name: '坏计划', tasks: [task('a', { acceptance: [] })], mode: 'serial' },
        { rootDir: dir, worker: { provider: 'p', model: 'm', tools: [] } }
      )
    ).rejects.toThrow(/计划不合法/)
    const entries = await fs.readdir(dir)
    expect(entries).toEqual([])
  })

  it('串行跑完四任务，验收都过', async () => {
    const r = await runProject(
      {
        name: '四任务',
        tasks: [task('a'), task('b'), task('c'), task('d')],
        mode: 'serial'
      },
      {
        rootDir: dir,
        worker: { provider: 'p', model: 'm', tools: [] },
        runWorkerImpl: fakeWorker
      }
    )
    expect(r.ok).toBe(true)
    expect(r.concurrency).toBe(1)
    expect(r.taskStates.map((t) => t.status)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('选并行时并发数被最宽层夹住（4 路计划选 8 也只开 4）', async () => {
    const peaks = { now: 0, peak: 0 }
    const r = await runProject(
      {
        name: '并行夹住',
        tasks: [task('a'), task('b'), task('c'), task('d')],
        mode: 'parallel:8'
      },
      {
        rootDir: dir,
        worker: { provider: 'p', model: 'm', tools: [] },
        runWorkerImpl: countingWorker(peaks)
      }
    )
    expect(r.concurrency).toBe(4)
    expect(peaks.peak).toBeLessThanOrEqual(4)
    expect(r.ok).toBe(true)
  })
})

async function fakeWorker(opts: WorkerRunOptions): Promise<WorkerRunResult> {
  await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
  return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
}

function countingWorker(peaks: { now: number; peak: number }) {
  return async (opts: WorkerRunOptions): Promise<WorkerRunResult> => {
    peaks.now += 1
    peaks.peak = Math.max(peaks.peak, peaks.now)
    await new Promise((r) => setTimeout(r, 30))
    await fs.writeFile(path.join(opts.workDir, 'out.txt'), 'ok', 'utf8')
    peaks.now -= 1
    return { ok: true, text: 'ok', toolCalls: [], exitCode: 0 }
  }
}
