/**
 * 四个工作体后端逐个实测。
 *
 * 用法：npx tsx scripts/backends-check.ts [pi|codex|codebuddy|claude|all]
 *
 * 只做一件事：给一句最短的提示词，看它能不能把话交回来、调了哪些工具、花了多少。
 * 不派真任务——那会把验证和额度混在一起。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALL_BACKENDS, BACKEND_INFO, checkBackend, runWorker, type WorkerConfig } from '../src/main/orchestrator/worker'
import type { WorkerBackendKind } from '../src/main/orchestrator/backends/types'

const DEFAULT_CONFIGS: Record<WorkerBackendKind, WorkerConfig> = {
  pi: {
    backend: 'pi',
    provider: process.env.WORKER_PROVIDER ?? 'eepseek',
    model: process.env.WORKER_MODEL ?? 'deepseek-v4-flash',
    tools: ['read'],
    timeoutMs: 120_000
  },
  codex: { backend: 'codex', tools: ['read'], timeoutMs: 120_000 },
  codebuddy: { backend: 'codebuddy', tools: [], timeoutMs: 120_000 },
  claude: { backend: 'claude', tools: [], timeoutMs: 120_000 }
}

async function probe(kind: WorkerBackendKind): Promise<void> {
  const cfg = DEFAULT_CONFIGS[kind]
  const info = BACKEND_INFO[kind]
  console.log(`\n=== ${info.label} ===`)
  console.log(`  说明：${info.note}`)

  const ready = await checkBackend(cfg)
  if (!ready.ok) {
    console.log(`  ✘ 不可用：${ready.reason}`)
    return
  }
  console.log('  ✔ 配置与环境就绪')

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wk-${kind}-`))
  await fs.writeFile(path.join(workDir, 'seed.txt'), '编号 A7-31\n', 'utf8')

  const t0 = Date.now()
  const r = await runWorker({ config: cfg, prompt: '只回答两个字：可用', workDir })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  console.log(`  ${r.ok ? '✔' : '✘'} ${secs}s · 回答「${r.text.trim().slice(0, 40)}」· 工具调用 ${r.toolCalls.length}`)
  if (r.failureReason) console.log(`     原因：${r.failureReason.slice(0, 200)}`)
  const cost = (r.usage as { total_cost_usd?: number } | undefined)?.total_cost_usd
  if (typeof cost === 'number') console.log(`     花费：$${cost.toFixed(4)}`)
  else if (r.usage) console.log(`     用量：${JSON.stringify(r.usage).slice(0, 120)}`)
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'all') as WorkerBackendKind | 'all'
  const kinds: WorkerBackendKind[] = arg === 'all' ? ALL_BACKENDS : [arg]
  for (const k of kinds) {
    await probe(k)
  }
  console.log('\n注意：ChatGPT 桌面版是纯 GUI，没有命令行入口，接不了。')
  console.log('      OpenAI 那一边可自动化的是 codex，上面已经测了。')
}

void main()
