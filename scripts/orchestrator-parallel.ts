/**
 * P2 验收：并行到底买到了什么。
 *
 * 用法：
 *   npx tsx scripts/orchestrator-parallel.ts [--concurrency N] [--only parallel|serial|both]
 *
 * 同一份计划跑两遍（先串行、再并行），比较墙钟时间。
 * 并行买到的只有**时间**，不是质量：所有工作体接的还是同一个网关。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectProgress } from '../src/main/orchestrator/plan'
import { ProjectRunner } from '../src/main/orchestrator/runner'
import { ProjectStore } from '../src/main/orchestrator/store'
import type { OrchestrationTask } from '../src/main/orchestrator/types'
import type { WorkerConfig } from '../src/main/orchestrator/worker'

const PROVIDER = process.env.WORKER_PROVIDER ?? 'eepseek'
const MODEL = process.env.WORKER_MODEL ?? 'deepseek-v4-flash'

const worker: WorkerConfig = {
  provider: PROVIDER,
  model: MODEL,
  tools: ['read', 'write'],
  timeoutMs: 5 * 60 * 1000
}

/** 四份互相独立的资料 + 一份合并：故意做成 4 路可并行、1 路有依赖 */
const SOURCES: { id: string; file: string; text: string; must: string }[] = [
  { id: 'n1', file: 'src-1.txt', text: '资料1：华东区销售额 1,240 万元，同比增长 18%。', must: '1,240' },
  { id: 'n2', file: 'src-2.txt', text: '资料2：华东区退货率 2.3%，比上季度下降 0.4 个百分点。', must: '2.3' },
  { id: 'n3', file: 'src-3.txt', text: '资料3：华东区新增客户 312 家，客单价 4.1 万元。', must: '312' },
  { id: 'n4', file: 'src-4.txt', text: '资料4：华东区客诉 87 件，其中物流时效占 61%。', must: '87' }
]

async function buildProject(root: string): Promise<ProjectStore> {
  await fs.mkdir(root, { recursive: true })
  for (const s of SOURCES) {
    await fs.writeFile(path.join(root, s.file), s.text + '\n', 'utf8')
  }

  const tasks: OrchestrationTask[] = SOURCES.map((s) => ({
    id: `notes-${s.id}`,
    title: `提炼资料${s.id.slice(1)}的要点`,
    prompt: `读 ${path.join(root, s.file)}，把要点写成 notes-${s.id}.md，保留全部数字，不要客套话。`,
    dependsOn: [],
    status: 'pending',
    acceptance: [
      { kind: 'file-exists', path: `notes-${s.id}.md` },
      { kind: 'contains', path: `notes-${s.id}.md`, text: s.must }
    ],
    attempts: 0
  }))

  tasks.push({
    id: 'report',
    title: '合并成一份简报',
    prompt:
      '读 _upstream/ 下全部 notes-*.md（上游各工作体的要点），合并写成 report.md：' +
      '按销售、退货、客户、客诉四段写，最后一句结论。只用文件里有的数字，不要自己编。',
    dependsOn: tasks.map((t) => t.id),
    status: 'pending',
    acceptance: [
      { kind: 'file-exists', path: 'report.md' },
      ...SOURCES.map((s) => ({ kind: 'contains' as const, path: 'report.md', text: s.must })),
      { kind: 'min-bytes', path: 'report.md', bytes: 150 }
    ],
    attempts: 0
  })

  const store = new ProjectStore(root)
  await store.create('Q3 华东区并行测试', tasks)
  return store
}

async function runOnce(mode: 'serial' | 'parallel', concurrency: number): Promise<{ seconds: number; done: number; total: number; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `polar-${mode}-`))
  const store = await buildProject(root)
  const project = (await store.load())!
  const started = Date.now()
  const runner = new ProjectRunner({
    store,
    resolveWorker: () => worker,
    onEvent: (e) => {
      if (e.kind === 'task-start') console.log(`  ▶ [${mode}] ${e.taskId}`)
      if (e.kind === 'task-end') console.log(`  ${e.ok ? '✔' : '✘'} [${mode}] ${e.taskId}${e.ok ? '' : '：' + (e.reason ?? '')}`)
      if (e.kind === 'deferred') console.log(`  ⏸ [${mode}] ${e.taskId}：${e.reason}`)
    }
  })
  const done = await runner.runAllConcurrent(project, mode === 'parallel' ? concurrency : 1)
  const p = projectProgress(done)
  const seconds = (Date.now() - started) / 1000
  console.log(
    `  ${mode}: ${seconds.toFixed(1)}s · ${p.done}/${p.total} 完成 · 失败 ${p.failed} · 未知 ${p.unknown} · 卡住 ${p.blocked}\n`
  )
  return { seconds, done: p.done, total: p.total, root }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const ci = args.indexOf('--concurrency')
  const concurrency = ci >= 0 ? Number(args[ci + 1]) : 3
  const oi = args.indexOf('--only')
  const only = oi >= 0 ? args[oi + 1] : 'both'

  console.log(`工作体：${PROVIDER} / ${MODEL} · 并行度 ${concurrency}\n`)

  const results: { serial?: Awaited<ReturnType<typeof runOnce>>; parallel?: Awaited<ReturnType<typeof runOnce>> } = {}

  if (only === 'serial' || only === 'both') {
    console.log('--- 串行（并发 1）---')
    results.serial = await runOnce('serial', 1)
  }
  if (only === 'parallel' || only === 'both') {
    console.log('--- 并行 ---')
    results.parallel = await runOnce('parallel', concurrency)
  }

  if (results.serial && results.parallel) {
    const s = results.serial.seconds
    const p = results.parallel.seconds
    console.log('=== 对比 ===')
    console.log(`串行 ${s.toFixed(1)}s · 并行 ${p.toFixed(1)}s · 快 ${(s / p).toFixed(2)}×`)
    console.log(`（并行买到的是时间，不是质量：两个模式接的是同一个模型）`)
    const ok = results.parallel.done === results.parallel.total && results.serial.done === results.serial.total
    console.log(ok ? '\n结论：并行结果与串行一致，全部通过' : '\n结论：有任务未通过，见上面的 ✘')
    process.exit(ok ? 0 : 1)
  }
  const r = results.parallel ?? results.serial!
  process.exit(r.done === r.total ? 0 : 1)
}

void main()
