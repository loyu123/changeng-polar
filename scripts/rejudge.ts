import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { judgeModelOf, scoreCase, type ScoreVerdict } from './judge'
import { answerFingerprint, AnswerSetError, judgeRecordsOf, loadAnswerSet, type AnswerSet } from './answer-set'
import { parseRepeat, RepeatArgError, stabilityOf } from './lib/repeat'
import { buildComparison, parseSources, shouldRepeat, unstableIds } from './rejudge-plan'
import { describeMissing, loadScriptConfig } from './lib/load-config'

/**
 * 复判：固定答案集，只重判、不重答。
 *
 * 为什么需要它：`npm run eval` 一边生成回答一边判分，两份报告之间的分数差
 * 混着两个原因——回答变了、判分变了。实测同一套用例连跑两遍是 35/36 和 36/36，
 * 而掉的那一分来自回答（这一轮少说了一句反面），裁判两遍都是全票。也就是说
 * 全跑报告的分数**没法横向比**。
 *
 * 这个脚本把回答冻在原地（从已有的报告里读），只重跑判分那一层：
 * 不跑模型、不执行任何动作、不碰沙箱。于是：
 *
 * - 两份复判之间指纹相同 → 差异只可能来自裁判或判据，那才是能拿出来说的数字；
 * - 一次给几份 eval 报告（`--from=a --from=b`），脚本逐份复判，最后对成一张表，
 *   **哪条用例在哪份报告里结论不同**一眼能看见——H3 这种会翻的用例就在这张表上现形；
 * - `--repeat=N` 把同一份回答判 N 遍，专门量裁判自己抖不抖。确定性判据（正则、行为断言）
 *   不重复：它们每轮必然一样，重复出来的"稳定"是假证据。
 */

interface Case {
  id: string
  cat: 'H1' | 'H2' | 'H3' | 'H4' | 'B2' | 'B4' | 'M1'
  prompt: string
  scope?: 'tool' | 'outside'
  mail?: 'ok' | 'none' | 'bad'
  card?: 'allow' | 'deny'
}

interface RoundRecord {
  pass: boolean
  reason: string
  judgedBy: string
  judgeTally?: string
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
  judgeFlags?: ScoreVerdict['judgeFlags']
  judgeVotes?: ScoreVerdict['judgeVotes']
  judgeTally?: string
  /** 判了不止一遍时：每轮各自怎么判的（第一轮的结论就是上面那个 pass） */
  rounds?: RoundRecord[]
}

interface ReportRun {
  source: {
    path: string
    at: string | null
    model: string
    judgeModel: string | null
    fingerprint: string
    missing: string[]
    unknown: string[]
  }
  results: RejudgeResult[]
  totalPass: number
  total: number
  prevTotalPass: number
  flipped: Array<{ id: string; from: boolean; to: boolean }>
  unstable: string[]
}

const ROOT = path.resolve(__dirname, '..')
const CASES_PATH = path.join(ROOT, 'evals', 'cases.json')
const DEFAULT_FROM = path.join(ROOT, 'evals', 'report.json')
const DEFAULT_OUT = path.join(ROOT, 'evals', 'rejudge.json')

function argValues(args: string[], name: string): string[] {
  const prefix = `--${name}=`
  return args.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length))
}

function argValue(args: string[], name: string): string | undefined {
  return argValues(args, name)[0]
}

/** 读一份报告并把它变成答案集；读不出来就说明为什么，不猜 */
function readAnswerSet(file: string, cases: ReadonlyArray<Case>): { set: AnswerSet; raw: Record<string, unknown> } {
  if (!existsSync(file)) {
    throw new RepeatArgError(`找不到报告：${file}\n先跑一次 \`npm run eval\` 生成回答，或用 --from=<路径> 指定另一份。`)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new RepeatArgError(`报告读不出来（${file}）：${err instanceof Error ? err.message : String(err)}`)
  }
  return { set: loadAnswerSet(raw, cases), raw }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sources = parseSources(argValues(args, 'from'))
  const out = path.resolve(argValue(args, 'out') ?? DEFAULT_OUT)
  const onlyCat = argValue(args, 'cat')
  const onlyId = argValue(args, 'id')
  let repeat: number
  try {
    // H3 每判一遍就要问三次裁判，20 轮 = 60 次调用一条用例，再高不是量抖动是烧钱
    repeat = parseRepeat(argValue(args, 'repeat'), 20, 'H3 每轮要问三次裁判，再高只是在烧钱')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  const fromList = (sources.length > 0 ? sources : [DEFAULT_FROM]).map((p) => path.resolve(p))
  // 先确认每一份都在：等到判了一半才发现第三份路径写错，前面那次判分就白花了
  for (const file of fromList) {
    if (existsSync(file)) continue
    console.error(`找不到报告：${file}`)
    console.error('先跑一次 `npm run eval` 生成回答，或用 --from=<路径> 指定另一份。')
    process.exit(1)
  }

  console.log('复判模式：只重判、不重答（不跑模型、不执行动作、不碰沙箱）')
  if (repeat > 1) console.log(`重复判决：每份报告每条 LLM 判的用例判 ${repeat} 遍，用来看裁判自己抖不抖`)
  console.log()

  const allCases = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Case[]
  const cases = allCases.filter((c) => {
    if (onlyCat && c.cat !== onlyCat) return false
    if (onlyId && c.id !== onlyId) return false
    return true
  })

  const loaded = loadScriptConfig()
  const baseConfig = loaded.config
  if (loaded.missing.length > 0 && !baseConfig.judge) console.log(`${describeMissing(loaded)}`)
  // 判分模型与干活模型必须不是同一个，否则分数是自己给自己打的
  const judgeModel = judgeModelOf(baseConfig)
  const judgeLabel = judgeModel ? `${judgeModel.model} @ ${judgeModel.baseUrl}` : null
  if (judgeModel) {
    console.log(`判分模型：${judgeLabel}`)
  } else {
    console.log('判分模型：未配置（设置 → 判分模型）——H3/H2 会回落到正则，报告里会标出来')
    if (repeat > 1) console.log('  重复判已自动关掉：没有 LLM 裁判时，每轮结论必然相同')
  }
  console.log(`用例：${cases.length} 条${onlyCat ? `（仅 ${onlyCat}）` : ''}　来源：${fromList.length} 份报告\n`)

  const runs: ReportRun[] = []
  for (const from of fromList) {
    let loadedReport: { set: AnswerSet; raw: Record<string, unknown> }
    try {
      loadedReport = readAnswerSet(from, allCases)
    } catch (err) {
      if (err instanceof RepeatArgError || err instanceof AnswerSetError) {
        console.error(`这份报告没法复判：${err.message}`)
        if (err instanceof AnswerSetError) {
          console.error('复判要求报告里存着回答原文、工具名、来源条数、授权记录四项。')
        }
        process.exit(1)
      }
      throw err
    }
    const { set, raw } = loadedReport
    const byId = new Map(set.answers.map((a) => [a.id, a]))
    const pairs = cases.flatMap((c) => {
      const answer = byId.get(c.id)
      return answer ? [{ testCase: c, answer }] : []
    })

    const srcAt = typeof raw.at === 'string' ? raw.at : null
    const srcModel = typeof raw.model === 'string' ? raw.model : '(未记录)'
    const srcJudge = typeof raw.judgeModel === 'string' ? raw.judgeModel : null
    const fingerprint = answerFingerprint(set.answers)
    console.log(`──────── 回答来源：${path.relative(ROOT, from) || from}`)
    console.log(`  生成于：${srcAt ? new Date(srcAt).toLocaleString('zh-CN') : '(未记录)'}　干活模型：${srcModel}`)
    console.log(`  原判分模型：${srcJudge ?? '(未记录)'}　答案集指纹：${fingerprint}`)
    if (srcJudge && judgeLabel && srcJudge !== judgeLabel) {
      console.log('  ⚠ 与原报告的判分模型不同——两份分数的差异里混着"换了裁判"这一项')
    }
    if (set.missing.length > 0) {
      console.log(`  ⚠ 用例集里有 ${set.missing.length} 条不在这份报告里，本次跳过：${set.missing.join(', ')}`)
    }
    if (set.unknown.length > 0) {
      console.log(`  ⚠ 报告里有 ${set.unknown.length} 条用例集已经没有（用例改过？），本次跳过：${set.unknown.join(', ')}`)
    }

    if (pairs.length === 0) {
      console.error('  没有一条用例能在这份报告里找到回答，跳过。')
      continue
    }

    const results: RejudgeResult[] = []
    for (const { testCase, answer } of pairs) {
      const rounds: RoundRecord[] = []
      const times = shouldRepeat(testCase.cat, Boolean(judgeModel)) ? repeat : 1
      const started = Date.now()
      let first: ScoreVerdict | null = null
      for (let round = 0; round < times; round++) {
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
        if (!first) first = verdict
        rounds.push({
          pass: verdict.pass,
          reason: verdict.reason,
          judgedBy: verdict.judgedBy,
          ...(verdict.judgeTally ? { judgeTally: verdict.judgeTally } : {})
        })
      }
      const elapsed = Date.now() - started
      // 结论取**第一轮**：重复判只用来量抖动。按多数取或按任意一轮取，都是在悄悄改口径，
      // 而"改了口径"和"改了结论"在报告里长得一样。
      const lead = first as ScoreVerdict
      const stability = stabilityOf(rounds)
      results.push({
        id: testCase.id,
        cat: testCase.cat,
        prompt: testCase.prompt,
        pass: lead.pass,
        reason: lead.reason,
        judgedBy: lead.judgedBy,
        text: answer.text,
        toolNames: answer.toolNames,
        evidence: answer.evidenceCount,
        records: answer.records,
        prevPass: answer.prevPass,
        prevReason: answer.prevReason,
        judgeModel: judgeModel ? judgeModel.model : null,
        ...(lead.judgeFlags ? { judgeFlags: lead.judgeFlags } : {}),
        ...(lead.judgeVotes ? { judgeVotes: lead.judgeVotes } : {}),
        ...(lead.judgeTally ? { judgeTally: lead.judgeTally } : {}),
        ...(rounds.length > 1 ? { rounds } : {})
      })
      const flip = lead.pass === answer.prevPass ? '   ' : answer.prevPass ? '翻↓' : '翻↑'
      const roundText = rounds.length > 1 ? `${stability.passRounds}/${stability.rounds}轮${stability.stable ? ' ' : '⚠'}` : ''
      console.log(
        `${flip} ${lead.pass ? 'PASS' : 'FAIL'}  ${testCase.id.padEnd(6)} ${roundText.padStart(5)} ${(elapsed / 1000)
          .toFixed(1)
          .padStart(5)}s  ${lead.reason}`
      )
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
    const flipped = results
      .filter((r) => r.pass !== r.prevPass)
      .map((r) => ({ id: r.id, from: r.prevPass, to: r.pass }))
    const unstable = unstableIds(results)

    console.log('\n  ======== 记分板（复判） ========')
    for (const [cat, slot] of [...byCat.entries()].sort()) {
      const prev = results.filter((r) => r.cat === cat && r.prevPass).length
      console.log(`  ${cat.padEnd(3)} ${slot.pass}/${slot.total}  ${((slot.pass / slot.total) * 100).toFixed(0)}%（原 ${prev}/${slot.total}）`)
    }
    const pct = (n: number): string => ((n / results.length) * 100).toFixed(1)
    console.log(`  合计 ${totalPass}/${results.length}  ${pct(totalPass)}%（原 ${prevPass}/${results.length}  ${pct(prevPass)}%）`)

    console.log('\n  ======== 与原报告逐条比 ========')
    if (flipped.length === 0) {
      console.log(`  没有一条翻转：${results.length} 条判分结论与原报告一致。`)
    } else {
      console.log(`  ${flipped.length} 条翻转（回答没变，变的只有裁判/判据）：`)
      for (const f of flipped) {
        const r = results.find((x) => x.id === f.id)
        console.log(`    ${f.id}  ${f.from ? 'PASS → FAIL' : 'FAIL → PASS'}  ${(r?.reason ?? '').slice(0, 70)}`)
      }
    }

    // 重复判的意义全在这一段：同一条回答、同一个裁判、判 N 遍结论不一样，
    // 说明这条用例落在判据的边界上——那不是模型的问题，是判据的问题
    if (repeat > 1) {
      const repeated = results.filter((r) => r.rounds)
      const llmRepeated = repeated.filter((r) => stabilityOf(r.rounds ?? []).llmRounds > 0)
      console.log(`\n  ======== 裁判抖动（同一条回答判 ${repeat} 遍） ========`)
      if (llmRepeated.length === 0) {
        console.log('  没有一条走 LLM 裁判，重复判没有可量的东西。')
      } else if (unstable.length === 0) {
        console.log(`  ${llmRepeated.length} 条 LLM 判的用例，每一条 ${repeat} 轮结论全部一致。`)
      } else {
        console.log(`  ${unstable.length}/${llmRepeated.length} 条不稳定——这几条落在判据边界上：`)
        for (const id of unstable) {
          const r = results.find((x) => x.id === id)
          const s = stabilityOf(r?.rounds ?? [])
          const tallies = (r?.rounds ?? []).map((x) => x.judgeTally ?? (x.pass ? 'pass' : 'fail')).join(' / ')
          console.log(`    ${id}  ${s.passRounds}/${s.rounds} 轮通过　票型 ${tallies}`)
        }
      }
      const notRepeated = results.filter((r) => !r.rounds).length
      if (notRepeated > 0) {
        console.log(`  另有 ${notRepeated} 条是正则/行为断言，确定性判据不重复——重复出来的"稳定"是假证据。`)
      }
    }

    runs.push({
      source: { path: path.relative(ROOT, from) || from, at: srcAt, model: srcModel, judgeModel: srcJudge, fingerprint, missing: set.missing, unknown: set.unknown },
      results,
      totalPass,
      total: results.length,
      prevTotalPass: prevPass,
      flipped,
      unstable
    })
    console.log()
  }

  if (runs.length === 0) {
    console.error('没有任何一份报告复判成功，什么都不写。')
    process.exit(1)
  }

  // 多份报告时对成一张表：哪条用例在哪一份里结论不同，就是 H3 那种"会翻"的现形处
  const comparison = runs.length > 1 ? buildComparison(runs.map((r) => ({ label: r.source.path, results: r.results }))) : []
  if (runs.length > 1) {
    console.log('================ 多份报告对表 ================')
    const differs = comparison.filter((row) => row.differs)
    for (const row of comparison) {
      const cells = row.cells
        .map((c) => (c.pass === null ? '—' : `${c.pass ? 'PASS' : 'FAIL'}${c.tally ? `(${c.tally})` : ''}`))
        .join('  ')
      console.log(`${row.differs ? '≠' : ' '} ${row.id.padEnd(6)} ${row.cat.padEnd(3)} ${cells}`)
    }
    console.log(
      differs.length === 0
        ? `\n没有一条在不同报告之间结论不同：${comparison.length} 条用例逐条一致。`
        : `\n${differs.length} 条在不同报告之间结论不同：${differs.map((d) => `${d.id}(${d.cat})`).join(', ')}`
    )
    const fps = runs.map((r) => r.source.fingerprint)
    const sameAnswers = new Set(fps).size === 1
    console.log(
      sameAnswers
        ? `答案集指纹一致（${fps[0]}）：这批报告判的是同一批回答，差异只可能来自裁判/判据。`
        : `答案集指纹不同（${fps.join(' / ')}）：回答本身就换了，分差**不能**只算到判分头上。`
    )
    console.log()
  }

  const allResults = runs.flatMap((r) => r.results)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(
    out,
    JSON.stringify(
      {
        // 报告自己要说清是哪一种模式产的：把复判分当成全跑分读，是最容易犯的错
        mode: 'rejudge',
        at: new Date().toISOString(),
        judgeModel: judgeLabel,
        repeat,
        judgedByLLM: allResults.filter((r) => r.judgedBy === 'llm').length,
        judgedByRegex: allResults.filter((r) => r.judgedBy === 'regex' || r.judgedBy === 'regex-fallback').length,
        reports: runs,
        ...(comparison.length > 0 ? { comparison } : {})
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`明细已写入 ${out}`)
}

void main()
