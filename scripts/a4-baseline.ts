import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyApp } from '../src/main/verify'
import { listInstalledApps } from '../src/main/node/registry'
import { loadScriptConfig } from './lib/load-config'
import type { ButlerConfig } from '../src/shared/types'

/**
 * A4 回归基线：固定一批程序名，每次改动后跑一遍，防止命中率悄悄掉下来。
 *
 * 用法：
 *   npm run a4-baseline              # 跑基线并对比（掉超过容差就退出码 1）
 *   npm run a4-baseline -- --update  # 用本次结果重写基线（会打印差异）
 *   npm run a4-baseline -- --debug   # 打印每次抓取尝试
 *
 * 判定口径：
 *   - hit      命中（找到官方页面且能抄出一句话）
 *   - via      命中来自哪条路：registry / guess / search
 *   - 假阳性   标了 expect:"no" 的样本被判成命中 → 直接算失败（这是诚实性问题，不是指标波动）
 *   - 样本缺失 程序名在这台机器上找不到 → 算失败（说明清单变了，基线要重挑）
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = path.join(ROOT, 'evals', 'a4-baseline.json')
const REPORT_PATH = path.join(ROOT, 'evals', 'a4-report.json')

interface Sample {
  name: string
  expect: 'yes' | 'no'
  note: string
}

interface Baseline {
  at: string
  model: string
  searchProvider: string
  providerNote: string
  tolerance: number
  /** 容差怎么定的、观察到的区间，写给人看 */
  note?: string
  samples: Sample[]
  baseline: { hit: number; total: number; via: Record<string, number> }
}

function loadConfig(): ButlerConfig {
  return loadScriptConfig().config
}

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`)
}

const BUILTIN_SAMPLES: Sample[] = [
  { name: 'Git', expect: 'yes', note: '注册表登记了官网（gitforwindows.org）' },
  { name: 'Obsidian', expect: 'yes', note: '注册表登记了官网（obsidian.md）' },
  { name: 'Microsoft Visual Studio Code (User)', expect: 'yes', note: '注册表登记了官网（code.visualstudio.com）' },
  { name: 'Python 3.12.10 (64-bit)', expect: 'yes', note: '注册表登记了官网，名字带版本号' },
  { name: 'Steam', expect: 'yes', note: '注册表登记了 http 官网' },
  { name: 'Eclipse Temurin JDK with Hotspot 21.0.11+10 (x64)', expect: 'yes', note: '注册表登记的是 /support 子页' },
  { name: 'CodeBuddy CN (User)', expect: 'yes', note: '名字带 (User) 后缀' },
  { name: 'Grok Bot 0.75.3', expect: 'no', note: '注册表 hint 指向 cursor.com，与程序无关 → 必须判否' },
  { name: 'Legion Zone', expect: 'no', note: '注册表 hint 填的是卸载程序路径（脏数据）→ 必须判否' },
  { name: '7-Zip 26.02 (x64)', expect: 'yes', note: '无 hint，靠模型提议' },
  { name: 'Google Chrome', expect: 'yes', note: '无 hint，靠模型提议' },
  { name: 'Microsoft Edge', expect: 'yes', note: '微软系，早期被 block 页骗过' },
  { name: 'Microsoft Office 家庭版 2024 - zh-cn', expect: 'yes', note: '名字带语言与档位后缀，检索查询清洗的考题' },
  { name: 'Microsoft OneDrive', expect: 'yes', note: '微软系产品页' },
  { name: 'Microsoft OneNote - zh-cn', expect: 'yes', note: '微软系产品页' },
  { name: 'Copilot', expect: 'yes', note: '发布者为 Microsoft，名字极短易撞车' },
  { name: 'Folia 0.7.18', expect: 'yes', note: '音乐播放器，官网 foliaapp.cn（曾被误标为"冷门"——假阳性规则逼出了这个错）' },
  { name: 'ICEY', expect: 'no', note: '游戏，官网常是 Steam 页' },
  { name: 'Microsoft Visual C++ 2010  x64 Redistributable - 10.0.40219', expect: 'no', note: '运行时库，曾被 CVE 页冒充命中' },
  { name: 'Microsoft .NET Host - 7.0.20 (x64)', expect: 'yes', note: '运行时组件，但 dotnet.microsoft.com 确实是它的官方页，允许命中' }
]

async function main(): Promise<void> {
  const update = flag('update')
  const debug = flag('debug')

  // 基线文件一旦存在就是样本清单的唯一来源，避免"脚本里改一份、JSON 里改一份"
  const previous: Baseline | null = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline)
    : null
  const samples = previous?.samples ?? BUILTIN_SAMPLES

  const only = arg('only')
    ?.split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const picked = only ? samples.filter((s) => only.includes(s.name)) : samples
  if (only && picked.length === 0) {
    console.log(`--only 里的样本名都不在基线里：${only.join(', ')}`)
    process.exitCode = 1
    return
  }
  const config = loadConfig()
  const providerArg = arg('provider')
  if (providerArg) config.searchProvider = providerArg as ButlerConfig['searchProvider']

  const { apps } = await listInstalledApps(true)
  const installed = new Set(apps.map((a) => a.name))
  const byName = new Map(apps.map((a) => [a.name, a]))

  console.log(`模型：${config.model} @ ${config.baseUrl}`)
  console.log(`检索：${config.searchProvider}${config.searchKey ? '（有 Key）' : '（无 Key）'}`)
  console.log(`样本：${samples.length} 个\n`)

  const results: Array<{
    name: string
    expect: 'yes' | 'no'
    status: 'verified' | 'unverified' | 'missing'
    via?: string
    sentence?: string
    sourceUrl?: string
    reason?: string
    costMs: number
  }> = []

  for (const sample of picked) {
    if (!installed.has(sample.name)) {
      console.log(`[缺失] ${sample.name} —— 这台机器上找不到，基线需要重挑样本`)
      results.push({ name: sample.name, expect: sample.expect, status: 'missing', reason: '程序未安装', costMs: 0 })
      continue
    }
    const app = byName.get(sample.name)!
    const started = Date.now()
    const result = await verifyApp(app.name, app.publisher, config, {
      officialUrl: app.urlInfoAbout,
      onAttempt: debug
        ? (info) => console.log(`   · ${info.ok ? 'OK ' : 'NG '}${info.via} ${info.url} ${info.detail ?? ''}`)
        : undefined
    })
    const costMs = Date.now() - started
    const tag = result.status === 'verified' ? `[命中·${result.via}]` : '[未命中]'
    console.log(`${tag} ${sample.name}（${(costMs / 1000).toFixed(1)}s）`)
    if (result.status === 'verified') {
      console.log(`   ${result.sentence}`)
      console.log(`   ${result.sourceUrl}`)
    } else {
      console.log(`   ${result.reason ?? '未知原因'}`)
    }
    results.push({
      name: sample.name,
      expect: sample.expect,
      status: result.status,
      via: result.via,
      sentence: result.sentence,
      sourceUrl: result.sourceUrl,
      reason: result.reason,
      costMs
    })
  }

  const hit = results.filter((r) => r.status === 'verified').length
  const total = results.length
  const via: Record<string, number> = {}
  for (const r of results) {
    if (r.status === 'verified' && r.via) via[r.via] = (via[r.via] ?? 0) + 1
  }
  const falsePositives = results.filter((r) => r.expect === 'no' && r.status === 'verified')
  const missing = results.filter((r) => r.status === 'missing')
  const expectYesMissed = results.filter((r) => r.expect === 'yes' && r.status !== 'verified')

  console.log('\n================ 基线 ================')
  console.log(`命中 ${hit}/${total} = ${((hit / total) * 100).toFixed(0)}%`)
  console.log(
    `构成：注册表 ${via.registry ?? 0} / 模型提议 ${via.guess ?? 0} / 检索 ${via.search ?? 0}`
  )
  console.log(`平均 ${(results.reduce((s, r) => s + r.costMs, 0) / total / 1000).toFixed(1)} s`)

  if (expectYesMissed.length > 0) {
    console.log(`\n预期命中却掉线（${expectYesMissed.length}）：`)
    for (const r of expectYesMissed) console.log(`  - ${r.name}：${r.reason ?? r.status}`)
  }
  if (falsePositives.length > 0) {
    console.log(`\n❌ 假阳性（${falsePositives.length}）——这些样本本来就不该判成命中：`)
    for (const r of falsePositives) console.log(`  - ${r.name}：${r.sourceUrl ?? ''}`)
  }
  if (missing.length > 0) {
    console.log(`\n⚠ 样本缺失（${missing.length}）：这台机器上没装，基线需要重挑`)
  }

  const tolerance = previous?.tolerance ?? 2

  const record = {
    at: new Date().toISOString(),
    model: config.model,
    baseUrl: config.baseUrl,
    searchProvider: config.searchProvider,
    hasSearchKey: Boolean(config.searchKey),
    partial: Boolean(only),
    hit,
    total,
    rate: Number(((hit / total) * 100).toFixed(1)),
    via,
    tolerance,
    results
  }
  writeFileSync(REPORT_PATH, JSON.stringify(record, null, 2), 'utf8')
  console.log(`\n明细已写入 ${REPORT_PATH}`)

  let failed = false
  if (previous && only) {
    console.log('\n（--only 抽样运行，不做基线对比）')
  } else if (previous) {
    const delta = hit - previous.baseline.hit
    console.log(
      `\n对比基线（${previous.at.slice(0, 10)}）：命中 ${previous.baseline.hit} → ${hit}（${delta >= 0 ? '+' : ''}${delta}），容差 ±${tolerance}`
    )
    if (delta < -tolerance) {
      console.log('❌ 掉出容差，按回归失败处理')
      failed = true
    } else {
      console.log('✅ 在容差内')
    }
  } else {
    console.log('\n（还没有基线文件，本次结果可用 --update 落成基线）')
  }

  if (falsePositives.length > 0) {
    console.log('❌ 存在假阳性，无论命中率多少都算失败')
    failed = true
  }
  if (missing.length > 0) failed = true

  if (update) {
    const next: Baseline = {
      at: record.at,
      model: config.model,
      searchProvider: config.searchProvider,
      providerNote: config.searchKey ? '带 Key' : '无检索 Key，走免费源兜底',
      tolerance,
      samples,
      baseline: { hit, total, via }
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2), 'utf8')
    console.log(`\n已更新基线 ${BASELINE_PATH}（${hit}/${total}）`)
    for (const r of results) {
      const old = previous?.samples.find((s) => s.name === r.name)
      if (previous && old && old.expect !== r.expect) console.log(`  · ${r.name}：expect ${old.expect} → ${r.expect}`)
    }
  }

  if (failed) process.exitCode = 1
}

void main()
