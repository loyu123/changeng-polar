/**
 * "重复跑几遍"这件事的公共部分：参数解析和稳定性判断。
 *
 * 两个地方都要用它，而且量的是**不同的层**：
 * - `npm run eval -- --repeat=N` 重复**生成**：同一条用例让模型答 N 遍，看回答这一层抖不抖；
 * - `npm run rejudge -- --repeat=N` 重复**判分**：同一条回答让裁判判 N 遍，看判分这一层抖不抖。
 *
 * 分开量是有来历的：H3-1 那次 35/36 与 36/36 的差别先被当成裁判抖动，
 * 复判之后才确认是回答变了。层没分开，就会一直在错的地方加保险。
 */

export class RepeatArgError extends Error {}

/** 单次重复的结论。judgedBy 缺省表示"这一轮不是 LLM 判的"（生成侧本来就没有判分方式） */
export interface RoundVerdict {
  pass: boolean
  judgedBy?: string
}

export interface Stability {
  /** 实际跑了几轮 */
  rounds: number
  /** 几轮通过 */
  passRounds: number
  /** 其中有几轮是 LLM 裁判给的结论（其余是正则/行为断言，重复它们没有意义） */
  llmRounds: number
  /** 每轮结论完全一致 */
  stable: boolean
}

/**
 * 重复次数。默认 1 = 不重复（老行为）。
 *
 * 上限由调用方给，因为两边的单价不一样：eval 每轮是一整次模型对话（含工具调用），
 * rejudge 每轮 H3 要问三次裁判。0 / 负数 / 小数一律拒绝——`--repeat=0` 最危险：
 * 一轮都没跑，报告却是满分。
 */
export function parseRepeat(raw: string | undefined, max: number, why: string): number {
  if (raw === undefined) return 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new RepeatArgError(`--repeat 要是正整数，收到 "${raw}"`)
  if (n > max) throw new RepeatArgError(`--repeat 上限 ${max}（收到 ${n}）：${why}`)
  return n
}

export function stabilityOf(rounds: readonly RoundVerdict[]): Stability {
  const passRounds = rounds.filter((r) => r.pass).length
  return {
    rounds: rounds.length,
    passRounds,
    llmRounds: rounds.filter((r) => r.judgedBy === 'llm').length,
    stable: passRounds === 0 || passRounds === rounds.length
  }
}
