import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAcceptance } from '../../src/main/orchestrator/acceptance'
import { ProjectStore } from '../../src/main/orchestrator/store'
import { assertWorkerConfig, WorkerConfigError } from '../../src/main/orchestrator/worker'
import { buildPiArgs } from '../../src/main/orchestrator/backends/pi'
import type { OrchestrationTask } from '../../src/main/orchestrator/types'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-test-'))
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

describe('runAcceptance', () => {
  it('文件存在且够大、含该有的字，才通过', async () => {
    await fs.writeFile(path.join(dir, 'out.md'), '结论：编号 A7-31', 'utf8')
    const r = await runAcceptance(
      [
        { kind: 'file-exists', path: 'out.md' },
        { kind: 'min-bytes', path: 'out.md', bytes: 5 },
        { kind: 'contains', path: 'out.md', text: 'A7-31' },
        { kind: 'not-contains', path: 'out.md', text: 'TODO' }
      ],
      dir
    )
    expect(r.passed).toBe(true)
  })

  it('少一条就不通过，并指出是哪条', async () => {
    await fs.writeFile(path.join(dir, 'out.md'), 'TODO 待补', 'utf8')
    const r = await runAcceptance(
      [
        { kind: 'contains', path: 'out.md', text: 'A7-31' },
        { kind: 'not-contains', path: 'out.md', text: 'TODO' }
      ],
      dir
    )
    expect(r.passed).toBe(false)
    expect(r.results.map((x) => x.passed)).toEqual([false, false])
  })

  it('文件不存在时每条都如实说不存在，不抛错', async () => {
    const r = await runAcceptance([{ kind: 'min-bytes', path: 'ghost.md', bytes: 1 }], dir)
    expect(r.passed).toBe(false)
    expect(r.results[0].detail).toContain('不存在')
  })

  it('越界的路径被拒：验收不能成为逃出隔离目录的后门', async () => {
    const r = await runAcceptance([{ kind: 'file-exists', path: '../../etc/passwd' }], dir)
    expect(r.passed).toBe(false)
    expect(r.results[0].detail).toContain('越界')
  })
})

describe('ProjectStore', () => {
  it('计划不合法时拒绝建项目（半截计划比没有计划更糟）', async () => {
    const store = new ProjectStore(dir)
    await expect(store.create('坏计划', [task('a', { acceptance: [] })])).rejects.toThrow(/计划不合法/)
  })

  it('建项目会建好工作目录，并留下 project.json', async () => {
    const store = new ProjectStore(dir)
    const p = await store.create('好计划', [task('a')])
    expect(await fs.stat(path.join(dir, '.orchestrator', 'project.json'))).toBeTruthy()
    expect(await fs.stat(path.join(dir, 'tasks', 'a'))).toBeTruthy()
    expect(p.tasks[0].status).toBe('pending')
  })

  it('保存后能原样读回', async () => {
    const store = new ProjectStore(dir)
    const created = await store.create('往返', [task('a'), task('b', { dependsOn: ['a'] })])
    const loaded = await store.load()
    expect(loaded?.id).toBe(created.id)
    expect(loaded?.tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('并发 updateTask 不会互相覆盖（串行队列）', async () => {
    const store = new ProjectStore(dir)
    await store.create('并发', [task('a'), task('b')])
    await Promise.all([
      store.updateTask('a', { status: 'done' }),
      store.updateTask('b', { status: 'failed' })
    ])
    const loaded = await store.load()
    expect(loaded?.tasks.find((t) => t.id === 'a')?.status).toBe('done')
    expect(loaded?.tasks.find((t) => t.id === 'b')?.status).toBe('failed')
  })

  it('重启对账：running 但没留下 run 记录 → 标 unknown，不猜成功也不猜失败', async () => {
    const store = new ProjectStore(dir)
    await store.create('中断', [task('a')])
    await store.updateTask('a', { status: 'running', lastRunId: 'run-不存在' })
    const loaded = await store.load()
    const t = loaded?.tasks.find((x) => x.id === 'a')
    expect(t?.status).toBe('unknown')
    expect(t?.failureReason).toContain('未知')
  })
})

describe('工作体配置', () => {
  it('pi 没有 provider/model 就明确拒绝，而不是走默认值（那条路是 401）', () => {
    expect(() => assertWorkerConfig({ backend: 'pi', provider: '', model: '', tools: [] })).toThrow(
      WorkerConfigError
    )
    expect(() => assertWorkerConfig({ backend: 'pi', provider: 'eepseek', model: '', tools: [] })).toThrow(
      /401|provider/
    )
  })

  it('非 pi 后端不需要 provider（codex 用自己 config.toml 里的模型）', () => {
    expect(() => assertWorkerConfig({ backend: 'codex', tools: [] })).not.toThrow()
  })

  it('pi 参数里必须显式带 provider 和 model', () => {
    const args = buildPiArgs({
      provider: 'eepseek',
      model: 'deepseek-v4-flash',
      tools: ['read'],
      timeoutMs: 1000
    })
    expect(args).toEqual(
      expect.arrayContaining(['--provider', 'eepseek', '--model', 'deepseek-v4-flash'])
    )
  })

  it('工具白名单为空时传 --no-tools，而不是什么都不传', () => {
    const args = buildPiArgs({ provider: 'p', model: 'm', tools: [], timeoutMs: 1000 })
    expect(args).toContain('--no-tools')
  })

  it('带空格或引号的值直接拒绝（那是给 shell 开口子）', () => {
    expect(() =>
      buildPiArgs({ provider: 'a b', model: 'm', tools: [], timeoutMs: 1000 })
    ).toThrow(/非法字符/)
    expect(() =>
      buildPiArgs({ provider: 'p', model: 'm', tools: ['read;rm -rf /'], timeoutMs: 1000 })
    ).toThrow(/非法字符/)
  })
})
