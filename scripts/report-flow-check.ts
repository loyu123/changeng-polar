import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/node/store'
import { resolveWithin, listTree, formatListing } from '../src/main/node/list-tree'
import { readTail } from '../src/main/node/log-tail'

/**
 * 走一遍「进展汇报」那条骨架要用的三种只读能力，用真实项目。
 *
 * 用法：npx tsx scripts/report-flow-check.ts [项目名]
 *
 * 验的不是文字生成（那是模型的事），而是**骨架里写的每一步在真实项目上
 * 都拿得到东西**：list_files 给出最近改的文件、read_log_tail 给出末尾、
 * 两者合起来足以答"最近做了什么、现在卡在哪"。
 *
 * 不写文件：这一步不该在用户的桌面上留下测试产物。
 */
async function main(): Promise<void> {
  const store = new Store(process.env.APPDATA + '/changeng-polar')
  const list = await store.listProjects()
  if (list.length === 0) {
    console.log('档案是空的')
    return
  }
  const want = process.argv[2]
  const entry = want ? list.find((p) => p.name.includes(want)) : list[0]
  if (!entry) {
    console.log(`没有叫「${want}」的项目。登记过的：${list.map((p) => p.name).join('、')}`)
    return
  }

  console.log(`项目：${entry.name}`)
  console.log('='.repeat(70))

  // 第 1 步：list_files —— 只看最近动过的那些，骨架里说的"按修改时间倒序"
  const t0 = Date.now()
  const tree = await listTree(entry.root, entry.root, 2)
  const files = tree.entries
    .filter((e) => e.kind === 'file')
    .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
  console.log(`\n【第 1 步】list_files：${tree.entries.length} 条，耗时 ${Date.now() - t0}ms`)
  console.log('最近改动的 8 个文件（这就是"线索"）：')
  for (const f of files.slice(0, 8)) {
    console.log(`  ${f.mtime.slice(0, 16)}  ${f.path}`)
  }

  // 第 2 步：read_log_tail —— 答"卡在哪"要靠它
  if (!entry.logPath) {
    console.log('\n⚠️ 这个项目没登记日志位置，骨架里的第 2 步会走不通（工具会如实这么说）')
    return
  }
  const target = resolveWithin(entry.root, entry.logPath)
  if (!target) {
    console.log('\n❌ 登记的日志位置在项目根外面，会被拒绝')
    process.exitCode = 1
    return
  }
  const t1 = Date.now()
  const tail = await readTail(target, { lines: 12 })
  console.log(`\n【第 2 步】read_log_tail：耗时 ${Date.now() - t1}ms`)
  if (!tail.ok) {
    console.log(`  ❌ ${tail.reason}`)
    process.exitCode = 1
    return
  }
  const v = tail.value
  console.log(`  文件 ${path.basename(v.file)} · ${Math.round(v.bytes / 1024)}KB · ${v.encoding}`)
  console.log(`  读了最后 ${v.lines} 行${v.truncatedFromStart ? '（上面还有）' : '（全文）'}`)
  console.log('-'.repeat(70))
  console.log(v.text.split('\n').slice(0, 6).join('\n'))
  console.log('  …')

  console.log('\n' + '='.repeat(70))
  console.log('骨架里要求的两步都拿到了东西：')
  console.log(`  · 最近改的文件：${files[0]?.path ?? '(无)'}`)
  console.log(`  · 日志末尾：${v.lines} 行，${v.truncatedFromStart ? '需要说明只看了末尾' : '是全文'}`)
  console.log('  下一步是模型按骨架组织文字 + write_document 落盘（那一步要过授权，这里不做）')
}

void main()
