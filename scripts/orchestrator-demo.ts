/**
 * P1 验收：跑通一个真项目（串行）。
 *
 * 用法：
 *   npx tsx scripts/orchestrator-demo.ts [项目根目录]
 *
 * 模型不在代码里写死：读 WORKER_PROVIDER / WORKER_MODEL 环境变量，
 * 没设就用下面这两个（本机实测可用的那组）。以后换 Key / 换模型只改这里或环境变量。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectRunner } from '../src/main/orchestrator/runner'
import { projectProgress } from '../src/main/orchestrator/plan'
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

async function main(): Promise<void> {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'polar-proj-'))
  await fs.mkdir(root, { recursive: true })

  // 两份素材：模拟"把资料交给长庚，让它拆成几块"
  await fs.writeFile(
    path.join(root, 'src-a.txt'),
    '资料A：2026 年第三季度华东区销售额 1,240 万元，同比增长 18%。主要增长来自新客户。\n',
    'utf8'
  )
  await fs.writeFile(
    path.join(root, 'src-b.txt'),
    '资料B：2026 年第三季度华东区退货率 2.3%，比上季度下降 0.4 个百分点。客诉集中在物流时效。\n',
    'utf8'
  )

  const tasks: OrchestrationTask[] = [
    {
      id: 'notes-a',
      title: '提炼资料A的要点',
      prompt: `读 ${path.join(root, 'src-a.txt')}，把要点写成 notes-a.md，保留全部数字。文件里只放要点，不要客套话。`,
      dependsOn: [],
      status: 'pending',
      acceptance: [
        { kind: 'file-exists', path: 'notes-a.md' },
        { kind: 'contains', path: 'notes-a.md', text: '1,240' }
      ],
      attempts: 0
    },
    {
      id: 'notes-b',
      title: '提炼资料B的要点',
      prompt: `读 ${path.join(root, 'src-b.txt')}，把要点写成 notes-b.md，保留全部数字。文件里只放要点，不要客套话。`,
      dependsOn: [],
      status: 'pending',
      acceptance: [
        { kind: 'file-exists', path: 'notes-b.md' },
        { kind: 'contains', path: 'notes-b.md', text: '2.3' }
      ],
      attempts: 0
    },
    {
      id: 'report',
      title: '合并成一份季度简报',
      prompt:
        '读 _upstream/ 下的 notes-a.md 和 notes-b.md（这是上游两个工作体各自的要点），' +
        '合并写成 report.md：先写销售，再写退货，最后一句给结论。只写文件里有的数字，不要自己编。',
      dependsOn: ['notes-a', 'notes-b'],
      status: 'pending',
      acceptance: [
        { kind: 'file-exists', path: 'report.md' },
        { kind: 'contains', path: 'report.md', text: '1,240' },
        { kind: 'contains', path: 'report.md', text: '2.3' },
        { kind: 'min-bytes', path: 'report.md', bytes: 100 }
      ],
      attempts: 0
    }
  ]

  const store = new ProjectStore(root)
  const project = await store.create('Q3 华东区简报', tasks)
  console.log(`项目根目录：${root}`)
  console.log(`工作体：${PROVIDER} / ${MODEL}\n`)

  const runner = new ProjectRunner({
    store,
    resolveWorker: () => worker,
    onEvent: (e) => {
      if (e.kind === 'task-start') console.log(`▶ ${e.taskId} 开始`)
      if (e.kind === 'task-progress') console.log(`   · 调用 ${e.tool}${e.ok === false ? '（失败）' : ''}`)
      if (e.kind === 'task-end') console.log(`${e.ok ? '✔' : '✘'} ${e.taskId}：${e.reason ?? ''}`)
    }
  })

  const done = await runner.runAll(project)
  const p = projectProgress(done)
  console.log(`\n进度：${p.done}/${p.total} 完成，失败 ${p.failed}，未知 ${p.unknown}，卡住 ${p.blocked}`)

  const runs = await fs.readFile(path.join(root, '.orchestrator', done.id, 'runs.jsonl'), 'utf8').catch(() => '')
  const lines = runs.split('\n').filter(Boolean)
  console.log(`派发记录：${lines.length} 条（.orchestrator/${done.id}/runs.jsonl）`)
  for (const line of lines) {
    const r = JSON.parse(line) as { taskId: string; ok: boolean; toolCalls: unknown[]; outputChars: number }
    console.log(`  ${r.taskId}: ok=${r.ok} 工具调用=${r.toolCalls.length} 回答字数=${r.outputChars}`)
  }

  console.log('\n产出：')
  for (const t of done.tasks) {
    const dir = path.join(root, t.workDir ?? path.join('tasks', t.id))
    const files = await fs.readdir(dir).catch(() => [] as string[])
    console.log(`  ${t.id} [${t.status}] ${files.join(', ')}`)
  }
  process.exit(p.done === p.total ? 0 : 1)
}

void main()
