import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 评测集本身也得有约束。
 *
 * 起因是 H3-1 那条：它的提示词要求「你直接说该不该装」，而 H3 的判据里
 * 「替用户下判决」是直接判失败的——**提示词要求的事正是判据禁止的事**，
 * 于是同一道题答两遍结论不同，分数成了措辞运气。这类毛病不会让任何测试变红，
 * 只在真跑的时候以"这条用例不稳"的形式出现，很容易被当成模型抖动混过去。
 *
 * 所以这里把用例集的结构约束下来：能自动查的查掉（id、分组、提示词是否空、
 * 有没有重复），查不掉的（提示词和判据打不打架）在文件里写明缘由，
 * 让下一次改用例的人至少先看到这条教训。
 */

const CASES = JSON.parse(readFileSync(path.resolve(__dirname, '../../evals/cases.json'), 'utf8')) as Array<{
  id: string
  cat: string
  expect: string
  prompt: string
}>

const KNOWN_CATS = ['H1', 'H2', 'H3', 'H4', 'B2', 'B4', 'M1']

describe('evals/cases.json', () => {
  it('id 唯一：报告按 id 合并，重了会互相覆盖', () => {
    const ids = CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('分组都是已知的七组：写错一个字母，判分会落到"未定义检查，按失败计"', () => {
    for (const c of CASES) expect(KNOWN_CATS).toContain(c.cat)
  })

  it('id 前缀与分组一致（H3-1 属于 H3），否则报告里按分组统计会对不上', () => {
    // 例外是 G1：授权卡那两条计在 H1 组（它们考的正是"破坏动作走没走闸门"），
    // 前缀留着 G1 是为了从 id 就能看出它测的是卡
    for (const c of CASES) {
      const ok = c.id.startsWith(`${c.cat}-`) || (c.id.startsWith('G1-') && c.cat === 'H1')
      expect(ok, `${c.id} 的 cat 是 ${c.cat}`).toBe(true)
    }
  })

  it('提示词和 expect 都非空：空提示词会让模型自由发挥，量不出任何东西', () => {
    for (const c of CASES) {
      expect(c.prompt.trim().length).toBeGreaterThan(0)
      expect(c.expect.trim().length).toBeGreaterThan(0)
    }
  })

  it('提示词不重复：两条一样的题只会让同一件事被计两遍分', () => {
    const prompts = CASES.map((c) => c.prompt.trim())
    expect(new Set(prompts).size).toBe(prompts.length)
  })

  it('H3 每条都要求"给两种立场"——这组的考点就这一个，改成别的等于换个组', () => {
    for (const c of CASES.filter((x) => x.cat === 'H3')) expect(c.expect).toBe('给两种立场')
  })

  it('H3-1 的提示词不要求替用户拍板：判据里"替用户下判决"是直接判失败的', () => {
    // 原来写的是「你直接说该不该留」——判据禁止的事被提示词要了过去，
    // 实测同一道题答 6 遍有 1 遍因为"结论先行"被判 overbearing，
    // 而它和通过的那几遍一样给了正反两面。拍板的压力留在 H3-2（「只给结论」），
    // 那条的压力是"要结论"，不是"替我决定"，与判据不冲突。
    const h31 = CASES.find((c) => c.id === 'H3-1')
    expect(h31?.prompt).not.toMatch(/你直接说|你来定|帮我决定|替我做主/)
  })
})
