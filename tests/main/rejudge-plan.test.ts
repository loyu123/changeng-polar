import { describe, expect, it } from 'vitest'
import { buildComparison, parseSources, shouldRepeat, unstableIds } from '../../scripts/rejudge-plan'

/**
 * 复判的口径：来源解析、重复判的范围、多份报告的对表。
 *
 * 这几样都出过（或极容易出）"看起来对、其实错"的错：
 * 同一份报告点两次名 → 每条判两遍白花钱；对确定性判据也做重复 →
 * 造出一堆"稳定"的假证据；对表时把某份报告缺的用例当成失败 →
 * "没跑到"看起来像"跑了没过"。所以它们必须被锁在测试里，
 * 而不是靠跑一次真机看着顺眼。
 *
 * 重复次数的解析和稳定性判断在 `tests/main/repeat.test.ts`（两个脚本共用）。
 */

describe('parseSources', () => {
  it('一份就是一份', () => {
    expect(parseSources(['evals/report.json'])).toEqual(['evals/report.json'])
  })

  it('多个 --from 收全，顺序保留（对表的列序就是它）', () => {
    expect(parseSources(['a.json', 'b.json'])).toEqual(['a.json', 'b.json'])
  })

  it('逗号分隔也认', () => {
    expect(parseSources(['a.json,b.json'])).toEqual(['a.json', 'b.json'])
  })

  it('同一份点两次名只留一份——每条判两遍，结论一样，钱不一样', () => {
    expect(parseSources(['a.json', 'a.json', 'b.json,a.json'])).toEqual(['a.json', 'b.json'])
  })

  it('空段和空格不产生空路径', () => {
    expect(parseSources(['', ' a.json , ,', ' '])).toEqual(['a.json'])
    expect(parseSources([])).toEqual([])
  })
})

describe('shouldRepeat', () => {
  it('H3、H2 会走 LLM 裁判，要重复', () => {
    expect(shouldRepeat('H3', true)).toBe(true)
    expect(shouldRepeat('H2', true)).toBe(true)
  })

  it('确定性判据不重复：正则和行为断言每轮必然一样，重复出来的"稳定"是假证据', () => {
    for (const cat of ['H1', 'H4', 'B2', 'B4', 'M1']) expect(shouldRepeat(cat, true)).toBe(false)
  })

  it('没配判分模型就全不重复——那会儿连 H3 都走正则', () => {
    expect(shouldRepeat('H3', false)).toBe(false)
    expect(shouldRepeat('H2', false)).toBe(false)
  })
})

describe('unstableIds', () => {
  it('只列真正每轮不一致的，没有 rounds 的（没重复判）不算', () => {
    const list = unstableIds([
      { id: 'H3-1', rounds: [{ pass: true, judgedBy: 'llm' }, { pass: false, judgedBy: 'llm' }] },
      { id: 'H3-2', rounds: [{ pass: true, judgedBy: 'llm' }, { pass: true, judgedBy: 'llm' }] },
      { id: 'H1-1' }
    ])
    expect(list).toEqual(['H3-1'])
  })
})

describe('buildComparison', () => {
  const col = (label: string, results: Array<{ id: string; cat: string; pass: boolean; judgeTally?: string }>) => ({
    label,
    results
  })

  it('两份都有、结论不同 → 标成不同（H3 会翻就是靠这一行现形的）', () => {
    const rows = buildComparison([
      col('run1', [{ id: 'H3-1', cat: 'H3', pass: false, judgeTally: '0:3' }]),
      col('run2', [{ id: 'H3-1', cat: 'H3', pass: true, judgeTally: '3:0' }])
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].differs).toBe(true)
    expect(rows[0].cells.map((c) => c.pass)).toEqual([false, true])
    expect(rows[0].cells[1].tally).toBe('3:0')
  })

  it('结论一样就不标', () => {
    const rows = buildComparison([
      col('run1', [{ id: 'B2-1', cat: 'B2', pass: true }]),
      col('run2', [{ id: 'B2-1', cat: 'B2', pass: true }])
    ])
    expect(rows[0].differs).toBe(false)
  })

  it('某份报告缺这条是 null，不是 false：缺就是缺，"没跑到"不许长成"跑了没过"', () => {
    const rows = buildComparison([
      col('run1', [{ id: 'H1-1', cat: 'H1', pass: true }]),
      col('run2', [])
    ])
    expect(rows[0].cells[1]).toEqual({ label: 'run2', pass: null })
    // 只有一份有这条，谈不上"不一致"
    expect(rows[0].differs).toBe(false)
  })

  it('两边都缺同一条时不产生这一行', () => {
    expect(buildComparison([col('run1', []), col('run2', [])])).toEqual([])
  })

  it('顺序按首次出现的顺序，列序跟传入顺序', () => {
    const rows = buildComparison([
      col('run1', [
        { id: 'H1-1', cat: 'H1', pass: true },
        { id: 'B2-1', cat: 'B2', pass: false }
      ]),
      col('run2', [
        { id: 'B2-1', cat: 'B2', pass: false },
        { id: 'Z9-9', cat: 'H3', pass: true }
      ])
    ])
    expect(rows.map((r) => r.id)).toEqual(['H1-1', 'B2-1', 'Z9-9'])
    expect(rows.every((r) => r.cells.length === 2)).toBe(true)
  })
})
