/**
 * 按任务分配后端的真机验证：同一份计划里，不同任务交给不同家。
 *
 * 用法：npx tsx scripts/mixed-backends.ts
 *
 * 分配是按**能力**来的，不是随便分：
 * - 提炼要点 → codebuddy（写中文摘要干净）
 * - 合并成简报 → pi（快，且默认后端）
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dispatchOptions, previewDispatch } from '../src/main/orchestrator/project'
import { ProjectRunner } from '../src/main/orchestrator/runner'
import { ProjectStore } from '../src/main/orchestrator/store'
import { projectProgress } from '../src/main/orchestrator/plan'
import type { OrchestrationTask } from '../src/main/orchestrator/types'
import type { WorkerConfig } from '../src/main/orchestrator/worker'

/** 默认后端（没写 backend 的任务走这个） */
const DEFAULT: WorkerConfig = {
  backend: 'pi',
  provider: process.env.WORKER_PROVIDER ?? 'eepseek',
  model: process.env.WORKER_MODEL ?? 'deepseek-v4-flash',
  tools: ['read', 'write'],
  timeoutMs: 5 * 60 * 1000
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mixed-'))
  const sources = [
    { id: 'n1', text: '资料1：华东区销售额 1,240 万元，同比增长 18%。', must: '1,240' },
    { id: 'n2', text: '资料2：华东区退货率 2.3%，比上季度下降 0.4 个百分点。', must: '2.3' }
  ]
  for (const s of sources) {
    await fs.writeFile(path.join(root, `${s.id}.txt`), s.text + '\n', 'utf8')
  }

  const tasks: OrchestrationTask[] = sources.map((s) => ({
    id: `notes-${s.id}`,
    title: `提炼资料${s.id.slice(1)}`,
    prompt: `读 ${path.join(root, `${s.id}.txt`)}，把要点写成 notes-${s.id}.md，保留全部数字，不要客套话。`,
    dependsOn: [],
    status: 'pending',
    // 这两件交给 codebuddy
    worker: { backend: 'codebuddy', tools: ['read', 'write'] },
    acceptance: [
      { kind: 'file-exists', path: `notes-${s.id}.md` },
      { kind: 'contains', path: `notes-${s.id}.md`, text: s.must }
    ],
    attempts: 0
  }))

  tasks.push({
    id: 'report',
    title: '合并成简报',
    prompt: '读 _upstream/ 下的 notes-*.md，合并写成 report.md。只用文件里有的数字。',
    dependsOn: tasks.map((t) => t.id),
    status: 'pending',
    // 这一件不写 backend → 走默认（pi）
    acceptance: [
      { kind: 'file-exists', path: 'report.md' },
      ...sources.map((s) => ({ kind: 'contains' as const, path: 'report.md', text: s.must }))
    ],
    attempts: 0
  })

  const preview = previewDispatch(tasks)
  console.log(`默认后端：${DEFAULT.backend}`)
  console.log(`分层：${preview.layerWidths.join(' / ')} · 候选：${dispatchOptions(preview).map((o) => o.value).join(', ')}\n`)
  for (const t of tasks) {
    console.log(`  ${t.id.padEnd(10)} → ${t.worker?.backend ?? `${DEFAULT.backend}（默认）`}  能力：${(t.worker?.tools ?? DEFAULT.tools).join('+')}`)
  }
  console.log()

  const store = new ProjectStore(root)
  await store.create('混合后端测试', tasks)
  const project = (await store.load())!

  const runner = new ProjectRunner({
    store,
    resolveWorker: () => DEFAULT,
    onEvent: (e) => {
      if (e.kind === 'task-start') console.log(`▶ ${e.taskId}`)
      if (e.kind === 'task-end') console.log(`${e.ok ? '✔' : '✘'} ${e.taskId}${e.ok ? '' : `：${e.reason ?? ''}`}`)
    }
  })

  const done = await runner.runAllConcurrent(project, 2)
  const p = projectProgress(done)
  console.log(`\n进度：${p.done}/${p.total} 完成，失败 ${p.failed}`)

  // 从 runs.jsonl 里看每次派发的用量特征，反向确认是哪家跑的
  const runsRaw = await fs.readFile(path.join(root, '.orchestrator', 'runs.jsonl'), 'utf8')
  console.log('\n派发记录：')
  for (const line of runsRaw.split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { taskId: string; ok: boolean; usage?: Record<string, unknown> }
    const u = r.usage ?? {}
    const mark = 'total_cost_usd' in u ? 'claude' : 'cacheRead' in u || 'cacheWrite' in u ? 'pi' : 'codebuddy/codex'
    console.log(`  ${r.taskId.padEnd(10)} ok=${r.ok} 用量特征→${mark}`)
  }

  process.exit(p.done === p.total ? 0 : 1)
}

void main()
