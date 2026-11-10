/**
 * GitHub 工具真机验证。
 *
 * 用法：npx tsx scripts/github-smoke.ts
 *
 * 只做安全的事：搜索（只读）+ 上传白名单的拒绝路径。
 * **不真的上传**——那会往用户仓库里留东西，得他自己决定。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertUploadableFile, ghReady, searchRepos } from '../src/main/node/github'

async function main(): Promise<void> {
  console.log('=== gh 状态 ===')
  const ready = await ghReady()
  if (!ready.ok) {
    console.log(`✘ ${ready.reason}`)
    process.exit(1)
  }
  console.log(`✔ 已登录：${ready.login}`)

  console.log('\n=== 搜索（按 star 排序）===')
  // 多词会被当成 AND，检索词太宽时返回 0 条很正常——这不是 bug，如实报"没找到"
  for (const q of ['markdown parser', 'electron auto updater']) {
    const r = await searchRepos(q, { max: 3 })
    if (!r.ok) {
      console.log(`✘ ${q}：${r.error}`)
      continue
    }
    console.log(`\n「${q}」找到 ${r.repos.length} 个：`)
    for (const repo of r.repos) {
      console.log(
        `  ${repo.full_name.padEnd(34)} ★${String(repo.stargazers_count).padStart(6)}  ` +
          `${(repo.language ?? '?').padEnd(12)} ${(repo.license?.name ?? repo.license?.key ?? '无').padEnd(14)} ` +
          `推送 ${repo.pushed_at.slice(0, 10)}`
      )
    }
  }

  console.log('\n=== 上传白名单（测拒绝路径，不真传）===')
  const sandbox = path.join(os.tmpdir(), 'butler-sandbox')
  const cases: { file: string; expectOk: boolean; why: string }[] = [
    { file: path.join(sandbox, '报告.md'), expectOk: true, why: '沙箱里的文件' },
    { file: path.join(os.homedir(), 'Desktop', '私密.docx'), expectOk: false, why: '桌面上的文件' },
    { file: path.join(os.homedir(), '.ssh', 'id_rsa'), expectOk: false, why: '私钥' },
    { file: path.join(sandbox, '..', '..', 'Windows', 'win.ini'), expectOk: false, why: '穿越出去' }
  ]
  for (const c of cases) {
    const r = assertUploadableFile(c.file, [sandbox])
    const mark = r.ok === c.expectOk ? '✔' : '✘ 判错了'
    console.log(`  ${mark} ${c.why.padEnd(14)} ${r.ok ? '允许' : '拒绝'}`)
  }

  // 顺便确认沙箱目录存在（正式运行时它会被建出来）
  await fs.mkdir(sandbox, { recursive: true })
  console.log(`\n沙箱目录：${sandbox}`)
  console.log('\n没有真的上传任何东西。上传会往你的仓库里留一条删不掉的记录，那一步留给你决定。')
}

void main()
