/** 读界面那套 view.ts，确认它能读到 userData 下的真实项目 */
import { listProjects } from '../src/main/orchestrator/view'

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    console.log('用法：npx tsx scripts/view-check.ts <orchestrator 目录>')
    process.exit(1)
  }
  const list = await listProjects(dir)
  console.log('项目数:', list.length)
  for (const p of list) {
    const g = p.progress
    console.log(
      `${p.name} | 任务 ${g.total} | 完成 ${g.done} | 派发 ${p.runCount} 次 | 最后 ${p.lastRunAt ?? '—'}`
    )
    for (const t of p.tasks) console.log(`   [${t.status}] ${t.title} 产出=${t.artifacts.length}`)
  }
}

void main()
