import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/main/node/store'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * 本地存储。
 * 重点不是"能存能取"，而是三类已经出过问题的地方：
 * 并发写丢数据、记录文件无上限增长、进程被强杀留下半截 JSON。
 */
let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'butler-store-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('Store · 并发写入', () => {
  it('并发改配置的不同字段，三份改动都要留下', async () => {
    // 原来 saveConfig 是"读全量→合并→写回"，三个并发调用只会有最后一个生效
    const store = new Store(dir)
    await Promise.all([
      store.saveConfig({ model: 'a' }),
      store.saveConfig({ temperature: 0.5 }),
      store.saveConfig({ apiKey: 'k' })
    ])
    const cfg = await store.getConfig()
    expect(cfg).toMatchObject({ model: 'a', temperature: 0.5, apiKey: 'k' })
  })

  it('并发新增两条会话，两条都在', async () => {
    const store = new Store(dir)
    const add = (id: string) =>
      store.mutateSessions((list) => {
        const next = [...list, { id, ts: 1, title: id, messages: [] }]
        return { list: next, result: next }
      })
    await Promise.all([add('s1'), add('s2')])
    expect((await store.listSessions()).map((s) => s.id).sort()).toEqual(['s1', 's2'])
  })

  it('并发新增两条记忆，两条都在', async () => {
    const store = new Store(dir)
    const add = (id: string) =>
      store.mutateMemory((list) => ({
        list: [...list, { id, kind: 'fact' as const, text: id, createdAt: '', updatedAt: '' }],
        result: []
      }))
    await Promise.all([add('m1'), add('m2')])
    expect((await store.listMemory()).map((m) => m.id).sort()).toEqual(['m1', 'm2'])
  })

  it('一次失败不会把后续写入卡死', async () => {
    const store = new Store(dir)
    // 传一个无法序列化的值让这次写失败
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(store.saveConfig({ model: circular as unknown as string })).rejects.toThrow()
    // 队列必须能继续工作
    await store.saveConfig({ model: 'after-failure' })
    expect((await store.getConfig()).model).toBe('after-failure')
  })
})

describe('Store · 记录轮转', () => {
  const entry = (title: string) => ({ kind: 'read' as const, title, sub: '', result: 'ok' as const, reversible: false })

  it('超过上限就改名成 .1，新记录写进新文件', async () => {
    const store = new Store(dir)
    const big = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ id: `r${i}`, ts: '', kind: 'read', title: `旧 ${i}`, sub: 'x'.repeat(200), result: 'ok', reversible: false })
    ).join('\n')
    await fs.writeFile(path.join(dir, 'records.jsonl'), `${big}\n`, 'utf8')

    await store.appendRecord(entry('新记录'))
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('records'))
    expect(files).toContain('records.jsonl.1')
    expect((await fs.stat(path.join(dir, 'records.jsonl'))).size).toBeLessThan(1000)
  })

  it('跨轮转边界读取时，最新的记录排在最前', async () => {
    // 踩过的坑：先读新文件再读旧文件、最后 slice(-limit)，
    // 截到的是最旧那批，刚写的新记录会被挤掉
    const store = new Store(dir)
    const big = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ id: `r${i}`, ts: '', kind: 'read', title: `旧 ${i}`, sub: 'x'.repeat(200), result: 'ok', reversible: false })
    ).join('\n')
    await fs.writeFile(path.join(dir, 'records.jsonl'), `${big}\n`, 'utf8')
    await store.appendRecord(entry('新记录'))

    const list = await store.listRecords(3)
    expect(list[0].title).toBe('新记录')
    expect(list.map((r) => r.title)).toHaveLength(3)
  })

  it('只保留两份旧文件，第三份的旧 .2 会被丢掉', async () => {
    const store = new Store(dir)
    const big = Array.from({ length: 20000 }, (_, i) =>
      JSON.stringify({ id: `r${i}`, ts: '', kind: 'read', title: `旧 ${i}`, sub: 'x'.repeat(200), result: 'ok', reversible: false })
    ).join('\n')
    for (let round = 0; round < 2; round++) {
      await fs.writeFile(path.join(dir, 'records.jsonl'), `${big}\n`, 'utf8')
      await store.appendRecord(entry(`第 ${round} 轮`))
    }
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('records')).sort()
    expect(files).toEqual(['records.jsonl', 'records.jsonl.1', 'records.jsonl.2'])
  })

  it('老版本的 {t:"revert"} 废行被跳过', async () => {
    const store = new Store(dir)
    await fs.writeFile(
      path.join(dir, 'records.jsonl'),
      `${JSON.stringify({ t: 'revert', id: 'old' })}\n${JSON.stringify({ id: 'ok', ts: '', kind: 'read', title: '正经记录', sub: '', result: 'ok', reversible: false })}\n`,
      'utf8'
    )
    const list = await store.listRecords(10)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('正经记录')
  })

  it('被写坏的文件不会让记录页崩，也不会覆盖原文件', async () => {
    const store = new Store(dir)
    await fs.writeFile(path.join(dir, 'records.jsonl'), '{不是合法 JSON', 'utf8')
    const list = await store.listRecords(10)
    expect(list).toEqual([])
    // 原文件还在，没有被空数组冲掉
    const raw = await fs.readFile(path.join(dir, 'records.jsonl'), 'utf8')
    expect(raw).toBe('{不是合法 JSON')
  })
})

describe('Store · 配置读取', () => {
  it('没有配置文件时返回默认值，不抛错', async () => {
    const store = new Store(dir)
    const cfg = await store.getConfig()
    expect(cfg.model).toBeTruthy()
    expect(cfg.mailAccounts).toEqual([])
  })

  it('半截配置与默认值合并（新版本加的字段不会变 undefined）', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ model: 'custom' }), 'utf8')
    const store = new Store(dir)
    const cfg: ButlerConfig = await store.getConfig()
    expect(cfg.model).toBe('custom')
    expect(cfg.searchProvider).toBeTruthy()
  })

  it('配置带 UTF-8 BOM 也照样读得出（记事本存 UTF-8 默认加 BOM）', async () => {
    // 带 BOM 时 JSON.parse 直接抛错，被 catch 吞掉后整份配置回落默认值——
    // 用户的模型地址和 Key 会静默消失，界面上看不出异常
    const body = JSON.stringify({ model: 'custom-from-notepad', apiKey: 'secret' })
    await fs.writeFile(path.join(dir, 'config.json'), `﻿${body}`, 'utf8')
    const store = new Store(dir)
    const cfg = await store.getConfig()
    expect(cfg.model).toBe('custom-from-notepad')
    expect(cfg.apiKey).toBe('secret')
  })

  it('列表文件带 BOM 时不会被当成损坏文件覆盖掉', async () => {
    await fs.writeFile(path.join(dir, 'tasks.json'), '﻿[]', 'utf8')
    const store = new Store(dir)
    expect(await store.listTasks()).toEqual([])
    // 真当成损坏的话会留下 .corrupt 副本
    await expect(fs.stat(path.join(dir, 'tasks.json.corrupt'))).rejects.toThrow()
  })
})
