/**
 * 派发方式候选卡 + 项目进度视图的真机验收。
 *
 * 用法：npx tsx scripts/project-smoke.ts
 *
 * 做两件事：
 * 1. 造一份"三路并行 + 一路合并"的计划，看候选卡给出哪几档
 * 2. 真的派一次，再用界面读的那套函数（view.ts）把结果读回来
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dispatchOptions, previewDispatch, runProject } from '../src/main/orchestrator/project'
import { listProjects } from '../src/main/orchestrator/view'
import type { OrchestrationTask } from '../src/main/orchestrator/types'
import type { WorkerConfig } from '../src/main/orchestrator/worker'

const worker: WorkerConfig = {
  // 换后端不改代码：WORKER_BACKEND=codex npx tsx scripts/...
  backend: (process.env.WORKER_BACKEND ?? 'pi') as WorkerConfig['backend'],
  provider: process.env.WORKER_PROVIDER ?? 'eepseek',
  model: process.env.WORKER_MODEL ?? 'deepseek-v4-flash',
  tools: ['read', 'write'],
  timeoutMs: 5 * 60 * 1000
}

const SOURCES = [
  { id: 'n1', text: '资料1：华东区销售额 1,240 万元，同比增长 18%。', must: '1,240' },
  { id: 'n2', text: '资料2：华东区退货率 2.3%，比上季度下降 0.4 个百分点。', must: '2.3' },
  { id: 'n3', text: '资料3：华东区新增客户 312 家，客单价 4.1 万元。', must: '312' }
]

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-smoke-'))
  for (const s of SOURCES) {
    await fs.writeFile(path.join(root, `${s.id}.txt`), s.text + '\n', 'utf8')
  }

  const tasks: OrchestrationTask[] = SOURCES.map((s) => ({
    id: `notes-${s.id}`,
    title: `提炼资料${s.id.slice(1)}`,
    prompt: `读 ${path.join(root, `${s.id}.txt`)}，把要点写成 notes-${s.id}.md，保留全部数字，不要客套话。`,
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
    title: '合并成简报',
    prompt:
      '读 _upstream/ 下的 notes-*.md，合并写成 report.md：按销售、退货、客户分三段，最后一句结论。只用文件里有的数字。',
    dependsOn: tasks.map((t) => t.id),
    status: 'pending',
    acceptance: [
      { kind: 'file-exists', path: 'report.md' },
      ...SOURCES.map((s) => ({ kind: 'contains' as const, path: 'report.md', text: s.must }))
    ],
    attempts: 0
  })

  const preview = previewDispatch(tasks)
  const options = dispatchOptions(preview)
  console.log(`工作体：${worker.backend ?? 'pi'} / ${worker.model ?? '（用该后端自己的配置）'}`)
  console.log('=== 候选卡长这样 ===')
  console.log(`计划：${preview.total} 个任务，分层宽度 ${preview.layerWidths.join(' / ')}`)
  for (const o of options) console.log(`  [${o.value}] ${o.label} — ${o.detail}`)

  const chosen = options.find((o) => o.value === 'parallel:3')?.value ?? 'serial'
  console.log(`\n用户点了：${chosen}\n`)

  const result = await runProject(
    { name: 'Q3 华东区简报', tasks, mode: chosen },
    { rootDir: root, worker, onProgress: (n) => console.log(`  · ${n}`) }
  )

  console.log(`\n${result.summary}`)
  console.log(`并发：${result.concurrency} · 目录：${result.projectRoot}`)

  // 界面读的是这一套
  const listed = await listProjects([root])
  console.log('\n=== 界面上会显示 ===')
  for (const p of listed) {
    const g = p.progress
    console.log(`${p.name}  ${g.done}/${g.total} 完成${g.failed ? ` · 失败 ${g.failed}` : ''}`)
    for (const t of p.tasks) {
      console.log(`  [${t.status}] ${t.title}${t.failureReason ? ` — ${t.failureReason}` : ''}`)
      if (t.artifacts.length > 0) console.log(`        产出 ${t.artifacts.map((a) => path.basename(a)).join(', ')}`)
    }
  }

  process.exit(result.ok ? 0 : 1)
}

void main()
