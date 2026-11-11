import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { judgeModelOf, scoreCase } from './judge'
import { answerFingerprint, AnswerSetError, judgeRecordsOf, loadAnswerSet } from './answer-set'
import { describeMissing, loadScriptConfig } from './lib/load-config'

/**
 * 复判：固定答案集，只重判、不重答。
 *
 * 为什么需要它：`npm run eval` 一边生成回答一边判分，两份报告之间的分数差
 * 混着两个原因——回答变了、判分变了。实测同一套用例连跑两遍是 35/36 和 36/36，
 * 而掉的那一分来自回答（这一轮少说了一句反面），裁判两遍都是全票。也就是说
 * 全跑报告的分数**没法横向比**。
 *
 * 这个脚本把回答冻在原地（从上次的报告里读），只重跑判分那一层：
 * 不跑模型、不执行任何动作、不碰沙箱。两份复判报告之间如果答案集指纹相同，
 * 差异就只可能来自裁判或判据——那才是能拿来比、能拿来说事的数字。
 *
 * 它还会把这次结果和原报告逐条对比，翻了的那些直接列出来。裁判抖不抖、
 * 判据改得对不对，看这一份比看总分清楚。
 */

interface Case {
  id: string
  cat: 'H1' | 'H2' | 'H3' | 'H4' | 'B2' | 'B4' | 'M1'
  prompt: string
  scope?: 'tool' | 'outside'
  mail?: 'ok' | 'none' | 'bad'
  card?: 'allow' | 'deny'
}

interface RejudgeResult {
  id: string
  cat: string
  prompt: string
  pass: boolean
  reason: string
  judgedBy: string
  /** 回答原文：原样搬过来。下一次复判还要用它当输入 */
  text: string
  toolNames: string[]
  evidence: number
  records: string[]
  /** 原报告给这条的结论，和这次的并排放，翻了的一眼就能看见 */
  prevPass: boolean
  prevReason: string
  judgeModel: string | null
  judgeFlags?: { pro?: boolean; con?: boolean; hedge?: boolean; overbearing?: boolean }
  judgeVotes?: Array<{ balanced: boolean; reason: string }>
  judgeTally?: string
}

const ROOT = path.resolve(__dirname, '..')
const CASES_PATH = path.join(ROOT, 'evals', 'cases.json')
const DEFAULT_FROM = path.join(ROOT, 'evals', 'report.json')
const DEFAULT_OUT = path.join(ROOT, 'evals', 'rejudge.json')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const argOf = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const from = path.resolve(argOf('from') ?? DEFAULT_FROM)
  const out = path.resolve(argOf('out') ?? DEFAULT_OUT)
  const onlyCat = argOf('cat')
  const onlyId = argOf('id')

  console.log('复判模式：只重判、不重答（不跑模型、不执行动作、不碰沙箱）\n')

  if (!existsSync(from)) {
    console.error(`找不到要复判的报告：${from}`)
    console.error('先跑一次 `npm run eval` 生成回答，或用 --from=<路径> 指定另一份。')
    process.exit(1)
  }

  let source: Record<string, unknown>
  try {
    source = JSON.parse(readFileSync(from, 'utf8')) as Record<string, unknown>
  } catch (err) {
    console.error(`报告读不出来（${from}）：${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const allCases = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Case[]
  let set: ReturnType<typeof loadAnswerSet>
  try {
    set = loadAnswerSet(source, allCases)
  } catch (err) {
    if (err instanceof AnswerSetError) {
      console.error(`这份报告没法复判：${err.message}`)
      console.error('复判要求报告里存着回答原文、工具名、来源条数、授权记录四项。')
      process.exit(1)
    }
    throw err
  }

  const cases = allCases.filter((c) => {
    if (onlyCat && c.cat !== onlyCat) return false
    if (onlyId && c.id !== onlyId) return false
    return true
  })
  const byId = new Map(set.answers.map((a) => [a.id, a]))
  const pairs = cases.flatMap((c) => {
    const answer = byId.get(c.id)
    return answer ? [{ testCase: c, answer }] : []
  })

  console.log(`回答来源：${path.relative(ROOT, from) || from}`)
  const srcAt = typeof source.at === 'string' ? source.at : null
  const srcModel = typeof source.model === 'string' ? source.model : '(未记录)'
  const srcJudge = typeof source.judgeModel === 'string' ? source.judgeModel : '(未记录)'
  console.log(`  生成于：${srcAt ? new Date(srcAt).toLocaleString('zh-CN') : '(未记录)'}　干活模型：${srcModel}`)
  console.log(`  原判分模型：${srcJudge}`)
  console.log(`  答案集指纹：${answerFingerprint(set.answers)}`)
  if (set.missing.length > 0) {
    console.log(`  ⚠ 用例集里有 ${set.missing.length} 条不在这份报告里，本次跳过：${set.missing.join(', ')}`)
  }
  if (set.unknown.length > 0) {
    console.log(`  ⚠ 报告里有 ${set.unknown.length} 条用例集已经没有（用例改过？），本次跳过：${set.unknown.join(', ')}`)
  }

  const loaded = loadScriptConfig()
  const baseConfig = loaded.config
  if (loaded.missing.length > 0 && !baseConfig.judge) console.log(`\n${describeMissing(loaded)}`)
  // 判分模型与干活模型必须不是同一个，否则分数是自己给自己打的
  const judgeModel = judgeModelOf(baseConfig)
  const judgeLabel = judgeModel ? `${judgeModel.model} @ ${judgeModel.baseUrl}` : null
  if (judgeModel) {
    console.log(`\n判分模型：${judgeLabel}`)
    if (srcJudge !== '(未记录)' && srcJudge !== judgeLabel) {
      console.log('  ⚠ 与原报告的判分模型不同——两份分数的差异里混着"换了裁判"这一项')
    }
  } else {
    console.log('\n判分模型：未配置（设置 → 判分模型）——H3/H2 会回落到正则，报告里会标出来')
  }
  console.log(`用例：${pairs.length} 条${onlyCat ? `（仅 ${onlyCat}）` : ''}\n`)

  if (pairs.length === 0) {
    console.error('没有一条用例能在这份报告里找到回答，什么都不做。')
    process.exit(1)
  }

  const results: RejudgeResult[] = []
  for (const { testCase, answer } of pairs) {
    const started = Date.now()
    const verdict = await scoreCase({
      case: testCase,
      text: answer.text,
      toolNames: answer.toolNames,
      evidenceCount: answer.evidenceCount,
      records: judgeRecordsOf(answer.records),
      config: baseConfig,
      // 复判不执行动作：沙箱里没有当时的现场，G1 的这道复核明确报"没做"，不假装验过
      sandboxNoteExists: null
    })
    const elapsed = Date.now() - started
    results.push({
      id: testCase.id,
      cat: testCase.cat,
      prompt: testCase.prompt,
      pass: verdict.pass,
      reason: verdict.reason,
      judgedBy: verdict.judgedBy,
      text: answer.text,
      toolNames: answer.toolNames,
      evidence: answer.evidenceCount,
      records: answer.records,
      prevPass: answer.prevPass,
      prevReason: answer.prevReason,
      judgeModel: judgeModel ? judgeModel.model : null,
      ...(verdict.judgeFlags ? { judgeFlags: verdict.judgeFlags } : {}),
      ...(verdict.judgeVotes ? { judgeVotes: verdict.judgeVotes } : {}),
      ...(verdict.judgeTally ? { judgeTally: verdict.judgeTally } : {})
    })
    const flip = verdict.pass === answer.prevPass ? '   ' : answer.prevPass ? '翻↓' : '翻↑'
    console.log(`${flip} ${verdict.pass ? 'PASS' : 'FAIL'}  ${testCase.id.padEnd(6)} ${(elapsed / 1000).toFixed(1).padStart(5)}s  ${verdict.reason}`)
    if (flip !== '   ') console.log(`         原判 ${answer.prevPass ? 'PASS' : 'FAIL'}：${answer.prevReason}`)
  }

  const byCat = new Map<string, { pass: number; total: number }>()
  for (const r of results) {
    const slot = byCat.get(r.cat) ?? { pass: 0, total: 0 }
    slot.total += 1
    if (r.pass) slot.pass += 1
    byCat.set(r.cat, slot)
  }
  const totalPass = results.filter((r) => r.pass).length
  const prevPass = results.filter((r) => r.prevPass).length
  const flips = results.filter((r) => r.pass !== r.prevPass)

  console.log('\n================ 记分板（复判） ================')
  for (const [cat, slot] of [...byCat.entries()].sort()) {
    const prev = results.filter((r) => r.cat === cat && r.prevPass).length
    const rate = ((slot.pass / slot.total) * 100).toFixed(0)
    console.log(`${cat.padEnd(3)} ${slot.pass}/${slot.total}  ${rate}%（原 ${prev}/${slot.total}）`)
  }
  const pct = (n: number): string => ((n / results.length) * 100).toFixed(1)
  console.log(`合计 ${totalPass}/${results.length}  ${pct(totalPass)}%（原 ${prevPass}/${results.length}  ${pct(prevPass)}%）`)

  console.log(`\n================ 与原报告逐条比 ================`)
  if (flips.length === 0) {
    console.log(`没有一条翻转：${results.length} 条判分结论与原报告一致。`)
    console.log('同一个答案集、同一套判据判出同一个结果——这就是"比得上"的前提。')
  } else {
    console.log(`${flips.length} 条翻转（回答没变，变的只有裁判/判据）：`)
    for (const r of flips) {
      console.log(`  ${r.id}  ${r.prevPass ? 'PASS → FAIL' : 'FAIL → PASS'}  ${r.reason.slice(0, 70)}`)
    }
  }

  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(
    out,
    JSON.stringify(
      {
        // 报告自己要说清是哪一种模式产的：把复判分当成全跑分读，是最容易犯的错
        mode: 'rejudge',
        at: new Date().toISOString(),
        answersFrom: {
          path: path.relative(ROOT, from) || from,
          at: srcAt,
          model: srcModel,
          judgeModel: typeof source.judgeModel === 'string' ? source.judgeModel : null,
          fingerprint: answerFingerprint(set.answers)
        },
        answerFingerprint: answerFingerprint(set.answers),
        judgeModel: judgeLabel,
        judgedByLLM: results.filter((r) => r.judgedBy === 'llm').length,
        judgedByRegex: results.filter((r) => r.judgedBy === 'regex' || r.judgedBy === 'regex-fallback').length,
        missing: set.missing,
        unknown: set.unknown,
        totalPass,
        total: results.length,
        prevTotalPass: prevPass,
        flipped: flips.map((r) => ({ id: r.id, from: r.prevPass, to: r.pass })),
        results
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`\n明细已写入 ${out}`)
}

void main()
