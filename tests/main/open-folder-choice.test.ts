import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTools } from '../../src/main/agent/tools'
import { executeThroughGate } from '../../src/main/agent/gate'
import { setFolderIndexRoots, resetFolderCache } from '../../src/main/node/folder'
import type { ToolContext } from '../../src/main/agent/tool-types'

/**
 * 打开文件夹遇到同名歧义时，走的是「候选卡」而不是"回一段文字让模型转述"。
 *
 * 用户的期望很具体：他说「打开 kcareone」，D 盘下确实有 KCareOne-ALL / -MAIN /
 * -SQL / -TPS 四条，他要能自己点一个。念一段候选过去不够——他得再用一句话描述
 * 他要的是哪个，来回两三轮，还可能传错。
 */

const sandboxes: string[] = []

/** 造一台假盘：root 下摆出几个同名开头的目录，索引只扫这里 */
function fakeDrive(names: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'butler-choice-'))
  sandboxes.push(root)
  for (const name of names) mkdirSync(path.join(root, name), { recursive: true })
  setFolderIndexRoots([{ dir: root, depth: 3 }])
  resetFolderCache()
  return root
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
  setFolderIndexRoots(null)
  resetFolderCache()
  vi.restoreAllMocks()
})

const ctx: ToolContext = {
  config: {} as never,
  record: (entry) => ({ ...entry, id: 'x', ts: '' })
}

const tool = (openFolder: (p: string) => Promise<string> = async () => '') => {
  const def = createTools({ openFolder }).find((t) => t.name === 'open_folder')
  if (!def) throw new Error('工具清单里没有 open_folder')
  return def
}

/** 装了候选卡能力的闸门：mock 用户点了哪个 */
function gatePicking(picks: string[]) {
  const asked: Array<{ title: string; options: FolderOption[] }> = []
  const hooks = {
    requestAuth: async () => 'once' as const,
    requestChoice: async (request: { title: string; options: FolderOption[] }) => {
      asked.push(request)
      return picks.length > 0 ? picks.shift()! : null
    },
    isRemembered: () => false,
    remember: () => undefined,
    record: () => undefined
  }
  return { hooks, asked }
}

type FolderOption = { value: string; label: string; detail?: string }

describe('打开文件夹 · 同名歧义弹候选卡', () => {
  it('有多个候选 → 弹卡而不是失败，卡上每个候选都带完整路径', async () => {
    const root = fakeDrive(['KCareOne-ALL', 'KCareOne-MAIN', 'KCareOne-SQL'])
    let opened = ''
    const def = createTools({
      openFolder: async (p) => {
        opened = p
        return ''
      }
    }).find((t) => t.name === 'open_folder')!
    const { hooks, asked } = gatePicking([path.join(root, 'KCareOne-ALL')])
    const result = await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)

    expect(asked).toHaveLength(1)
    expect(asked[0].options).toHaveLength(3)
    // 路径是唯一能区分同名前缀东西的信息，必须在卡上
    for (const opt of asked[0].options) {
      expect(opt.detail).toBe(opt.value)
      expect(opt.value.toLowerCase()).toContain('kcareone')
    }
    expect(result.ok).toBe(true)
    expect(opened).toBe(path.join(root, 'KCareOne-ALL'))
  })

  it('只有唯一命中 → 不弹卡，直接打开', async () => {
    const root = fakeDrive(['KCareOne-ALL', '别的目录'])
    let opened = ''
    const def = createTools({
      openFolder: async (p) => {
        opened = p
        return ''
      }
    }).find((t) => t.name === 'open_folder')!
    const { hooks, asked } = gatePicking([])
    const result = await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)
    expect(asked).toHaveLength(0)
    expect(result.ok).toBe(true)
    expect(opened).toBe(path.join(root, 'KCareOne-ALL'))
  })

  it('用户取消候选卡 → 什么都不打开，如实说是取消', async () => {
    fakeDrive(['KCareOne-ALL', 'KCareOne-MAIN'])
    let calls = 0
    const def = createTools({
      openFolder: async () => {
        calls++
        return ''
      }
    }).find((t) => t.name === 'open_folder')!
    const { hooks } = gatePicking([])
    const result = await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)
    expect(calls).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.summary).toContain('取消')
  })

  /**
   * K7：卡片上写的是 A，执行的也必须是 A。
   * 选完之后重新 plan 时用的是写回的**完整路径**，所以不管候选集怎么变，
   * 落到哪一个都不再依赖名字匹配——这里把索引换掉，验证它照样打开用户选的那个。
   */
  it('选完之后即使候选集变了，打开的仍然是用户点的那个', async () => {
    const root = fakeDrive(['KCareOne-ALL', 'KCareOne-MAIN'])
    const picked = path.join(root, 'KCareOne-MAIN')
    let opened = ''
    const def = createTools({
      openFolder: async (p) => {
        opened = p
        return ''
      }
    }).find((t) => t.name === 'open_folder')!

    const hooks = {
      requestAuth: async () => 'once' as const,
      requestChoice: async () => {
        // 用户点下去的同时，索引变得只剩另一个（模拟"重新扫一遍时世界变了"）
        setFolderIndexRoots([{ dir: path.join(root, 'KCareOne-ALL'), depth: 0 }])
        resetFolderCache()
        return picked
      },
      isRemembered: () => false,
      remember: () => undefined,
      record: () => undefined
    }
    const result = await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)
    expect(result.ok).toBe(true)
    expect(opened).toBe(picked)
  })

  it('候选卡上限 8 个，超出的在提示里说明只列了前 8 个', async () => {
    fakeDrive(Array.from({ length: 12 }, (_, i) => `KCareOne-${String(i).padStart(2, '0')}`))
    const def = tool()
    const { hooks, asked } = gatePicking([])
    await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)
    expect(asked).toHaveLength(1)
    expect(asked[0].options).toHaveLength(8)
  })

  /**
   * 没有候选卡能力的调用方（评测、离线验收、定时任务）必须退回旧行为：
   * 当作解析失败拒绝，而不是卡在那里等人点。
   */
  it('没有候选卡能力的环境 → 照旧拒绝，不会卡住', async () => {
    fakeDrive(['KCareOne-ALL', 'KCareOne-MAIN'])
    const def = tool()
    const result = await executeThroughGate(def, { name: 'kcareone' }, ctx, {
      requestAuth: async () => 'once' as const,
      isRemembered: () => false,
      remember: () => undefined,
      record: () => undefined
    })
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
  })
})

describe('候选卡 · 选项顺序', () => {
  // 造的时候故意把最像的那个放最后：排序要是没生效，卡上第一条会是长名字那条
  it('名字越短越靠前（更像用户说的那个）', async () => {
    fakeDrive(['KCareOne-ALL-frontend-v2', 'KCareOne-ALL-old', 'KCareOne-ALL'])
    const def = tool()
    const { hooks, asked } = gatePicking([])
    await executeThroughGate(def, { name: 'kcareone' }, ctx, hooks)
    expect(asked[0].options.map((o) => o.label)).toEqual([
      'KCareOne-ALL',
      'KCareOne-ALL-old',
      'KCareOne-ALL-frontend-v2'
    ])
  })
})
