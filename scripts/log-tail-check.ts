import { Store } from '../src/main/node/store'
import { resolveWithin } from '../src/main/node/list-tree'
import { readTail } from '../src/main/node/log-tail'
import path from 'node:path'

/**
 * 拿真实项目的日志试 read_log_tail。
 *
 * 用法：npx tsx scripts/log-tail-check.ts [项目名] [行数]
 *
 * 走的是模型真会走的那条路：档案 → 作用域校验 → 读尾。打印出来的是它会读到的内容。
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
  if (!entry.logPath) {
    console.log(`项目「${entry.name}」没登记日志位置，这个工具会用不了（会如实这么说）`)
    return
  }

  const target = resolveWithin(entry.root, entry.logPath)
  if (!target) {
    console.log(`❌ 登记的日志位置不在项目根里面，会被拒绝：${entry.logPath}`)
    process.exitCode = 1
    return
  }

  const lines = Number(process.argv[3]) || 80
  const t0 = Date.now()
  const r = await readTail(target, { lines })
  const ms = Date.now() - t0

  if (!r.ok) {
    console.log(`❌ ${r.reason}`)
    process.exitCode = 1
    return
  }

  const v = r.value
  console.log(`项目：${entry.name}`)
  console.log(`文件：${v.file}`)
  console.log(`大小：${Math.round(v.bytes / 1024)}KB · 编码 ${v.encoding} · 改于 ${v.mtime}`)
  console.log(`耗时：${ms}ms`)
  if (v.pickedNewest) console.log(`日志位置是目录，挑的是最新的：${v.pickedNewest}`)
  console.log(`读了最后 ${v.lines} 行${v.truncatedFromStart ? '（**上面还有内容没读到**）' : '（就是全文）'}`)
  console.log('-'.repeat(70))
  console.log(v.text)
}

void main()
