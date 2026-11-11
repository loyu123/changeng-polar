/**
 * 桌面上的「长庚测试项目」：一份可以直接派给工作体的真实项目。
 *
 * 用法：
 *   npx tsx scripts/desktop-project.ts            # 真的派一次
 *   npx tsx scripts/desktop-project.ts --dry      # 只看计划与并行选项，不起进程
 *   npx tsx scripts/desktop-project.ts --dir D:\某处
 *
 * 它和对话里那个 `run_project` 工具走**同一套**代码（`orchestrator/project.ts`
 * 的 runProject），只是绕开 Electron 闸门——闸门本身由 tests/main/run-project-k7.test.ts 锁。
 *
 * 为什么落在桌面而不是 userData：这一份是给人看、给人改的。
 * 素材、产出、`.orchestrator` 的状态全在同一个目录里，打开就能对照。
 * （代价也要说清：应用里的「编排」页只扫 `%APPDATA%\changeng-polar\orchestrator`，
 *  不会列出桌面上这份。界面上要看进度，就在对话里让它派。）
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { previewDispatch, runProject } from '../src/main/orchestrator/project'
import { projectProgress } from '../src/main/orchestrator/plan'
import type { AcceptanceCheck, OrchestrationTask } from '../src/main/orchestrator/types'
import type { WorkerConfig } from '../src/main/orchestrator/worker'
import { loadScriptConfig } from './lib/load-config'

const DEFAULT_DIR = path.join(os.homedir(), 'Desktop', '长庚测试项目')

/** 三份素材：数字各不相同，验收就认这几个数，编不出来 */
const SOURCES = [
  {
    id: 'sales',
    file: '01-三季度销售.txt',
    text: '2026 年第三季度华东区销售额 1,240 万元，同比增长 18%。增长主要来自新客户。\n',
    must: '1,240'
  },
  {
    id: 'returns',
    file: '02-三季度退货.txt',
    text: '2026 年第三季度华东区退货率 2.3%，比上季度下降 0.4 个百分点。客诉集中在物流时效。\n',
    must: '2.3'
  },
  {
    id: 'customers',
    file: '03-三季度新客户.txt',
    text: '2026 年第三季度华东区新增客户 312 家，客单价 4.1 万元。其中制造业客户占 57%。\n',
    must: '312'
  }
]

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 素材只在不存在时写，不覆盖用户已经改过的那份 */
async function ensureSources(dir: string): Promise<string[]> {
  const srcDir = path.join(dir, '素材')
  await fs.mkdir(srcDir, { recursive: true })
  const written: string[] = []
  for (const s of SOURCES) {
    const target = path.join(srcDir, s.file)
    try {
      await fs.access(target)
    } catch {
      await fs.writeFile(target, s.text, 'utf8')
      written.push(s.file)
    }
  }
  return written
}

function buildTasks(dir: string): OrchestrationTask[] {
  const srcDir = path.join(dir, '素材')
  const extract = SOURCES.map<OrchestrationTask>((s) => ({
    id: `摘要-${s.id}`,
    title: `提炼「${s.file}」的要点`,
    prompt:
      `读 ${path.join(srcDir, s.file)}，把要点写成 ${s.id}-摘要.md。` +
      '保留全部数字，一行一条，不要客套话，不要加原文没有的内容。',
    dependsOn: [],
    status: 'pending',
    acceptance: [
      { kind: 'file-exists', path: `${s.id}-摘要.md` },
      { kind: 'contains', path: `${s.id}-摘要.md`, text: s.must },
      { kind: 'min-bytes', path: `${s.id}-摘要.md`, bytes: 30 }
    ] as AcceptanceCheck[],
    attempts: 0
  }))

  const merge: OrchestrationTask = {
    id: '总报告',
    title: '合并成一份季度简报',
    prompt:
      '读 _upstream/ 下的三个摘要文件（sales-摘要.md、returns-摘要.md、customers-摘要.md，' +
      '这是上游三个工作体各自的要点），合并写成 总报告.md：先写销售，再写退货，最后写新客户与结论。' +
      '只写这些摘要里有的数字，一个都不要自己编。',
    // 串行的最后一格：三路并行都完了才轮到他
    dependsOn: extract.map((t) => t.id),
    status: 'pending',
    acceptance: [
      { kind: 'file-exists', path: '总报告.md' },
      { kind: 'contains', path: '总报告.md', text: '1,240' },
      { kind: 'contains', path: '总报告.md', text: '2.3' },
      { kind: 'contains', path: '总报告.md', text: '312' },
      { kind: 'min-bytes', path: '总报告.md', bytes: 120 }
    ],
    attempts: 0
  }

  return [...extract, merge]
}

function workerFrom(): WorkerConfig {
  const loaded = loadScriptConfig()
  const configured = loaded.config.worker
  const provider = process.env.WORKER_PROVIDER ?? configured?.provider ?? 'eepseek'
  const model = process.env.WORKER_MODEL ?? configured?.model ?? 'deepseek-v4-flash'
  const backend = (process.env.WORKER_BACKEND ?? configured?.backend ?? 'pi') as WorkerConfig['backend']

  console.log(`工作体：${backend} / ${provider} / ${model}`)
  if (loaded.secretSource) console.log(`凭据：${loaded.secretSource}`)
  if (loaded.missing.length > 0) {
    console.log(`⚠️ 这些凭据读不到明文：${loaded.missing.join('、')}（工作体可能自己有一份配置，先照常试）`)
  }

  return {
    backend,
    provider,
    model,
    binPath: configured?.binPath || undefined,
    tools: ['read', 'write'],
    timeoutMs: (configured?.timeoutSec ?? 300) * 1000
  }
}

async function main(): Promise<void> {
  const dir = path.resolve(argValue('--dir') ?? DEFAULT_DIR)
  const dry = process.argv.includes('--dry')

  await fs.mkdir(dir, { recursive: true })
  const created = await ensureSources(dir)
  const tasks = buildTasks(dir)

  console.log(`项目目录：${dir}`)
  if (created.length > 0) console.log(`新建素材：${created.join('、')}`)
  else console.log('素材已存在，沿用（不会覆盖你改过的内容）')

  const preview = previewDispatch(tasks)
  console.log(`\n计划：${tasks.length} 个任务，最宽一层 ${preview.maxWidth} 路`)
  for (const t of tasks) {
    console.log(`  · ${t.id}${t.dependsOn.length ? `  ← 依赖 ${t.dependsOn.join('、')}` : ''}  验收 ${t.acceptance.length} 条`)
  }

  if (dry) {
    console.log('\n--dry：只看计划，不起进程。去掉这个参数就会真的派一次。')
    return
  }

  const worker = workerFrom()
  console.log('')

  const result = await runProject(
    { name: '桌面测试项目 · 三季度简报', tasks, mode: `parallel:${preview.maxWidth}` },
    {
      rootDir: dir,
      worker,
      onEvent: (e) => {
        if (e.kind === 'start') console.log(`▶ ${e.taskId} 开始`)
        else if (e.kind === 'progress') console.log(`   · ${e.taskId} 调用 ${e.note}`)
        else if (e.kind === 'end') console.log(`${e.note === '通过' ? '✔' : '✘'} ${e.taskId}：${e.note}`)
        else if (e.kind === 'deferred') console.log(`… ${e.taskId} 推迟：${e.note}`)
      }
    }
  )

  const progress = projectProgress(result.project)
  console.log(`\n${result.summary}`)
  console.log(
    `进度：完成 ${progress.done}/${progress.total}，失败 ${progress.failed}，未知 ${progress.unknown}，卡住 ${progress.blocked}`
  )
  console.log(`项目根：${result.projectRoot}`)

  // 派发记录：每条是一次真实的进程调用，不是"工具说成了"
  const runsFile = path.join(result.projectRoot, '.orchestrator', 'runs.jsonl')
  const runs = (await fs.readFile(runsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  console.log(`\n派发记录：${runs.length} 条（.orchestrator/runs.jsonl）`)
  for (const line of runs) {
    const r = JSON.parse(line) as { taskId: string; ok: boolean; toolCalls: unknown[]; outputChars: number; ms?: number }
    console.log(
      `  ${r.taskId}: ok=${r.ok} 工具调用=${r.toolCalls.length} 回答字数=${r.outputChars}${r.ms ? ` 用时=${(r.ms / 1000).toFixed(1)}s` : ''}`
    )
  }

  console.log('\n产出：')
  for (const t of result.project.tasks) {
    const taskDir = path.join(result.projectRoot, 'tasks', t.id)
    const files = await fs.readdir(taskDir).catch(() => [] as string[])
    console.log(`  ${t.id} [${t.status}] ${files.join(', ') || '(空)'}`)
    if (t.failureReason) console.log(`      失败原因：${t.failureReason}`)
  }

  process.exitCode = result.ok ? 0 : 1
}

void main()
