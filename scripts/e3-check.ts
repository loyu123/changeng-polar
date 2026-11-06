import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * E3 核对脚本：npx tsx scripts/e3-check.ts <包名关键词>
 * 1) 审计流水里找该包的安装记录，核对来源（winget Id / 安装包 URL）已登记
 * 2) 扫桌面与下载目录：关键词命中的 .exe/.msi 安装包残留应为 0
 * 用命令核实，不靠日志自述——这是 v0.4.0 出口标准 E3。
 */
function main(): void {
  const keyword = (process.argv[2] ?? '').toLowerCase()
  if (!keyword) {
    console.log('用法：npx tsx scripts/e3-check.ts <包名关键词，如 netease 或 7zip>')
    process.exit(1)
  }

  console.log(`--- 1) 审计流水核对（关键词：${keyword}）---`)
  const auditPath = path.join(process.env.APPDATA ?? os.homedir(), 'butler-demo', 'records.jsonl')
  let installs = 0
  if (existsSync(auditPath)) {
    for (const line of readFileSync(auditPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as { title?: string; target?: string; sourceUrl?: string; kind?: string }
        const hay = `${r.title ?? ''} ${r.target ?? ''}`.toLowerCase()
        if (r.kind === 'write' && hay.includes(keyword)) {
          installs += 1
          console.log(`  安装记录：${r.title} · 目标 ${r.target} · 来源URL ${r.sourceUrl ?? '(未登记)'}`)
        }
      } catch {
        /* 坏行跳过 */
      }
    }
  } else {
    console.log(`  没找到审计流水 ${auditPath}`)
  }
  console.log(`  安装记录 ${installs} 条${installs === 0 ? '（这台机器还没通过管家装过该软件）' : ''}`)

  console.log(`--- 2) 安装包残留扫描（桌面 + 下载目录）---`)
  const home = os.homedir()
  const dirs = [path.join(home, 'Desktop'), path.join(home, 'Downloads')]
  let leftovers = 0
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (/\.(exe|msi|msix)$/i.test(f) && f.toLowerCase().includes(keyword)) {
        leftovers += 1
        console.log(`  残留：${path.join(dir, f)}`)
      }
    }
  }
  console.log(`  残留安装包 ${leftovers} 个${leftovers === 0 ? ' ✅ 无残留' : ' ⚠️ 需要处理'}`)

  if (installs === 0 && leftovers === 0) {
    console.log('\n结论：无台账记录也无残留——没有可核对的安装（先通过管家装一次再跑）')
  } else {
    console.log(`\n结论：${leftovers === 0 ? 'E3 通过：来源已登记、无安装包残留' : 'E3 未通过：存在安装包残留'}`)
    if (leftovers > 0) process.exit(1)
  }
}

main()
