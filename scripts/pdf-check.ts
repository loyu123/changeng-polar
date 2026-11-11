/** 读一份 PDF 的文字层，打印页数、字数和开头一段：排查"这份 PDF 为什么读不出来"时用 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pdfText } from '../src/main/node/pdf'

/**
 * `--summary <目录>` 只报统计，不打印任何正文：拿一整批真实 PDF 量一遍
 * "能读多少、读不了的为什么读不了"，又不会把文件内容打到屏幕上。
 */
function summarize(root: string): void {
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = path.join(dir, name)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(full, depth + 1)
      else if (name.toLowerCase().endsWith('.pdf')) files.push(full)
    }
  }
  walk(root, 0)

  const tally = { ok: 0, noText: 0, broken: 0 }
  let chars = 0
  let pages = 0
  let partial = 0
  const reasons = new Map<string, number>()
  for (const file of files) {
    try {
      const r = pdfText(readFileSync(file))
      tally.ok++
      chars += r.text.length
      pages += r.pages
      if (r.pagesWithText < r.pages) partial++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/没有文字层/.test(message)) tally.noText++
      else tally.broken++
      // 归并成一句，别把几十条各不相同的原话都列出来
      const key = message.replace(/第 \d+ 页/g, '第 N 页').slice(0, 60)
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
  }

  console.log(`扫到 ${files.length} 份 PDF`)
  console.log(`  读出文字 ${tally.ok}（共 ${pages} 页、${chars} 字；其中 ${partial} 份有扫描页）`)
  console.log(`  没有文字层 ${tally.noText}`)
  console.log(`  其他问题 ${tally.broken}`)
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`    ×${count}  ${reason}`)
  }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args[0] === '--summary') {
    if (!args[1]) {
      console.log('用法：npx tsx scripts/pdf-check.ts --summary <目录>')
      process.exit(1)
    }
    summarize(args[1])
    return
  }
  const files = args
  if (files.length === 0) {
    console.log('用法：npx tsx scripts/pdf-check.ts <文件.pdf> [更多.pdf …]')
    console.log('      npx tsx scripts/pdf-check.ts --summary <目录>')
    process.exit(1)
  }
  for (const file of files) {
    const started = Date.now()
    console.log(`\n=== ${path.basename(file)} ===`)
    try {
      const r = pdfText(readFileSync(file))
      console.log(`页 ${r.pages} · 有字 ${r.pagesWithText} · ${r.text.length} 字 · ${Date.now() - started}ms`)
      if (r.warnings.length > 0) console.log(`提示：${r.warnings.join('；')}`)
      console.log(r.text.slice(0, 240).replace(/\n/g, ' ⏎ '))
    } catch (err) {
      console.log(`读不了：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

main()
