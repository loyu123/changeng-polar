import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SearchHit } from '../../shared/types'

/**
 * GitHub：搜索（只读）与上传报告（写）。
 *
 * 走 `gh` CLI 而不是自己拼 HTTP：这个用户机器上已经 `gh auth login` 过，
 * 凭据在系统 keyring 里，长庚**不碰 token**。自己接管 token 就意味着
 * 要在配置里存一份，那份配置会被备份、被同步、被贴进对话——不划算。
 *
 * 两条边界（改之前先看）：
 * 1. **搜索只发检索词出去**，和 web_search 同级。本轮读过私密内容时要先问用户。
 * 2. **上传是真写**：会往 GitHub 上留东西，而且**删不掉**（只能再做一个提交去覆盖）。
 *    所以上传必须过卡、永不「始终允许」，且只能上传长庚自己作品录下的文件——
 *    不给它"随便传一个路径"的能力。
 */

const GH_TIMEOUT_MS = 30_000

/** gh 不在 PATH / 没登录时，用这个错误把人话讲清楚 */
export class GhUnavailableError extends Error {}

interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

function runGh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
      }
    )
  })
}

/** gh 装没装、登没登录。不登录时搜索也不行（未认证只有 60 次/小时） */
export async function ghReady(): Promise<{ ok: boolean; login?: string; reason?: string }> {
  const status = await runGh(['auth', 'status'])
  if (!status.ok) {
    return {
      ok: false,
      reason:
        'gh 没有登录。在终端跑一次 `gh auth login` 之后再试。' +
        '未登录时 GitHub 搜索限 60 次/小时，长庚不打算在这种状态下替你查东西。'
    }
  }
  const who = await runGh(['api', 'user', '--jq', '.login'])
  const login = who.ok ? who.stdout.trim() : undefined
  return { ok: true, login }
}

interface GhRepo {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
  license: { spdx_id?: string | null; key?: string | null; name?: string | null } | null
  pushed_at: string
}

/**
 * 搜仓库。默认按 star 排序——用户问"有没有现成的、哪个最靠谱"时，
 * star 是最接近答案的粗排序（不完美，但比随机强）。
 */
export async function searchRepos(
  query: string,
  opts: { max?: number; sort?: 'stars' | 'updated' } = {}
): Promise<{ ok: boolean; hits: SearchHit[]; repos: GhRepo[]; error?: string }> {
  const q = query.trim()
  if (!q) return { ok: false, hits: [], repos: [], error: '没有给检索词' }

  const max = Math.max(1, Math.min(opts.max ?? 5, 10))
  const sort = opts.sort ?? 'stars'
  const res = await runGh([
    'search',
    'repos',
    q,
    '--limit', String(max),
    '--sort', sort,
    '--order', 'desc',
    // 这个 gh 版本不认 topics（会直接报 Unknown JSON field），所以不请求它。
    // 可用的字段以 `gh search repos --json __bogus__` 实际列出来的为准。
    '--json', 'fullName,url,description,stargazersCount,language,license,pushedAt'
  ])

  if (!res.ok) {
    return { ok: false, hits: [], repos: [], error: ghErrorText(res) }
  }

  let raw: unknown
  try {
    raw = JSON.parse(res.stdout)
  } catch {
    return { ok: false, hits: [], repos: [], error: 'gh 返回的不是 JSON' }
  }
  if (!Array.isArray(raw)) return { ok: false, hits: [], repos: [], error: 'gh 返回的形状不对' }

  const repos: GhRepo[] = (raw as Record<string, unknown>[]).map((r) => ({
    full_name: String(r.fullName ?? ''),
    html_url: String(r.url ?? ''),
    description: (r.description as string | null) ?? null,
    stargazers_count: Number(r.stargazersCount ?? 0),
    language: (r.language as string | null) ?? null,
    license: (r.license as GhRepo['license']) ?? null,
    pushed_at: String(r.pushedAt ?? '')
  }))

  return {
    ok: true,
    repos,
    hits: repos.map((r) => ({
      title: `${r.full_name} ★${r.stargazers_count}`,
      url: r.html_url,
      snippet: [r.description ?? '（无描述）', r.language ?? '未知语言', licenseLabel(r.license), `最后推送 ${r.pushed_at.slice(0, 10)}`]
        .filter(Boolean)
        .join(' · ')
    }))
  }
}

/** 报告归属哪一个仓库（读当前目录的 remote，不猜） */
export async function repoOf(cwd: string): Promise<string | null> {
  const res = await runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd })
  if (res.ok && res.stdout.trim()) return res.stdout.trim()
  return null
}

export interface UploadRequest {
  /** 要上传的本地文件（绝对路径）。只允许长庚自己作品录下的文件 */
  file: string
  /** 目标仓库 full_name（owner/name） */
  repo: string
  /** 仓库内路径，如 reports/2026-11-10.md */
  remotePath: string
  /** 提交说明 */
  message: string
  /** 目标分支，缺省 main */
  branch?: string
}

export interface UploadResult {
  ok: boolean
  url?: string
  summary: string
  /** 上传是覆盖式写入，撤不回——只能再传一次覆盖回去 */
  undoHint: string
}

/**
 * 把一个文件传上去（新建或覆盖同一个路径）。
 *
 * 用 Contents API 而不是 git push：不需要本地 clone、不碰工作区、
 * 一次就是一个提交。代价是**单文件 100MB 上限**，超了要换 git push。
 */
export async function uploadFile(req: UploadRequest): Promise<UploadResult> {
  const undoHint = '上传后撤不回：只能再传一次把那个路径覆盖掉，或者去 GitHub 上手工删'
  const content = await fs.readFile(req.file)
  if (content.byteLength > 50 * 1024 * 1024) {
    return {
      ok: false,
      summary: `文件 ${Math.round(content.byteLength / 1024 / 1024)}MB 太大（Contents API 限 50MB），没有上传`,
      undoHint
    }
  }

  const branch = req.branch?.trim() || 'main'
  const args = [
    'api',
    `--method=PUT`,
    `repos/${req.repo}/contents/${req.remotePath}`,
    '-f', `message=${req.message}`,
    '-f', `content=${content.toString('base64')}`,
    '-f', `branch=${branch}`
  ]

  // 覆盖已存在的文件必须带 sha，否则 GitHub 会拒绝
  const existing = await runGh(['api', `repos/${req.repo}/contents/${req.remotePath}?ref=${branch}`, '--jq', '.sha'])
  if (existing.ok && existing.stdout.trim()) {
    args.push('-f', `sha=${existing.stdout.trim()}`)
  }

  const res = await runGh(args, { timeoutMs: 60_000 })
  if (!res.ok) {
    return { ok: false, summary: `上传失败：${ghErrorText(res)}`, undoHint }
  }
  let url: string | undefined
  try {
    const j = JSON.parse(res.stdout) as { content?: { html_url?: string }; commit?: { html_url?: string } }
    url = j.content?.html_url ?? j.commit?.html_url
  } catch {
    /* 拿不到链接不影响成功与否 */
  }
  return {
    ok: true,
    url,
    summary: `已上传到 ${req.repo}/${req.remotePath}${url ? `（${url}）` : ''}`,
    undoHint
  }
}

/**
 * 上传之后回读远端那个路径，证明"东西真的在 GitHub 上"。
 *
 * 为什么值得多一次请求：上传是**删不掉**的写，而且 gh 说成功、实际没上去
 * （分支写错、仓库权限只读、企业策略拦了）都是会发生的。回读时比对的是
 * git blob sha —— GitHub 自己用这个值寻址内容，它与本地文件算出来的值相等，
 * 才等于"远端那份就是我这一个文件"。只比大小不行：同名不同稿很容易同大小。
 */
export async function verifyRemoteFile(req: {
  repo: string
  remotePath: string
  branch?: string
  file: string
}): Promise<{ ok: boolean; sha?: string; size?: number; localSha?: string; reason?: string }> {
  let content: Buffer
  try {
    content = await fs.readFile(req.file)
  } catch (err) {
    return { ok: false, reason: `读不到本地文件：${err instanceof Error ? err.message : String(err)}` }
  }
  const branch = req.branch?.trim() || 'main'
  const res = await runGh([
    'api',
    `repos/${req.repo}/contents/${req.remotePath}?ref=${branch}`,
    '--jq',
    '{sha: .sha, size: .size}'
  ])
  if (!res.ok) return { ok: false, reason: ghErrorText(res) }
  let remote: { sha?: string; size?: number }
  try {
    remote = JSON.parse(res.stdout) as { sha?: string; size?: number }
  } catch {
    return { ok: false, reason: '回读到的不是合法的 JSON' }
  }
  return { ok: true, sha: remote.sha, size: remote.size, localSha: gitBlobSha(content) }
}

/**
 * 本地文件按 git 的方式算 blob sha（`sha1("blob <len> " + content)`）。
 *
 * 用它和远端比，比"再下载一遍内容"便宜，也比比大小可靠。
 */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength} `)
    .update(content)
    .digest('hex')
}

/**
 * 只允许上传长庚自己作品录下的文件。
 *
 * 为什么要这条：上传带 `repo` scope，等于能往用户所有仓库写东西。
 * 允许"传任意路径"就是允许模型把桌面上任何文件推到你公开仓库去——
 * 这一步不该存在。所以只认 `作品录` 目录下的文件。
 */
export function assertUploadableFile(file: string, allowedRoots: string[]): { ok: boolean; reason?: string } {
  const target = path.resolve(file)
  for (const root of allowedRoots) {
    const abs = path.resolve(root)
    if (target === abs || target.startsWith(abs + path.sep)) return { ok: true }
  }
  return {
    ok: false,
    reason:
      `只允许上传长庚自己作品录里的文件（${allowedRoots.join(' 或 ')}）。` +
      '这个路径不在这里面——上传带 repo 权限，等于能往你所有仓库写东西，不该有"随便传一个路径"的能力。'
  }
}

/**
 * 许可证的显示名。
 *
 * gh 返回的 license 是 `{key,name,url}`，**没有 spdx_id**（我一开始按 spdx_id 取的，
 * 结果全都显示"无许可证"——明明是 MIT）。所以用 name 兜底。
 */
function licenseLabel(l: GhRepo['license']): string {
  if (!l) return '无许可证'
  return l.spdx_id ?? l.name ?? l.key ?? '有许可证（名称未知）'
}

/** 把 gh 的报错压成一句人话 */
function ghErrorText(res: GhResult): string {
  const raw = (res.stderr || res.stdout).trim()
  if (!raw) return `gh 退出码 ${res.code}`
  if (/not logged in|authentication/i.test(raw)) return 'gh 没有登录，先跑 `gh auth login`'
  if (/rate limit/i.test(raw)) return 'GitHub 限流了，过一会儿再试'
  if (/Could not resolve|not found/i.test(raw)) return `找不到：${raw.split('\n')[0].slice(0, 120)}`
  return raw.split('\n').slice(0, 2).join(' ').slice(0, 240)
}
