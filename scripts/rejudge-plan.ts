/**
 * 复判的纯逻辑：参数解析、重复判的抖动统计、多份报告的对表。
 *
 * 抽出来是为了能离线单测——这几件事恰恰是最容易悄悄判错的地方：
 * 同一份报告点两次名会把每条判两遍、重复次数写成 0 会变成"一轮都没判"、
 * 对表时把某份报告缺的用例当成"两条都过"。
 * 它们不碰网络也不读文件，所以"复判的口径"可以像判据一样被锁在测试里。
 */

export class RejudgeArgError extends Error {}

/**
 * `--from` 可以有多个（也可以逗号分隔）。**去重**，顺序保留：
 * 同一份报告点两次名时，结论一样但每条要重新判一遍，而每一遍都是真金白银。
 */
export function parseSources(args: string[]): string[] {
  const out: string[] = []
  for (const raw of args) {
    for (const piece of raw.split(',')) {
      const p = piece.trim()
      if (p && !out.includes(p)) out.push(p)
    }
  }
  return out
}

/**
 * 重复判几次。默认 1 = 老行为（判一遍）。
 *
 * 上限 20 不是为了省事：H3 每判一遍就要问三次裁判，20 × 3 = 60 次调用一条用例，
 * 再高就不是"量抖动"而是"烧钱"，而抖动率在 10 轮左右已经稳了。
 * 0 / 负数 / 小数一律拒绝——`--repeat=0` 最危险：一条都没判，报告却是满分。
 */
export function parseRepeat(raw: string | undefined): number {
  if (raw === undefined) return 1
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new RejudgeArgError(`--repeat 要是正整数，收到 "${raw}"`)
  if (n > 20) throw new RejudgeArgError(`--repeat 上限 20（收到 ${n}）：H3 每轮要问三次裁判，再高只是在烧钱`)
  return n
}

/**
 * 这条用例要不要重复判。
 *
 * 只有 LLM 裁判会抖：正则和行为断言是确定性的，同一条回答判一百遍也是一样结果，
 * 重复它们只会让报告里多出一堆"稳定"的假证据——那正是"看起来验过、其实没验"。
 * 所以只重复可能走 LLM 的两组（H3 恒走、H2 在没有本机证据时走），且没有判分模型时全不重复。
 */
export function shouldRepeat(cat: string, judgeConfigured: boolean): boolean {
  if (!judgeConfigured) return false
  return cat === 'H3' || cat === 'H2'
}

export interface RoundVerdict {
  pass: boolean
  judgedBy: string
}

export interface Stability {
  /** 实际判了几轮 */
  rounds: number
  /** 几轮判通过 */
  passRounds: number
  /** 其中有几轮是 LLM 裁判给的结论（其余是正则/行为断言，重复它们没有意义） */
  llmRounds: number
  /** 每轮结论完全一致 */
  stable: boolean
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

export interface ComparisonColumn {
  /** 表头：这份报告叫什么（文件名或指纹前缀） */
  label: string
  results: ReadonlyArray<{ id: string; cat: string; pass: boolean; judgeTally?: string }>
}

export interface ComparisonCell {
  label: string
  /** null = 这份报告里没有这条用例。**不能当 false，也不能当 true** */
  pass: boolean | null
  tally?: string
}

export interface ComparisonRow {
  id: string
  cat: string
  cells: ComparisonCell[]
  /** 各份报告都有这条、且结论不一致 */
  differs: boolean
}

/**
 * 把几份复判结果对成一张表，一行一条用例。
 *
 * 要点是「某份报告缺这条」必须是 null 而不是 false：把它当失败，会让"没跑到"
 * 看起来像"跑了没过"；当通过则更糟。缺就是缺，表里印成 `—`。
 * `differs` 只在**两份以上都有**这条时才谈得上不一致。
 */
export function buildComparison(columns: ReadonlyArray<ComparisonColumn>): ComparisonRow[] {
  const order: string[] = []
  const cats = new Map<string, string>()
  for (const col of columns) {
    for (const r of col.results) {
      if (!cats.has(r.id)) {
        order.push(r.id)
        cats.set(r.id, r.cat)
      }
    }
  }
  return order.map((id) => {
    const cells = columns.map((col) => {
      const hit = col.results.find((r) => r.id === id)
      return hit
        ? { label: col.label, pass: hit.pass, ...(hit.judgeTally ? { tally: hit.judgeTally } : {}) }
        : { label: col.label, pass: null }
    })
    const present = cells.filter((c): c is ComparisonCell & { pass: boolean } => c.pass !== null)
    const differs = present.length > 1 && present.some((c) => c.pass !== present[0].pass)
    return { id, cat: cats.get(id) ?? '', cells, differs }
  })
}

/** 一份报告里那几行"每轮不一致"的，按 id 列出来——这就是"这条用例落在边界上"的证据 */
export function unstableIds(
  results: ReadonlyArray<{ id: string; rounds?: ReadonlyArray<RoundVerdict> }>
): string[] {
  return results.filter((r) => r.rounds && !stabilityOf(r.rounds).stable).map((r) => r.id)
}
