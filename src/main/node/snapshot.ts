import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { listStartupItems, resolveUninstallEntries, type UninstallEntry } from './registry'
import type { AppSnapshot, SnapshotDiff, StartupItem } from '../../shared/types'

/**
 * 卸载前的状态快照。
 *
 * 只做"记账"，不做"还原"：抓一份注册表项 + 安装目录规模 + 关联自启项，
 * 卸载后能回答"注册表项/目录/自启项还在不在"。不复制程序文件，
 * 也不承诺能把软件装回去——那是另一个量级的事。
 *
 * 代价控制：目录扫描有深度与条目上限，超过就标 truncated，
 * 宁可数字不准也不让卡片转半分钟。
 */

const MAX_ENTRIES = 20_000
const MAX_DEPTH = 3
const MAX_TOP_LEVEL = 20
/** 残留目录最多记 5 个：防止发布者名太泛（如"微软"）把账记爆 */
const MAX_RESIDUALS = 5

interface DirStats {
  fileCount: number
  dirCount: number
  totalBytes: number
  topLevel: string[]
  truncated: boolean
}

async function scanDir(root: string): Promise<DirStats> {
  const stats: DirStats = { fileCount: 0, dirCount: 0, totalBytes: 0, topLevel: [], truncated: false }
  let budget = MAX_ENTRIES

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget <= 0) {
      stats.truncated = true
      return
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      budget -= 1
      if (budget <= 0) {
        stats.truncated = true
        return
      }
      const full = path.join(dir, entry.name)
      if (depth === 0 && stats.topLevel.length < MAX_TOP_LEVEL) stats.topLevel.push(entry.name)
      if (entry.isDirectory()) {
        stats.dirCount += 1
        if (depth + 1 < MAX_DEPTH) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        stats.fileCount += 1
        try {
          const stat = await fs.stat(full)
          stats.totalBytes += stat.size
        } catch {
          /* 读不到大小就跳过，不编造 */
        }
      }
    }
  }

  if (!(await exists(root))) return { ...stats, fileCount: 0, dirCount: 0 }
  await walk(root, 0)
  return stats
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 自启项里跟这个程序相关的：命令里带安装目录，或名字里带程序名 */
function matchStartup(items: StartupItem[], appName: string, installLocation: string, exeName: string): StartupItem[] {
  const loc = installLocation.trim().toLowerCase()
  const exe = exeName.trim().toLowerCase()
  const name = appName.trim().toLowerCase()
  return items.filter((item) => {
    const cmd = item.command.toLowerCase()
    if (loc && cmd.includes(loc)) return true
    if (exe && cmd.includes(exe)) return true
    return name.length >= 3 && item.name.toLowerCase().includes(name)
  })
}

/**
 * 数据残留记账：在 AppData 三大根（Roaming / Local / ProgramData）里找
 * 与"发布者 / 产品名 / 安装路径段"同名的目录，逐个记下规模。
 * 只用发布者和产品名不够——网易的注册表 publisher 里没有 "NetEase" 这个词，
 * 而数据目录恰恰叫 NetEase（真机踩过）；安装路径的目录段是可靠的关键词来源。
 * 目录名匹配是"包含"；通用路径段（Program Files 等）与过短关键词不参与。
 */
const GENERIC_SEGMENTS = new Set([
  'program files',
  'program files (x86)',
  'files',
  'x86',
  'windows',
  'system32',
  'microsoft',
  'common',
  'common files',
  'data',
  'local',
  'roaming',
  'temp',
  'users'
])

function residualKeywords(entry: UninstallEntry | null, appName: string): string[] {
  const installSegments = (entry?.installLocation ?? '')
    .split(/[\\/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3 && !GENERIC_SEGMENTS.has(s))
  const all = [entry?.publisher ?? '', appName, ...installSegments]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2)
  return [...new Set(all)]
}

async function scanResiduals(keywords: string[]): Promise<AppSnapshot['residuals']> {
  if (keywords.length === 0) return []

  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA, 'C:\\ProgramData'].filter(Boolean) as string[]
  const out: AppSnapshot['residuals'] = []
  for (const root of roots) {
    let dirs: string[]
    try {
      dirs = await fs.readdir(root)
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (out.length >= MAX_RESIDUALS) return out
      const lower = dir.toLowerCase()
      if (!keywords.some((k) => lower.includes(k))) continue
      const full = path.join(root, dir)
      if (!(await exists(full))) continue
      const stats = await scanDir(full)
      if (stats.fileCount + stats.dirCount === 0) continue
      out.push({ path: full, fileCount: stats.fileCount, totalBytes: stats.totalBytes })
    }
  }
  return out
}

export interface CaptureOptions {
  /** 已经解析好的卸载项，避免重复查注册表 */
  entry?: UninstallEntry
  /** 自启项列表（调用方已有缓存就传进来，省一次 PowerShell） */
  startupItems?: StartupItem[]
}

export async function captureSnapshot(appName: string, options: CaptureOptions = {}): Promise<AppSnapshot> {
  const entry =
    options.entry ?? (await resolveUninstallEntries(appName)).find((item) => item.name === appName.trim()) ?? null

  const installLocation = entry?.installLocation?.trim() ?? ''
  const dirStats = installLocation ? await scanDir(installLocation) : null

  let startupItems = options.startupItems
  if (!startupItems) {
    try {
      startupItems = (await listStartupItems()).items
    } catch {
      startupItems = []
    }
  }
  const exeName = entry?.uninstallString
    ? path.basename(entry.uninstallString.replace(/^"/, '').split('"')[0].split(' ')[0])
    : ''
  const startup = matchStartup(startupItems, appName, installLocation, exeName)
  const residuals = await scanResiduals(residualKeywords(entry, appName))

  return {
    id: randomUUID(),
    appName,
    takenAt: new Date().toISOString(),
    registry: entry
      ? {
          key: entry.key,
          scope: entry.scope,
          arch: entry.arch,
          version: entry.version,
          publisher: entry.publisher,
          uninstallString: entry.uninstallString,
          installLocation,
          urlInfoAbout: entry.urlInfoAbout
        }
      : null,
    installDir: installLocation
      ? {
          path: installLocation,
          exists: dirStats ? dirStats.fileCount + dirStats.dirCount > 0 : false,
          fileCount: dirStats?.fileCount ?? 0,
          dirCount: dirStats?.dirCount ?? 0,
          totalBytes: dirStats?.totalBytes ?? 0,
          topLevel: dirStats?.topLevel ?? [],
          truncated: dirStats?.truncated ?? false
        }
      : null,
    startup,
    residuals,
    summary: {
      sizeMB: Math.round(((dirStats?.totalBytes ?? 0) / 1024 / 1024) * 10) / 10,
      files: dirStats?.fileCount ?? 0,
      startupCount: startup.length
    }
  }
}

/**
 * 从一堆卸载前快照里挑出这次要核对的那一份。
 *
 * 规则刻意简单，因为它服务于一句人话（"卸干净了没"）：
 * - 没给名字 → 最近一次卸载（用户通常就是在问刚刚那一次）
 * - 给了名字 → 先找完全同名的，再退回唯一一条包含匹配；
 *   包含匹配命中多条时**不挑**，返回 null 让调用方去问是哪一个——
 *   挑错了就会拿 A 的快照去核对 B，报出来的"卸干净了"是别人的
 */
export function pickSnapshot(list: AppSnapshot[], query?: string): AppSnapshot | null {
  const sorted = [...list].sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)))
  const name = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!name) return sorted[0] ?? null
  const exact = sorted.find((s) => s.appName.trim().toLowerCase() === name)
  if (exact) return exact
  const loose = sorted.filter((s) => s.appName.toLowerCase().includes(name))
  return loose.length === 1 ? loose[0] : null
}

/** 拿快照里的关键事实跟"现在"比一次；只陈述现状 */
export async function diffSnapshot(snapshot: AppSnapshot): Promise<SnapshotDiff> {
  const entries = await resolveUninstallEntries(snapshot.appName)
  const registryStillThere = entries.some((item) => item.key === snapshot.registry?.key)

  const dirPath = snapshot.installDir?.path ?? ''
  const dirStillThere = dirPath ? await exists(dirPath) : false
  const stats = dirPath && dirStillThere ? await scanDir(dirPath) : null

  let startupNow: StartupItem[] = []
  try {
    startupNow = (await listStartupItems()).items
  } catch {
    startupNow = []
  }
  // location::name 的组合键换成 StartupItem 的 source::name：
  // source 是注册表键路径 / 启动文件夹 / 计划任务路径，足够区分同名项
  const stillSet = new Set(startupNow.map((item) => `${item.source}::${item.name}`))
  const startupGone: string[] = []
  const startupStillThere: string[] = []
  for (const item of snapshot.startup) {
    const key = `${item.source}::${item.name}`
    if (stillSet.has(key)) startupStillThere.push(item.name)
    else startupGone.push(item.name)
  }

  const filesNow = stats?.fileCount ?? 0
  const bytesNow = stats?.totalBytes ?? 0
  const sizeMB = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

  // 残留重扫：快照记过的数据目录，现在还在的就是残留
  const residualLeft: SnapshotDiff['residualLeft'] = []
  let residualCleaned = 0
  for (const item of snapshot.residuals ?? []) {
    if (!(await exists(item.path))) {
      residualCleaned += 1
      continue
    }
    const stats = await scanDir(item.path)
    if (stats.fileCount + stats.dirCount === 0) {
      residualCleaned += 1
      continue
    }
    residualLeft.push({ path: item.path, fileCount: stats.fileCount, totalBytes: stats.totalBytes })
  }

  const parts: string[] = []
  parts.push(registryStillThere ? '注册表卸载项还在' : '注册表卸载项已消失')
  if (dirPath) parts.push(dirStillThere ? `安装目录还在（${sizeMB(bytesNow)}）` : '安装目录已不存在')
  if (snapshot.startup.length > 0) {
    parts.push(startupGone.length > 0 ? `自启项少了 ${startupGone.length} 个` : '自启项都还在')
  }
  parts.push(`文件数 ${snapshot.installDir?.fileCount ?? 0} → ${filesNow}`)
  if ((snapshot.residuals?.length ?? 0) > 0) {
    parts.push(
      residualLeft.length === 0
        ? '数据目录已全部清除'
        : `数据残留 ${residualLeft.length} 处（共 ${sizeMB(residualLeft.reduce((sum, r) => sum + r.totalBytes, 0))}）`
    )
  }

  return {
    appName: snapshot.appName,
    takenAt: snapshot.takenAt,
    registryStillThere,
    installDirStillThere: dirStillThere,
    filesBefore: snapshot.installDir?.fileCount ?? 0,
    filesNow,
    bytesBefore: snapshot.installDir?.totalBytes ?? 0,
    bytesNow,
    startupGone,
    startupStillThere,
    residualLeft,
    residualCleaned,
    verdict: parts.join('；')
  }
}
