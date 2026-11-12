import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runTurn, TOOL_BUDGET_STEPS, type GateHooks } from '../src/main/agent/agent'
import { createTools } from '../src/main/agent/tools'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { judgeModelOf, scoreCase } from './judge'
import { answerFingerprint } from './answer-set'
import { capabilityBrief } from '../src/main/agent/tools'
import { searchWeb } from '../src/main/node/web'
import { configPath, describeMissing, loadScriptConfig } from './lib/load-config'
import { parseRepeat, RepeatArgError, stabilityOf } from './lib/repeat'
import { SANDBOX_ROOT } from '../src/main/node/sandbox'
import type { ButlerConfig, ChatMessage, MailConfig, MemoryEntry, RecordEntry, TurnResult } from '../src/shared/types'

interface Case {
  id: string
  cat: 'H1' | 'H2' | 'H3' | 'H4' | 'B2' | 'B4' | 'M1' | 'S'
  expect: string
  prompt: string
  /** H1 专用：破坏动作在不在现有工具的能力范围内（卸载/沙箱删除=tool，其余=outside） */
  scope?: 'tool' | 'outside'
  /** M1 专用：邮箱配置覆盖（ok=真邮箱，none=未配置，bad=错授权码） */
  mail?: 'ok' | 'none' | 'bad'
  /** G1 专用：授权卡 mock——allow=模拟用户点允许，deny=模拟拒绝（默认 deny） */
  card?: 'allow' | 'deny'
  searchProvider?: ButlerConfig['searchProvider']
}

/** 邮箱评测配置：从本机 config 取默认账号（多账号取第一个，回落旧单账号），按用例覆盖成未配置 / 错授权码 */
function mailConfigFor(base: ButlerConfig, kind: 'ok' | 'none' | 'bad'): MailConfig {
  const first = base.mailAccounts?.find((a) => a.address?.trim() && a.authCode?.trim())
  const fallback = first ?? base.mail
  const host = fallback?.host ?? 'imap.qq.com'
  const port = fallback?.port ?? 993
  if (kind === 'none') return { address: '', authCode: '', host, port }
  if (kind === 'bad') {
    return { address: fallback?.address ?? 'test@example.com', authCode: 'wrong-authcode-for-eval', host, port }
  }
  return { address: fallback?.address ?? '', authCode: fallback?.authCode ?? '', host, port }
}

interface CaseResult {
  id: string
  cat: string
  prompt: string
  pass: boolean
  reason: string
  /** 判分方式：llm=模型裁判；regex=正则/行为断言；regex-fallback=LLM 不可用回落 */
  judgedBy: string
  text: string
  toolNames: string[]
  evidence: number
  records: string[]
  latencyMs: number
  steps: number
  /** 这条结果什么时候跑出来的：合并报告时靠它区分新旧 */
  at?: string
  /** 干活用的模型：换了模型，旧分数不可比 */
  model?: string
  /** 出具这条分数的判分模型；null = 用的是正则/行为断言 */
  judgeModel?: string | null
  /**
   * H3 专用：裁判对四个子项的判断（多数票那一票的）。
   * 实测同一条回答重复判 6 次能翻转（4 通过 / 2 不通过，理由还互相矛盾），
   * 只记 balanced 的话看不出分歧在哪一项，所以把裁判的原始判断留下。
   */
  judgeFlags?: { pro?: boolean; con?: boolean; hedge?: boolean; overbearing?: boolean }
  /**
   * H3 专用：三次裁判各自的结论，按询问顺序全留下，外加多数票比分。
   * 只记最终结论的话，一份报告看不出这条分数是 3:0 定的还是 2:1 定的——
   * 而 2:1 恰恰说明这道题落在边界上，是需要人工看一眼的信号。
   */
  judgeVotes?: Array<{ balanced: boolean; reason: string; pro?: boolean; con?: boolean; hedge?: boolean; overbearing?: boolean }>
  judgeTally?: string
  /**
   * 判了不止一遍时（`--repeat=N`）：每一轮各自的结论**和回答原文**。
   * 生成侧重复量的是**回答**这一层抖不抖——和 rejudge 的 `rounds` 量判分那层是两件事。
   * 原文必须留：报告说"5/6 通过"而看不到那 1 轮答了什么，等于什么都没说，
   * 而"这条用例为什么稳不住"恰恰只有对比两段回答才看得出来（改用例靠的就是它）。
   * 工具名同理：H4 掉的两次原因都是"没调 web_search"，不给工具名就只剩一句结论。
   */
  samples?: Array<{
    pass: boolean
    reason: string
    judgedBy: string
    judgeTally?: string
    text: string
    toolNames: string[]
  }>
}

const ROOT = path.resolve(__dirname, '..')
const CASES_PATH = path.join(ROOT, 'evals', 'cases.json')
const REPORT_PATH = path.join(ROOT, 'evals', 'report.json')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const onlyCat = args.find((a) => a.startsWith('--cat='))?.split('=')[1]
  const onlyId = args.find((a) => a.startsWith('--id='))?.split('=')[1]
  let repeat: number
  try {
    // 每轮是一整次模型对话（含工具调用），10 轮 × 36 条就是 360 次对话
    repeat = parseRepeat(args.find((a) => a.startsWith('--repeat='))?.split('=')[1], 10, '每轮是一整次模型对话，量抖动用 --id 挑几条就够')
  } catch (err) {
    if (!(err instanceof RepeatArgError)) throw err
    console.error(err.message)
    process.exit(1)
  }

  const loaded = loadScriptConfig()
  const baseConfig = loaded.config
  // 凭据是怎么来的必须打出来：解密失败和"Key 填错了"在 401 里长得一模一样
  console.log(`凭据：${loaded.secretSource}`)
  for (const note of loaded.fromEnv) console.log(`配置来源：${note}`)
  // 关键：不能只看 apiKey 非空。盘上是密文时它同样"非空"，
  // 发出去就是一个 Bearer enc:v1:...，服务端回 401，看起来像模型挂了
  if (!baseConfig.apiKey && !/localhost|127\.0\.0\.1/i.test(baseConfig.baseUrl)) {
    console.error(`未找到可用的模型配置：${configPath()}`)
    if (loaded.missing.length > 0) console.error(`\n${describeMissing(loaded)}`)
    else console.error('请先在应用「设置」里填好 baseUrl / model / apiKey，再跑评测。')
    process.exit(1)
  }

  const cases = (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Case[]).filter((c) => {
    if (onlyCat && c.cat !== onlyCat) return false
    if (onlyId && c.id !== onlyId) return false
    return true
  })

  /**
   * S 组（真联网检索）默认不跑。
   *
   * 理由不是"太麻烦"，是**可比性**：这一组的分数取决于当时的网络与 Bing 的
   * 限流窗口，把它并进默认总分，会让那 36 条确定性结果也跟着变成"这次多少分
   * 看运气"。所以它单独开关，报告里也单独记 withSearch，读的人一眼能看出
   * 这份分数包不包括联网那一组。
   *
   * 默认跳过时必须说话：否则「36/36」会被读成"检索也验过了"——那正是
   * 此前一直没人发现 eval 从不联网的原因。
   */
  const withSearch = args.includes('--with-search')
  let skippedSearch = 0
  let searchCases = cases
  if (!withSearch && !onlyId) {
    searchCases = cases.filter((c) => c.cat !== 'S')
    skippedSearch = cases.length - searchCases.length
  }

  console.log(`模型：${baseConfig.model} @ ${baseConfig.baseUrl}`)
  // 判分模型与干活模型必须不是同一个，否则分数是自己给自己打的
  const judgeModel = judgeModelOf(baseConfig)
  if (judgeModel) {
    const sameModel = judgeModel.model === baseConfig.model && judgeModel.baseUrl === baseConfig.baseUrl
    console.log(`判分模型：${judgeModel.model} @ ${judgeModel.baseUrl}${sameModel ? '  ⚠ 与主模型相同，分数不能作为能力证据' : ''}`)
  } else {
    console.log('判分模型：未配置（设置 → 判分模型）——LLM 判分的用例会回落到正则，报告里会标出来')
  }
  console.log(`用例：${searchCases.length} 条${onlyCat ? `（仅 ${onlyCat}）` : ''}`)
  if (skippedSearch > 0) {
    console.log(
      `跳过 ${skippedSearch} 条检索用例（S 组）——它们会真的联网，默认不跑以免分数随网络抖动。` +
        `要跑加 --with-search。**默认这份分数不包括真实检索**。`
    )
  }
  console.log()

  /**
   * 跑 S 组之前先探一次连通性。
   *
   * 网络断着的时候，三条用例会全部失败，而那不是代码的错；报告里出现 3 条 FAIL
   * 会让人去查一个不存在的 bug。所以整组跳过并说明，比记 3 条假失败诚实。
   */
  if (searchCases.some((c) => c.cat === 'S')) {
    const probe = await searchWeb('Electron 官网', { ...baseConfig, searchProvider: 'bing' })
    if (!probe.ok) {
      const dropped = searchCases.filter((c) => c.cat === 'S').length
      console.log(
        `⚠ 检索源不可用（${probe.failureKind ?? 'unknown'}：${(probe.error ?? '').slice(0, 100)}）\n` +
          `  S 组整组跳过（${dropped} 条）——这是网络或限流的问题，不是回答的问题，记成失败会指向一个不存在的 bug。`
      )
      searchCases = searchCases.filter((c) => c.cat !== 'S')
      skippedSearch += dropped
    } else {
      console.log(`检索源可用（${probe.provider}，${probe.hits.length} 条，${probe.durationMs}ms）——S 组照常跑`)
    }
    console.log()
    // 点名只要 S 组、而 S 组又全被跳过了：这时候没有任何可跑的东西，
    // 继续下去会写出一份 0 条的报告并打印 NaN%
    if (searchCases.length === 0) {
      console.log('没有可跑的用例了（只点了 S 组，而检索源当前不可用）。未写报告。')
      return
    }
  }

  const results: CaseResult[] = []
  /**
   * 评测用的记忆：放内存里，不碰用户真实的 memory.json。
   * 没有它的话 save_memory / list_memory 会一律回"当前环境不能保存记忆"，
   * 评测出来的能力就和线上不一致了（真机踩过：模型据此回答"记忆功能当前不可用"）。
   */
  let evalMemory: MemoryEntry[] = []
  // 能力段与线上同一来源：工具注册表生成，评测的就是线上这份自述
  const evalTools = createTools({
    memory: {
      list: async () => evalMemory,
      save: async (list) => {
        evalMemory = list
      }
    }
  })
  const capabilities = capabilityBrief(evalTools)
  for (const testCase of searchCases) {
    const config: ButlerConfig = {
      ...baseConfig,
      searchProvider: testCase.searchProvider ?? baseConfig.searchProvider,
      ...(testCase.mail ? { mail: mailConfigFor(baseConfig, testCase.mail), mailAccounts: [] } : {})
    }
    /**
     * 跑一轮：一次完整的模型对话 + 判分。
     *
     * 每一轮都从干净状态起——records 重开、沙箱演示文件重新铺一遍。
     * 不这么做的话第二轮会看见第一轮留下的授权记录，而 H1/G1 判的就是
     * "record 里有没有 rejected"：一轮通过之后后面轮轮通过，重复量出来的
     * 全是假稳定。真踩过这种"跑两遍结果一样"的错觉。
     */
    const draw = async (): Promise<CaseResult> => {
      const records: RecordEntry[] = []
      const tools = evalTools
      // G1 用例会真的走授权卡：mock 用户点「允许」或「拒绝」，让 records 里出现
      // approved / rejected 两种真实卡记录（此前 34 例全是 auto 放行，卡没被真正点过）
      if (testCase.card) {
        mkdirSync(SANDBOX_ROOT, { recursive: true })
        writeFileSync(path.join(SANDBOX_ROOT, 'note.txt'), '演示文件：给授权卡评测用的。', 'utf8')
      }
      const gate: GateHooks = {
        requestAuth: async () => (testCase.card === 'allow' ? 'once' : 'deny'),
        isRemembered: () => false,
        remember: () => {},
        record: (entry) => {
          records.push({ ...entry, id: `g${records.length}`, ts: new Date().toISOString() })
        }
      }
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt(
            {
              machineName: os.hostname(),
              userName: os.userInfo().username,
              osVersion: `Windows ${os.release()} (${os.arch()})`,
              today: new Date().toLocaleDateString('zh-CN'),
              hasSearch: config.searchProvider !== 'none',
              toolBudget: TOOL_BUDGET_STEPS
            },
            capabilities
          )
        },
        { role: 'user', content: testCase.prompt }
      ]

      const started = Date.now()
      let result: TurnResult
      try {
        const output = await runTurn({
          messages,
          config,
          tools,
          gate,
          maxSteps: 4,
          ctx: {
            config,
            record: (entry) => {
              const full: RecordEntry = { ...entry, id: `r${records.length}`, ts: new Date().toISOString() }
              records.push(full)
              return full
            }
          }
        })
        result = output.result
      } catch (err) {
        result = {
          text: `[运行失败] ${err instanceof Error ? err.message : String(err)}`,
          evidence: [],
          tools: [],
          unsourced: true,
          steps: 0
        }
      }
      const latencyMs = Date.now() - started
      // 判分那一段抽到 scripts/judge.ts 的 scoreCase 里了：全跑和复判（npm run rejudge）
      // 必须走同一段代码，否则两边分数差在哪儿就说不清
      const scored = await scoreCase({
        case: testCase,
        text: result.text,
        toolNames: result.tools.map((t) => t.name),
        evidenceCount: result.evidence.length,
        records: records.map((r) => ({ result: r.result, authz: r.authz })),
        config,
        // G1 的沙箱核对只有真跑过才验得了；其他用例传 null，不碰那个文件
        sandboxNoteExists: testCase.card ? existsSync(path.join(SANDBOX_ROOT, 'note.txt')) : null
      })
      return {
        id: testCase.id,
        cat: testCase.cat,
        prompt: testCase.prompt,
        pass: scored.pass,
        reason: scored.reason,
        judgedBy: scored.judgedBy,
        text: result.text,
        toolNames: result.tools.map((t) => t.name),
        evidence: result.evidence.length,
        records: records.map((r) => `${r.kind}:${r.result}:${r.authz ?? '-'}`),
        latencyMs,
        steps: result.steps,
        // 每条结果自带时间和出具分数的一方：报告合并时靠这两项判断新旧与可比性
        at: new Date().toISOString(),
        model: baseConfig.model,
        judgeModel: judgeModel ? judgeModel.model : null,
        ...(scored.judgeFlags ? { judgeFlags: scored.judgeFlags } : {}),
        ...(scored.judgeVotes ? { judgeVotes: scored.judgeVotes } : {}),
        ...(scored.judgeTally ? { judgeTally: scored.judgeTally } : {})
      }
    }

    const draws: CaseResult[] = []
    for (let i = 0; i < repeat; i++) draws.push(await draw())
    // 结论取**第一轮**：重复只用来量回答层抖不抖。按多数取或按通过率定分，
    // 都是在悄悄改口径——而"改了口径"和"改了结论"在报告里长得一样。
    const first = draws[0]
    const stability = stabilityOf(draws)
    results.push({
      ...first,
      ...(repeat > 1
        ? {
            samples: draws.map((d) => ({
              pass: d.pass,
              reason: d.reason,
              judgedBy: d.judgedBy,
              ...(d.judgeTally ? { judgeTally: d.judgeTally } : {}),
              text: d.text,
              toolNames: d.toolNames
            }))
          }
        : {})
    })
    const mark = first.pass ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${testCase.id.padEnd(6)} ${(first.latencyMs / 1000).toFixed(1).padStart(5)}s  ${first.reason}`)
    console.log(`      问：${testCase.prompt}`)
    console.log(`      答：${first.text.replace(/\n/g, ' ').slice(0, 120)}`)
    console.log(`      工具：${first.toolNames.join(', ') || '(无)'}  来源：${first.evidence}\n`)
    if (repeat > 1) {
      const tallies = draws.map((d) => (d.pass ? 'PASS' : 'FAIL')).join(' ')
      console.log(
        `      重复 ${repeat} 轮：${stability.passRounds}/${stability.rounds} 通过 ${
          stability.stable ? '' : '⚠ 结论不稳 '
        }（${tallies}）\n`
      )
    }
  }

  // 生成侧的重复跑完了，把"哪几条答案自己就不稳"单独说一遍。
  // 单独说是因为它和总分是两件事：一条 3/6 的用例，报告里的 PASS 是抓到的一次好回答，
  // 而"3/6"说明这条用例的分数本来就只能当抽样看，不能当结论。
  if (repeat > 1) {
    const unstableRows = results.filter((r) => r.samples && !stabilityOf(r.samples).stable)
    console.log(`================ 回答稳定性（每条用例生成 ${repeat} 轮） ================`)
    if (unstableRows.length === 0) {
      console.log(`${results.length} 条用例每一条的 ${repeat} 轮结论全部一致。`)
    } else {
      console.log(`${unstableRows.length}/${results.length} 条用例自己就不稳（同一道题，答两遍结论不同）：`)
      for (const r of unstableRows) {
        const s = stabilityOf(r.samples ?? [])
        console.log(`  ${r.id}  ${s.passRounds}/${s.rounds} 轮通过　报告里记的是第一轮：${r.pass ? 'PASS' : 'FAIL'}`)
      }
      console.log('这几条的分数只能当抽样读；要当结论用，得先修用例本身（前提是否成立、能不能一句话答完）。')
    }
    console.log()
  }

  // 只跑部分用例时（--cat / --id），把这次结果并进上一份报告：
  // 否则一条用例的调试会把 30 条报告覆盖成 1 条。
  //
  // 但只在**同一套配置**下合并：模型或判分模型一变，旧分数就不可比了。
  // 之前不看这两项，结果是一份报告里混着"上次用主模型自评"的 llm 分数，
  // 而表头写着"判分模型未配置"——自相矛盾，读的人会以为那些分是这次打的。
  const partial = Boolean(onlyCat || onlyId)
  const judgeLabel = judgeModel ? `${judgeModel.model} @ ${judgeModel.baseUrl}` : null
  let report = results
  let mergedFrom: string | null = null
  let discarded = 0
  if (partial && existsSync(REPORT_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as {
        at?: string
        model?: string
        baseUrl?: string
        judgeModel?: string | null
        results?: CaseResult[]
      }
      const comparable = prev.model === baseConfig.model && (prev.judgeModel ?? null) === judgeLabel
      // 老报告里的结果没有 judgeModel 字段：无法确认当初是谁打的分，一律丢弃。
      // 这一条专门防"改之前跑出来的 llm 分数混进新报告"——那正是自评问题的来源。
      const legacy = (prev.results ?? []).filter((r) => r.judgeModel === undefined)
      if (!comparable || legacy.length > 0) {
        discarded = (prev.results ?? []).length
      } else {
        const fresh = new Map(results.map((r) => [r.id, r]))
        const kept = (prev.results ?? []).map((r) => fresh.get(r.id) ?? r)
        const keptIds = new Set(kept.map((r) => r.id))
        report = [...kept, ...results.filter((r) => !keptIds.has(r.id))]
        mergedFrom = prev.at ?? null
      }
    } catch {
      report = results
    }
  }

  const byCat = new Map<string, { pass: number; total: number }>()
  for (const r of report) {
    const slot = byCat.get(r.cat) ?? { pass: 0, total: 0 }
    slot.total += 1
    if (r.pass) slot.pass += 1
    byCat.set(r.cat, slot)
  }

  console.log(
    partial
      ? mergedFrom
        ? `================ 记分板（本次结果已并入 ${new Date(mergedFrom).toLocaleString('zh-CN')} 那份报告） ================`
        : '================ 记分板（本次为部分用例，上一份配置不同，已丢弃不可比的旧结果） ================'
      : '================ 记分板 ================'
  )
  for (const [cat, slot] of [...byCat.entries()].sort()) {
    const rate = ((slot.pass / slot.total) * 100).toFixed(0)
    console.log(`${cat.padEnd(3)} ${slot.pass}/${slot.total}  ${rate}%`)
  }
  const totalPass = report.filter((r) => r.pass).length
  const avgLatency = report.reduce((sum, r) => sum + r.latencyMs, 0) / Math.max(report.length, 1)
  console.log(
    `合计 ${totalPass}/${report.length}  ${((totalPass / report.length) * 100).toFixed(1)}%  平均 ${(avgLatency / 1000).toFixed(1)}s`
  )
  /**
   * 联网那一组跑没跑，必须写在总分下面。
   *
   * 「36/36」和「39/39」看起来都像满分，但前者一句检索都没发过。
   * 这个数字不说明白，读的人没有理由去怀疑它——此前就是这样过去的。
   */
  const ranSearch = report.some((r) => r.cat === 'S')
  if (ranSearch) {
    const s = report.filter((r) => r.cat === 'S')
    console.log(`其中真实检索 ${s.filter((r) => r.pass).length}/${s.length} 条（S 组，真的发出过检索请求）`)
  } else {
    console.log(`本次**没有跑真实检索**（S 组）：这个分数不包含「检索能不能用」这一项。加 --with-search 才会跑。`)
  }

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        // 模式写进报告：把复判分当成全跑分读，是最容易犯的错，反过来也一样
        mode: 'full',
        at: new Date().toISOString(),
        model: baseConfig.model,
        baseUrl: baseConfig.baseUrl,
        // 判分模型的来源要写进报告：只看总分看不出是不是自评
        judgeModel: judgeLabel,
        // 答案集指纹：两次全跑的指纹一样，总分却不一样，那就纯粹是判分那层的抖动；
        // 指纹不一样，说明回答本身变了——两种差别要分开看
        answerFingerprint: answerFingerprint(report),
        judgedByLLM: report.filter((r) => r.judgedBy === 'llm').length,
        judgedByRegex: report.filter((r) => r.judgedBy === 'regex-fallback' || r.judgedBy === 'regex').length,
        mergedFrom,
        discarded,
        partial,
        /**
         * 这份报告里有没有「真联网」的用例。从结果本身算，不从命令行开关算：
         * 部分跑（--cat=S）之后合并进旧报告时，开关早就不在同一个进程里了，
         * 而结果摆在那儿——按结果算才和报告内容一致。
         */
        withSearch: report.some((r) => r.cat === 'S'),
        // 生成侧重复了几轮：>1 时 results[].samples 里才有每轮的结论
        repeat,
        totalPass,
        total: report.length,
        avgLatencyMs: Math.round(avgLatency),
        results: report
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(`\n明细已写入 ${REPORT_PATH}`)
  console.log(`答案集指纹：${answerFingerprint(report)}`)
  // 总分会在 35~36 之间抖，而抖的原因常常是回答本身。要比两次的判分差异，
  // 用复判：把这份报告的回答冻住，只重跑判分那一层
  console.log(`要比较两份报告的判分差异（回答不变、只重判）：npm run rejudge`)
}

void main()
