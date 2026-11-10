/**
 * 各后端"能不能真干活"的功能验证：让它读一个文件、写一个文件，然后用确定性验收检查。
 *
 * 用法：npx tsx scripts/backends-work.ts [pi|codex|claude|all]
 *
 * 和 backends-check 的区别：那个只验"能不能回话"，这个验"能不能读写文件"——
 * 编排层真正依赖的是后者。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAcceptance } from '../src/main/orchestrator/acceptance'
import { ALL_BACKENDS, checkBackend, runWorker, type WorkerConfig } from '../src/main/orchestrator/worker'
import type { WorkerBackendKind } from '../src/main/orchestrator/backends/types'

const CONFIGS: Record<WorkerBackendKind, WorkerConfig> = {
  pi: {
    backend: 'pi',
    provider: process.env.WORKER_PROVIDER ?? 'eepseek',
    model: process.env.WORKER_MODEL ?? 'deepseek-v4-flash',
    tools: ['read', 'write'],
    timeoutMs: 180_000
  },
  codex: { backend: 'codex', tools: ['read', 'write'], timeoutMs: 180_000 },
  codebuddy: { backend: 'codebuddy', tools: ['Read', 'Write'], timeoutMs: 180_000 },
  claude: { backend: 'claude', tools: ['Read', 'Write'], timeoutMs: 180_000 }
}

async function work(kind: WorkerBackendKind): Promise<void> {
  const cfg = CONFIGS[kind]
  console.log(`\n=== ${kind} ===`)
  const ready = await checkBackend(cfg)
  if (!ready.ok) {
    console.log(`  ✘ 不可用：${ready.reason}`)
    return
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `work-${kind}-`))
  await fs.writeFile(path.join(workDir, 'seed.txt'), '项目代号 PX-42，交付日期 2026-12-01。\n', 'utf8')

  const t0 = Date.now()
  const r = await runWorker({
    config: cfg,
    workDir,
    prompt:
      `读 ${path.join(workDir, 'seed.txt')}，把里面的代号和日期写成 summary.md。` +
      'summary.md 里只放这两条信息，不要客套话。'
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const acc = await runAcceptance(
    [
      { kind: 'file-exists', path: 'summary.md' },
      { kind: 'contains', path: 'summary.md', text: 'PX-42' }
    ],
    workDir
  )

  console.log(`  ${r.ok ? '✔' : '✘'} 跑完 ${secs}s · 工具调用 ${r.toolCalls.length} · 回答 ${r.text.length} 字`)
  if (r.failureReason) console.log(`     原因：${r.failureReason.slice(0, 180)}`)
  console.log(`  ${acc.passed ? '✔' : '✘'} 验收：${acc.results.map((x) => x.detail).join('；')}`)
  const cost = (r.usage as { total_cost_usd?: number } | undefined)?.total_cost_usd
  if (typeof cost === 'number') console.log(`     花费：$${cost.toFixed(4)}`)
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'all') as WorkerBackendKind | 'all'
  for (const k of arg === 'all' ? ALL_BACKENDS : [arg]) {
    await work(k)
  }
}

void main()
