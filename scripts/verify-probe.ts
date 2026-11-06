import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyApp } from '../src/main/verify'
import { listInstalledApps } from '../src/main/node/registry'
import { DEFAULT_CONFIG } from '../src/main/node/store'
import type { ButlerConfig } from '../src/shared/types'

/**
 * A4 命中率探针：已装程序 → 官网 → 一句话说明。
 *
 * 用法（Key 从应用「设置」里读，同 eval）：
 *   npm run verify-probe                  # 前 8 个有发布者的程序
 *   npm run verify-probe -- --n=15        # 样本数
 *   npm run verify-probe -- --provider=serper
 *   npm run verify-probe -- --names=微信,Git,Node.js
 *
 * 判定口径：命中 = 找到一个**官方页面**，且模型能从正文里抄出一句话说明。
 * 命中分两条路径，报告里分开计：注册表登记的产品网址直连 vs 检索出来再抓。
 */
const CONFIG_PATH = path.join(process.env.APPDATA ?? os.homedir(), 'butler-demo', 'config.json')

function loadConfig(): ButlerConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<ButlerConfig>) }
    } catch {
      /* 落到默认值 */
    }
  }
  return { ...DEFAULT_CONFIG }
}

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

async function main(): Promise<void> {
  const base = loadConfig()
  const providerArg = arg('provider')
  const config: ButlerConfig = {
    ...base,
    searchProvider: (providerArg as ButlerConfig['searchProvider']) ?? base.searchProvider
  }
  const limit = Math.max(1, Number(arg('n') ?? 8))
  const namesArg = arg('names')

  console.log(`模型：${config.model} @ ${config.baseUrl}`)
  console.log(`检索：${config.searchProvider}${config.searchKey ? '（已配置 Key）' : '（无 Key，走免费源）'}`)

  const { apps } = await listInstalledApps(true)
  const pool = apps.filter((a) => a.systemComponent !== 1 && a.publisher)
  const picked = namesArg
    ? namesArg
        .split(',')
        .map((n) => pool.find((a) => a.name === n.trim()))
        .filter((a): a is (typeof pool)[number] => Boolean(a))
    : pool.slice(0, limit)

  if (picked.length === 0) {
    console.log('没有可测的样本（需要非系统组件且有发布者）')
    return
  }
  const withHint = picked.filter((a) => a.urlInfoAbout)
  console.log(`样本 ${picked.length} 个，其中 ${withHint.length} 个注册表登记了产品网址\n`)

  let verified = 0
  let viaRegistry = 0
  let viaGuess = 0
  let viaSearch = 0
  let totalMs = 0
  const misses: string[] = []

  const debug = process.argv.slice(2).includes('--debug')

  for (const app of picked) {
    const started = Date.now()
    const result = await verifyApp(app.name, app.publisher, config, {
      officialUrl: app.urlInfoAbout,
      onAttempt: debug
        ? (info) => console.log(`   · ${info.ok ? 'OK ' : 'NG '}${info.via} ${info.url} ${info.detail ?? ''}`)
        : undefined
    })
    const cost = Date.now() - started
    totalMs += cost
    if (result.status === 'verified') {
      verified += 1
      if (result.via === 'registry') viaRegistry += 1
      else if (result.via === 'guess') viaGuess += 1
      else viaSearch += 1
      const viaLabel = result.via === 'registry' ? '注册表直连' : result.via === 'guess' ? '模型提议+核对' : '检索'
      console.log(`[命中·${viaLabel}] ${app.name}（${(cost / 1000).toFixed(1)}s）`)
      console.log(`   说明：${result.sentence}`)
      console.log(`   来源：${result.sourceUrl}`)
      console.log(`   依据：${result.evidenceText}`)
    } else {
      misses.push(`${app.name}：${result.reason ?? '未知原因'}`)
      console.log(`[未命中] ${app.name}（${(cost / 1000).toFixed(1)}s）`)
      console.log(`   原因：${result.reason ?? '未知原因'}`)
    }
  }

  const rate = (verified / picked.length) * 100
  console.log('\n================ 结果 ================')
  console.log(
    `命中 ${verified}/${picked.length} = ${rate.toFixed(0)}%（注册表直连 ${viaRegistry} / 模型提议 ${viaGuess} / 检索 ${viaSearch}）`
  )
  console.log(`平均 ${(totalMs / picked.length / 1000).toFixed(1)} s`)
  if (misses.length > 0) {
    console.log('\n未命中明细：')
    for (const line of misses) console.log(`  - ${line}`)
  }
  console.log(`\n判定阈值：≥60% 才可以开 P1 台账（当前 ${rate.toFixed(0)}%）`)
}

void main()
