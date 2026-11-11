import { createHash } from 'node:crypto'
import type { JudgeRecord } from './judge'

/**
 * 从一份已写好的评测报告里，把"回答"读出来——供复判使用（只重判不重答）。
 *
 * 为什么要有这个模块：同一套用例连跑两遍，总分会在 35 和 36 之间抖，而抖的那一分
 * **来自回答本身**（模型这一轮多说了一句），不来自判分。也就是说两份全跑报告之间的
 * 分数差，混着"回答变了"和"判分变了"两个原因，读不出结论。
 * 把回答冻住、只重跑判分那一层，差异就只剩裁判和判据——那才是能拿来比的数字。
 *
 * 冻住的前提是报告里存够了判分要用的东西。`eval.ts` 为这个存了四项：
 * 回答原文、调过的工具名、来源条数、授权记录（一行 `kind:result:authz`）。
 * 少一项就没法重判，宁可当场拒绝，也不拿半个事实去打分。
 */

/** 报告里一条回答 + 判分要用的全部现场 */
export interface RecordedAnswer {
  id: string
  cat: string
  text: string
  toolNames: string[]
  evidenceCount: number
  /** 原样保留（`kind:result:authz` 一行一条）：复判报告要把它原封不动写回去 */
  records: string[]
  /** 原报告给这条的结论：复判后要能一眼看出翻没翻 */
  prevPass: boolean
  prevReason: string
  /** 原报告写的是哪一版判分方式（只用来展示，不参与判分） */
  prevJudgedBy: string
}

export interface AnswerSet {
  answers: RecordedAnswer[]
  /** 用例集里有、这份报告里没有的 id：这些没法复判 */
  missing: string[]
  /** 报告里有、用例集里已经没有的 id：用例被改过或删过 */
  unknown: string[]
}

export class AnswerSetError extends Error {}

/**
 * 把报告里的 `records`（`kind:result:authz` 一行字符串）还原成判分要的字段。
 *
 * 为什么留的是一行字符串而不是原对象：报告是给人看的，一行"write:ok:user_once"
 * 比一整段 RecordEntry 好读，体积也小一半。判分只用得到后两段，所以从右往左切——
 * `kind` 将来若带上冒号也不会切错。
 */
export function parseRecordLine(line: string): JudgeRecord {
  const parts = line.split(':')
  const authz = parts.length >= 3 ? parts[parts.length - 1] : undefined
  const result = parts.length >= 2 ? parts[parts.length - 2] : ''
  return { result, ...(authz && authz !== '-' ? { authz } : {}) }
}

/** 判分要的那两项，从报告里的字符串还原 */
export function judgeRecordsOf(lines: ReadonlyArray<string>): JudgeRecord[] {
  return lines.map(parseRecordLine)
}

/**
 * 答案集指纹：回答原文一变，指纹就变。
 *
 * 有了它才能回答"这两份分数能不能比"：指纹相同 = 判的是同一批回答，
 * 分差只可能来自裁判/判据；指纹不同 = 回答换了，比较总分没有意义。
 * 只取 16 位十六进制——它是个标识，不是密码学凭据。
 */
export function answerFingerprint(answers: ReadonlyArray<{ id: string; text: string }>): string {
  const hash = createHash('sha256')
  const sorted = [...answers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const a of sorted) {
    hash.update(a.id)
    hash.update('\u0000')
    hash.update(a.text)
    hash.update('\u0000')
  }
  return hash.digest('hex').slice(0, 16)
}

function str(v: unknown, what: string, id: string): string {
  if (typeof v !== 'string') throw new AnswerSetError(`用例 ${id} 的 ${what} 不是字符串——这份报告不是 eval 写的，或者被改过`)
  return v
}

/**
 * 读报告。**判分现场缺一项就整体拒绝**，不做"缺了就当空"的宽容：
 * 把"来源条数读不出来"当成 0，会让 B2 直接判失败、H2 直接转 LLM——分数看着有，
 * 其实是拿缺了字段的事实打出来的，这比跑不起来糟得多。
 */
export function loadAnswerSet(report: unknown, cases: ReadonlyArray<{ id: string }>): AnswerSet {
  if (!report || typeof report !== 'object') throw new AnswerSetError('报告不是 JSON 对象')
  const results = (report as { results?: unknown }).results
  if (!Array.isArray(results)) {
    throw new AnswerSetError('报告里没有 results 数组——这不是一份评测报告')
  }
  if (results.length === 0) throw new AnswerSetError('报告里的 results 是空的，没有回答可以复判')

  const answers: RecordedAnswer[] = []
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') throw new AnswerSetError('results 里有一条不是对象')
    const r = raw as Record<string, unknown>
    const id = str(r.id, 'id', String(r.id ?? '?'))
    const text = str(r.text, 'text（回答原文）', id)
    if (typeof r.evidence !== 'number' || !Number.isFinite(r.evidence)) {
      throw new AnswerSetError(`用例 ${id} 缺来源条数（evidence）——复判要重算"有没有出处"，这一项读不出来就没法判`)
    }
    if (!Array.isArray(r.toolNames)) {
      throw new AnswerSetError(`用例 ${id} 缺 toolNames——H4/M1/G1 判的就是"调没调那个工具"`)
    }
    if (!Array.isArray(r.records)) {
      throw new AnswerSetError(`用例 ${id} 缺 records——H1/G1 判的是授权记录，这一项不能当空`)
    }
    answers.push({
      id,
      cat: typeof r.cat === 'string' ? r.cat : '',
      text,
      toolNames: r.toolNames.filter((n): n is string => typeof n === 'string'),
      evidenceCount: r.evidence,
      records: r.records.filter((l): l is string => typeof l === 'string'),
      prevPass: r.pass === true,
      prevReason: typeof r.reason === 'string' ? r.reason : '',
      prevJudgedBy: typeof r.judgedBy === 'string' ? r.judgedBy : ''
    })
  }

  const have = new Set(answers.map((a) => a.id))
  const known = new Set(cases.map((c) => c.id))
  return {
    answers,
    missing: cases.filter((c) => !have.has(c.id)).map((c) => c.id),
    unknown: [...have].filter((id) => !known.has(id))
  }
}
