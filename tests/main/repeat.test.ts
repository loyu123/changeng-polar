import { describe, expect, it } from 'vitest'
import { parseRepeat, RepeatArgError, stabilityOf } from '../../scripts/lib/repeat'

/**
 * "重复跑几遍"的公共逻辑，两个脚本共用、量的是两层：
 * - `npm run eval -- --repeat=N` 重复**生成**（同一条用例让模型答 N 遍）
 * - `npm run rejudge -- --repeat=N` 重复**判分**（同一条回答让裁判判 N 遍）
 *
 * 分开量是有来历的：H3-1 那次 35/36 与 36/36 的差别先被当成裁判抖动，
 * 复判之后才确认是回答变了。层没分开就会一直在错的地方加保险。
 */

describe('parseRepeat', () => {
  const p = (raw: string | undefined): number => parseRepeat(raw, 20, '测试')

  it('不写就是 1（老行为）', () => {
    expect(p(undefined)).toBe(1)
  })

  it('正整数照收', () => {
    expect(p('3')).toBe(3)
    expect(p('20')).toBe(20)
  })

  it('0 必须拒绝：一轮都没跑，报告却是满分', () => {
    expect(() => p('0')).toThrow(RepeatArgError)
  })

  it('负数、小数、乱写一律拒绝', () => {
    expect(() => p('-1')).toThrow(RepeatArgError)
    expect(() => p('2.5')).toThrow(RepeatArgError)
    expect(() => p('三')).toThrow(RepeatArgError)
  })

  it('上限由调用方给：判分侧 20、生成侧 10，超出就拒绝并把原因说出来', () => {
    expect(() => parseRepeat('21', 20, 'H3 每轮要问三次裁判')).toThrow(/20/)
    expect(() => parseRepeat('21', 20, 'H3 每轮要问三次裁判')).toThrow(/三次裁判/)
    expect(() => parseRepeat('11', 10, '每轮是一整次模型对话')).toThrow(/模型对话/)
  })
})

describe('stabilityOf', () => {
  const r = (pass: boolean, judgedBy?: string) => ({ pass, judgedBy })

  it('每轮一致 → 稳定', () => {
    expect(stabilityOf([r(true), r(true), r(true)])).toMatchObject({ stable: true, passRounds: 3, rounds: 3 })
  })

  it('有一轮不一样 → 不稳定，且把通过了几轮记下来', () => {
    expect(stabilityOf([r(true), r(false), r(true)])).toMatchObject({ stable: false, passRounds: 2, rounds: 3 })
  })

  it('全不通过也是稳定：稳定说的是"每轮一样"，不是"都通过"', () => {
    expect(stabilityOf([r(false), r(false)])).toMatchObject({ stable: true, passRounds: 0 })
  })

  it('数得清有几轮真是 LLM 判的（重复确定性判据没有意义）', () => {
    expect(stabilityOf([r(true, 'llm'), r(true, 'regex-fallback')])).toMatchObject({ llmRounds: 1 })
  })

  it('生成侧没有判分方式（judgedBy 缺省）时不算 LLM 轮', () => {
    expect(stabilityOf([r(true), r(true)])).toMatchObject({ llmRounds: 0, stable: true })
  })

  it('只有一轮时永远稳定，且不是"验过"的意思——调用方要自己判断够不够', () => {
    expect(stabilityOf([r(false)])).toMatchObject({ rounds: 1, stable: true })
  })
})
