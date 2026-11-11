/** 读一份老式 .doc/.xls，打印字数与开头一段：排查"这份文件为什么读不出来"时用 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { legacyOfficeText } from '../src/main/node/legacy-office'
import { isOle, oleStream, readOle } from '../src/main/node/ole'

/**
 * 默认只报"读了多少字"，不打印正文——这些文件常常是个人材料。
 * 真要看内容再加 `--show`。
 */

/** `--stat`：一份 .xls 里到底有多少张表、多少条单元格记录，用来判断"读到的字是不是全部" */
function statXls(file: string): void {
  const ole = readOle(readFileSync(file))
  console.log(`  流：${[...ole.streams.keys()].join('、')}`)
  const book = oleStream(ole, 'Workbook') ?? oleStream(ole, 'Book')
  if (!book) {
    console.log('  没有 Workbook/Book 流')
    return
  }
  const counts = new Map<number, number>()
  let pos = 0
  while (pos + 4 <= book.length) {
    const type = book.readUInt16LE(pos)
    const len = book.readUInt16LE(pos + 2)
    counts.set(type, (counts.get(type) ?? 0) + 1)
    pos += 4 + len
  }
  const named = (type: number): string =>
    ({ 0x85: 'BOUNDSHEET', 0xfc: 'SST', 0xfd: 'LABELSST', 0x203: 'NUMBER', 0x27e: 'RK', 0xbd: 'MULRK', 0x204: 'LABEL', 0x6: 'FORMULA', 0x207: 'STRING' })[type] ?? `0x${type.toString(16)}`
  const interesting = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12)
  console.log(`  记录：${interesting.map(([type, n]) => `${named(type)}×${n}`).join('、')}`)
}
function debugDoc(file: string): void {
  const ole = readOle(readFileSync(file))
  console.log(`  流：${[...ole.streams.keys()].join('、')}`)
  const wd = oleStream(ole, 'WordDocument')
  if (!wd) {
    console.log('  没有 WordDocument 流')
    return
  }
  const nFib = wd.readUInt16LE(2)
  const flags = wd.readUInt16LE(0x0a)
  const table = oleStream(ole, (flags & 0x0200) !== 0 ? '1Table' : '0Table')
  const fcClx = wd.readUInt32LE(0x01a2)
  const lcbClx = wd.readUInt32LE(0x01a6)
  console.log(
    `  nFib=${nFib} flags=0x${flags.toString(16)} lid=0x${wd.readUInt16LE(6).toString(16)} WordDocument=${wd.length}B ` +
      `${(flags & 0x0200) !== 0 ? '1Table' : '0Table'}=${table?.length ?? '缺'} fcClx=${fcClx} lcbClx=${lcbClx}`
  )
}

function kindOf(file: string): 'doc' | 'xls' | null {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.doc') return 'doc'
  if (ext === '.xls') return 'xls'
  return null
}

function one(file: string, show: boolean, debug: boolean, stat: boolean): void {
  const kind = kindOf(file)
  if (!kind) return
  const started = Date.now()
  try {
    const r = legacyOfficeText(kind, readFileSync(file))
    console.log(`  ✓ ${path.basename(file)} · ${r.text.length} 字 · ${Date.now() - started}ms${r.warnings.length ? ` · 提示：${r.warnings.join('；')}` : ''}`)
    if (show) console.log(`      ${r.text.slice(0, 120).replace(/\n/g, ' ⏎ ')}`)
    if (stat && kind === 'xls') statXls(file)
  } catch (err) {
    console.log(`  ✗ ${path.basename(file)} · 读不了：${err instanceof Error ? err.message : String(err)}`)
    if (debug && kind === 'doc' && isOle(readFileSync(file))) debugDoc(file)
  }
}

function collect(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    try {
      if (statSync(full).isDirectory()) collect(full, out, depth + 1)
      else if (kindOf(full)) out.push(full)
    } catch {
      /* 读不到的跳过 */
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const show = args.includes('--show')
  const debug = args.includes('--debug')
  const stat = args.includes('--stat')
  const rest = args.filter((a) => !['--show', '--debug', '--stat'].includes(a))
  if (rest.length === 0) {
    console.log('用法：npx tsx scripts/legacy-check.ts [--show] [--debug] [--stat] <文件或目录>…')
    process.exit(1)
  }
  const files: string[] = []
  for (const target of rest) {
    try {
      if (statSync(target).isDirectory()) collect(target, files)
      else files.push(target)
    } catch {
      console.log(`跳过 ${target}：不存在`)
    }
  }
  console.log(`共 ${files.length} 份老式文件`)
  for (const file of files) one(file, show, debug, stat)
}

main()
