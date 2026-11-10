/**
 * 委派冒烟：验证「长庚派活给 pi → 验收 → 拿回产出」这条链真的通。
 *
 * 用法：npx tsx scripts/delegate-smoke.ts
 *
 * 它走的是对话里那个 delegate_to_agent 工具**同一套**代码（runDelegation），
 * 只是绕开了 Electron 的闸门（那部分由 tests/main/delegate-gate.test.ts 锁）。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDelegation } from '../src/main/orchestrator/delegate'
import type { WorkerConfig } from '../src/main/orchestrator/worker'

const worker: WorkerConfig = {
  // 换后端不改代码：WORKER_BACKEND=codex npx tsx scripts/...
  backend: (process.env.WORKER_BACKEND ?? 'pi') as WorkerConfig['backend'],
  provider: process.env.WORKER_PROVIDER ?? 'eepseek',
  model: process.env.WORKER_MODEL ?? 'deepseek-v4-flash',
  tools: ['read', 'write'],
  timeoutMs: 3 * 60 * 1000
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delegate-smoke-'))
  const input = path.join(root, 'input.txt')
  await fs.writeFile(input, '素材：项目代号 PX-42，交付日期 2026-12-01。\n', 'utf8')

  console.log(`工作体：${worker.provider} / ${worker.model}`)
  console.log(`素材：${input}\n`)

  const r = await runDelegation(
    {
      title: '提炼素材要点',
      prompt: `读 ${input}，把要点写成 summary.md，保留代号和日期。不要客套话。`,
      expect: [
        { kind: 'file-exists', path: 'summary.md' },
        { kind: 'contains', path: 'summary.md', text: 'PX-42' }
      ]
    },
    worker,
    { rootDir: root, onProgress: (n) => console.log(`  · ${n}`) }
  )

  console.log(`\n状态：${r.taskStatus}`)
  console.log(`说明：${r.summary}`)
  console.log(`目录：${r.projectRoot}`)
  console.log(`产出：${r.artifactPaths.join(' | ') || '（无）'}`)

  const summary = path.join(r.projectRoot, 'tasks', 'delegate', 'summary.md')
  const text = await fs.readFile(summary, 'utf8').catch(() => '')
  if (text) {
    console.log('\n--- summary.md ---')
    console.log(text.trim().slice(0, 600))
  }

  process.exit(r.ok ? 0 : 1)
}

void main()
