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

/**
 * 便携版：配置单独落一个目录。
 *
 * 「只搬配置」这条口径全靠这里守着——如果哪天 config.json 因为用了 this.p()
 * 而跟着其余数据落回 userData，U 盘上就只剩一个空目录，而界面上不会报错。
 */
describe('Store · 便携版配置目录', () => {
  it('配置写进便携目录，其余数据仍在本机目录', async () => {
    const local = path.join(dir, 'local')
    const usb = path.join(dir, 'usb')
    await fs.mkdir(local, { recursive: true })
    await fs.mkdir(usb, { recursive: true })
    const store = new Store(local, undefined, usb)

    await store.saveConfig({ model: 'portable-model' })
    await store.appendRecord({ tool: 'x', effect: 'read', status: 'ok' } as never)

    const cfgRaw = await fs.readFile(path.join(usb, 'config.json'), 'utf8')
    expect(cfgRaw).toContain('portable-model')
    // userData 那份不该出现配置；记录该在
    await expect(fs.stat(path.join(local, 'config.json'))).rejects.toThrow()
    await expect(fs.stat(path.join(local, 'records.jsonl'))).resolves.toBeTruthy()
    expect(await store.getConfig()).toMatchObject({ model: 'portable-model' })
  })

  it('从便携目录读得到配置（不是只写不读）', async () => {
    const local = path.join(dir, 'local2')
    const usb = path.join(dir, 'usb2')
    await fs.mkdir(local, { recursive: true })
    await fs.mkdir(usb, { recursive: true })
    await fs.writeFile(path.join(usb, 'config.json'), JSON.stringify({ model: 'from-usb' }), 'utf8')
    const store = new Store(local, undefined, usb)
    expect((await store.getConfig()).model).toBe('from-usb')
  })

  it('便携目录不存在时保存会自己建出来', async () => {
    const local = path.join(dir, 'local3')
    const usb = path.join(dir, 'usb3-not-yet')
    await fs.mkdir(local, { recursive: true })
    const store = new Store(local, undefined, usb)
    await store.saveConfig({ model: 'm' })
    expect(await fs.readFile(path.join(usb, 'config.json'), 'utf8')).toContain('"m"')
  })

  it('configPath() 报的是便携目录，设置页据此显示', () => {
    const store = new Store(dir, undefined, path.join(dir, 'usb4'))
    expect(store.configPath()).toBe(path.join(dir, 'usb4'))
  })
})

/**
 * 密钥解不开的检测。
 *
 * 场景是真的：便携配置拿到另一台电脑上，DPAPI 解不开，decrypt 静默回空串。
 * 没有这个检测，用户只会看到 Key 一片空白，分不清"丢了"还是"没填"。
 */
describe('Store · 密钥在本机解不开', () => {
  /** 只会解 enc:v1:ok 的假编解码：其余密文一律解不开（模拟换了电脑的 DPAPI） */
  const codec = {
    active: true,
    encrypt: (plain: string) => (plain ? `enc:v1:${plain}` : plain),
    decrypt: (stored: string) =>
      stored.startsWith('enc:v1:') ? (stored === 'enc:v1:ok' ? 'ok' : '') : stored
  }

  it('解不开的密文会按字段名报出来', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ apiKey: 'enc:v1:other-machine', searchKey: 'enc:v1:ok', model: 'm' }),
      'utf8'
    )
    const store = new Store(dir, codec)
    expect(await store.undecryptableSecrets()).toEqual(['模型 API Key'])
  })

  it('明文与空值不算解不开', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ apiKey: '', searchKey: 'plain-key', judge: { apiKey: '' } }),
      'utf8'
    )
    const store = new Store(dir, codec)
    expect(await store.undecryptableSecrets()).toEqual([])
  })

  it('多账号邮箱授权码解不开也算一条', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ mailAccounts: [{ address: 'a@b.c', authCode: 'enc:v1:nope' }] }),
      'utf8'
    )
    const store = new Store(dir, codec)
    expect(await store.undecryptableSecrets()).toContain('邮箱授权码（多账号）')
  })

  it('配置不存在或坏掉时返回空数组，不抛', async () => {
    const store = new Store(dir, codec)
    expect(await store.undecryptableSecrets()).toEqual([])
    await fs.writeFile(path.join(dir, 'config.json'), '{ 坏掉的 json', 'utf8')
    expect(await store.undecryptableSecrets()).toEqual([])
  })
})
