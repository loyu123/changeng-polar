import { Store } from '../src/main/node/store'
import { listTree, formatListing, resolveWithin } from '../src/main/node/list-tree'
import { projectsBlock } from '../src/main/node/projects'

/**
 * 拿真实项目试 list_files。
 *
 * 用法：npx tsx scripts/list-project-check.ts [项目名] [子目录]
 *
 * 它走的是模型真会走的那条路：从档案读根 → 作用域校验 → 列 → formatListing。
 * 打印出来的就是模型会读到的文字。
 */
async function main(): Promise<void> {
  const store = new Store(process.env.APPDATA + '/changeng-polar')
  const list = await store.listProjects()
  if (list.length === 0) {
    console.log('档案是空的——先在设置里登记一个项目')
    return
  }

  const want = process.argv[2]
  const entry = want ? list.find((p) => p.name.includes(want) || p.root.includes(want)) : list[0]
  if (!entry) {
    console.log(`没有叫「${want}」的项目。登记过的：${list.map((p) => p.name).join('、')}`)
    return
  }

  console.log('提示词里的那一段：')
  console.log(projectsBlock([entry]))
  console.log('\n' + '='.repeat(70) + '\n')

  const sub = process.argv[3]
  const target = resolveWithin(entry.root, sub)
  if (!target) {
    console.log(`❌「${sub}」不在项目根里面，会被拒绝`)
    process.exitCode = 1
    return
  }

  const t0 = Date.now()
  const result = await listTree(entry.root, target, 3)
  const ms = Date.now() - t0

  console.log(`项目：${entry.name}`)
  console.log(`耗时：${ms}ms`)
  console.log('-'.repeat(70))
  console.log(formatListing(result))
}

void main()
