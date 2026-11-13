import { promises as fs } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { NOISE_DIR_RE } from './folder'

/**
 * 列目录：**作用域限在项目档案登记的根目录里**。
 *
 * 为什么不做成"任意目录"：这是这个工具唯一的边界，也是它值得存在的理由。
 * 给一个能看全盘的 list，等于给了一个和资源管理器一样宽的能力，而它要回答的
 * 问题只有一个——「我这个项目里有什么」。范围窄了，它可枚举、可审计，
 * 用户看审计记录时也能立刻判断"它为什么去那儿"。
 *
 * 三条与既有代码对齐的口径：
 * - **跳过规则复用 `shouldSkipDirName`**：和文件夹索引、file.ts 的文件索引
 *   同一套（点开头、node_modules、构建产物）。三处各写一套的话，
 *   "为什么这里没列出来"会变成每次都要重查的问题。
 * - **预算照 launch.ts 的先例**：深度与条目都有上限，超了标 truncated 并说清楚。
 *   一个巨大的目录不能把这一轮拖死。
 * - **不跟随符号链接**：链接可能指向作用域之外的任何地方，跟着走等于绕开上面的边界。
 *
 * 读不到就说读不到：权限不足的目录单独记一条 note，不静默跳过——
 * 静默跳过会让模型以为"这个项目只有这些"，而其实是大半个目录读不进来。
 */

/**
 * `list_files` 的跳过规则，**和文件夹索引不是同一套**，这是有意的。
 *
 * `shouldSkipDirName` 会跳过**所有**点开头的目录。对文件索引那是对的（用户目录里
 * `.xxx` 基本都是程序自己建的），但对项目不是：真机踩到过——这个报告项目的进度日志
 * 就在 `.workbuddy/memory/` 里，PPT 的构建日志在 `.slidep/`，两个都会被一刀切掉，
 * 于是模型列完项目会说"没看到进度记录"，而记录明明在那儿。
 *
 * 所以这里只跳过**已知是噪音**的那批（node_modules、dist、build、.git…），
 * 其余点开头目录照常列出。跳过的仍然要说出来，见 ListResult.skipped。
 */
function shouldSkipInProject(name: string): boolean {
  return NOISE_DIR_RE.test(name)
}

/** 最多下钻几层。项目根下面一般三到四层就到底了，再深处是产物和缓存 */
export const LIST_MAX_DEPTH = 3
/** 一次最多回多少条（文件 + 目录）。超了截断并明说 */
export const LIST_MAX_ENTRIES = 300
/** 一次最多打开多少个目录——防的是"八百个子目录"那种结构把这一轮拖住 */
export const LIST_MAX_DIRS = 120

export interface ListedEntry {
  /** 相对项目根的路径，用正斜杠（模型读起来比反斜杠清楚） */
  path: string
  name: string
  /**
   * `link` 是符号链接 / 目录联接：**列出来但绝不进去**。
   *
   * 不进去的理由是作用域——链接可以指向任何地方，跟进去等于绕开这个工具唯一的边界。
   * 但也不能像最初那样直接跳过：用户的项目里挂一个指向别处的链接是常见做法，
   * 清单里什么都不显示，模型就会断言"这个项目没有那个目录"。
   * 所以列出来、标明是链接、说清没跟进去。
   */
  kind: 'dir' | 'file' | 'link'
  /** 字节数；目录和链接为 undefined */
  size?: number
  /** 最后修改时间（ISO）。用它判断"最近在动哪块" */
  mtime: string
}

export interface ListResult {
  root: string
  entries: ListedEntry[]
  /** 命中预算被截断了。截断时下面的数字都是"至少" */
  truncated: boolean
  /** 一共扫过多少个目录 */
  dirsScanned: number
  /** 读不进来的子目录（权限 / 被占用）。静默跳过是不行的，见文件头 */
  unreadable: Array<{ path: string; reason: string }>
  /**
   * 按规则跳过的目录名（node_modules、dist…）。
   *
   * 要报出来：不报的话模型看到的是一个"干净"的清单，而用户问"依赖装在哪"
   * 时它会回答"没有 node_modules 这个目录"——那不是它没看见，是被跳过了。
   * 只给名字不给内容，避免又把预算吃光。
   */
  skipped: string[]
  /** 按扩展名归类的计数：回答问题"这项目主要是些什么文件" */
  byExt: Record<string, number>
}

/**
 * 这个路径在不在给定的根里面。
 *
 * 判据是**路径前缀 + 分隔符**，不是字符串前缀：`D:\proj-evil` 不该被判成
 * 在 `D:\proj` 里面。这条错了，整个作用域就形同虚设。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const r = norm(root)
  const t = norm(target)
  if (r === t) return true
  return t.startsWith(r + path.sep) || t.startsWith(r + '/')
}

/** 模型给的是相对路径还是绝对路径，统一解析到绝对路径；越界返回 null */
export function resolveWithin(root: string, sub: unknown): string | null {
  const text = String(sub ?? '').trim()
  const base = path.resolve(root)
  if (!text) return base
  // 绝对路径也允许，但必须落在根里面
  const target = path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text)
  return isInsideRoot(root, target) ? target : null
}

/** 单个目录的一层内容（给"只看这一层"的用法） */
export interface DirListing {
  dir: string
  entries: ListedEntry[]
  truncated: boolean
  unreadable: Array<{ path: string; reason: string }>
}

function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return ext || '(无后缀)'
}

/**
 * 列一层。
 *
 * `statSync` 而不是 `withFileTypes` 的 dirent：要拿大小和修改时间，
 * 而 dirent 只有类型。代价是对每个条目多一次 stat——条目数有上限，可以接受。
 * 链接先判掉再 stat：statSync 是跟随的，一个指向 C:\ 的 junction 会被读成目录。
 */
export async function listOneLevel(root: string, dir: string): Promise<DirListing> {
  const unreadable: Array<{ path: string; reason: string }> = []
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return {
      dir,
      entries: [],
      truncated: false,
      unreadable: [{ path: dir, reason: err instanceof Error ? err.message : String(err) }]
    }
  }

  const out: ListedEntry[] = []
  let truncated = false
  // 目录在前、文件在后，各自按名字排：模型和人都更容易扫
  const sorted = [...dirents].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  for (const d of sorted) {
    if (out.length >= LIST_MAX_ENTRIES) {
      truncated = true
      break
    }
    const full = path.join(dir, d.name)
    const rel = path.relative(root, full).split(path.sep).join('/')

    /**
     * 链接先判掉，不走下面的 statSync。
     *
     * `statSync` 是跟随的：一个指向 C:\ 的 junction 在这里会被读成"目录"、
     * 还能拿到目标的大小与时间——于是模型以为项目里有这么个目录，
     * 而去读它时又被作用域挡住。前后矛盾比不列更糟。
     */
    if (d.isSymbolicLink()) {
      out.push({ path: rel, name: d.name, kind: 'link', mtime: safeMtime(full) })
      continue
    }

    try {
      const st = statSync(full)
      out.push({
        path: rel,
        name: d.name,
        kind: d.isDirectory() ? 'dir' : 'file',
        ...(d.isDirectory() ? {} : { size: st.size }),
        mtime: st.mtime.toISOString()
      })
    } catch (err) {
      unreadable.push({ path: rel, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { dir, entries: out, truncated, unreadable }
}

/**
 * 递归列，带深度和条目预算。
 *
 * 链接一律列出来但不进去：一个指向 `C:\` 的软链在这里必须当成一个条目，
 * 跟进去就等于把这个工具唯一的作用域边界绕开了。列出来是因为"完全看不见"
 * 会让模型断言项目里没有那个目录——所以列、标明、说清没跟。
 */
export async function listTree(root: string, subRoot: string, maxDepth = LIST_MAX_DEPTH): Promise<ListResult> {
  const entries: ListedEntry[] = []
  const unreadable: Array<{ path: string; reason: string }> = []
  const skipped: string[] = []
  const byExt: Record<string, number> = {}
  let dirsScanned = 0
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    if (dirsScanned >= LIST_MAX_DIRS) {
      truncated = true
      unreadable.push({ path: path.relative(root, dir).split(path.sep).join('/'), reason: `超过 ${LIST_MAX_DIRS} 个目录的扫描上限，没继续往下` })
      return
    }
    dirsScanned += 1
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      unreadable.push({
        path: path.relative(root, dir).split(path.sep).join('/') || '.',
        reason: err instanceof Error ? err.message : String(err)
      })
      return
    }

    const sorted = [...dirents].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })

    for (const d of sorted) {
      if (entries.length >= LIST_MAX_ENTRIES) {
        truncated = true
        return
      }
      const full = path.join(dir, d.name)
      const rel = path.relative(root, full).split(path.sep).join('/')

      // 符号链接 / 目录联接：列出来，但不进去（见 ListedEntry.kind 的注释）
      if (d.isSymbolicLink()) {
        entries.push({ path: rel, name: d.name, kind: 'link', mtime: safeMtime(full) })
        continue
      }

      if (d.isDirectory()) {
        // 跳过的记名字不记内容：见 ListResult.skipped 的注释
        if (shouldSkipInProject(d.name)) {
          if (!skipped.includes(d.name)) skipped.push(d.name)
          continue
        }
        entries.push({ path: rel, name: d.name, kind: 'dir', mtime: safeMtime(full) })
        if (depth + 1 < maxDepth) await walk(full, depth + 1)
        continue
      }

      if (!d.isFile()) continue // 设备、管道：都不是"项目里的文件"
      const st = tryStat(full)
      if (!st) {
        unreadable.push({ path: rel, reason: '读不到这个条目的信息（可能被占用或没有权限）' })
        continue
      }
      entries.push({ path: rel, name: d.name, kind: 'file', size: st.size, mtime: st.mtime.toISOString() })
      byExt[extOf(d.name)] = (byExt[extOf(d.name)] ?? 0) + 1
    }
  }

  await walk(subRoot, 0)

  return { root, entries, truncated, dirsScanned, unreadable, skipped, byExt }
}

function tryStat(p: string): { size: number; mtime: Date } | null {
  try {
    const st = statSync(p)
    return { size: st.size, mtime: st.mtime }
  } catch {
    return null
  }
}

function safeMtime(p: string): string {
  const st = tryStat(p)
  return st ? st.mtime.toISOString() : ''
}

/**
 * 把结果压成一段给模型读的文字。
 *
 * 为什么不直接给 JSON：模型要把 300 条 JSON 读完才知道"这项目里有啥"，
 * 而按目录分组的缩进清单一眼就能看懂，也省 token。数字（大小、时间）只给
 * 文件，目录不给——目录的 mtime 是"最后一个子项改动的时间"，容易被误读成
 * "这个目录最后被编辑的时间"。
 */
export function formatListing(result: ListResult, opts: { maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? 200
  const lines: string[] = []
  const dirs = result.entries.filter((e) => e.kind === 'dir')
  const files = result.entries.filter((e) => e.kind === 'file')
  const links = result.entries.filter((e) => e.kind === 'link')

  lines.push(`根目录：${result.root}`)
  lines.push(
    `条目：${dirs.length} 个目录 / ${files.length} 个文件` +
      (links.length > 0 ? ` / ${links.length} 个链接` : '') +
      `（扫了 ${result.dirsScanned} 个目录）`
  )

  const extPairs = Object.entries(result.byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (extPairs.length > 0) {
    lines.push(`文件类型：${extPairs.map(([ext, n]) => `${ext} ${n}`).join('，')}`)
  }

  if (dirs.length > 0) {
    lines.push('', '目录：')
    for (const d of dirs.slice(0, maxLines)) lines.push(`  ${d.path}`)
    if (dirs.length > maxLines) lines.push(`  …还有 ${dirs.length - maxLines} 个目录没列出`)
  }

  if (files.length > 0) {
    lines.push('', '文件：')
    // 最近改的排前面：问"进展到哪"时，最近动过的就是线索
    const recent = [...files].sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
    for (const f of recent.slice(0, maxLines)) {
      const size = f.size === undefined ? '' : ` (${formatSize(f.size)})`
      lines.push(`  ${f.path}${size}`)
    }
    if (files.length > maxLines) lines.push(`  …还有 ${files.length - maxLines} 个文件没列出（按修改时间倒序取前 ${maxLines} 个）`)
  }

  if (result.truncated) {
    lines.push('', `**注意：超过上限被截断了**，上面不是全部。要看某一块就指定更具体的子目录。`)
  }
  if (links.length > 0) {
    lines.push('', '链接（符号链接 / 目录联接，**没有跟进去**，因为可能指向项目外面）：')
    for (const l of links.slice(0, 20)) lines.push(`  ${l.path}`)
  }
  if (result.skipped.length > 0) {
    /**
     * 说清"还能单独看"而不是只说"跳过了"。
     *
     * 这几类目录名的含义是模糊的：`node_modules`/`dist` 基本都是产物，但
     * `build` 在别的项目里可能装的是**构建脚本**——这个报告项目的
     * `.workbuddy/build/` 里就是 build_report.py 和 renumber_refs.py，
     * 正是生成报告的那些代码。只报"跳过了 build"，模型会回答"没有构建脚本"。
     * 所以把出路一起给出来：要看就把 dir 指到它。
     */
    lines.push(
      '',
      `按规则跳过的目录（构建产物 / 依赖缓存，内容没列）：${result.skipped.join('、')}`,
      '  这些名字也可能装着构建脚本或源码——要看哪一个，把它作为 dir 单独列一次。'
    )
  }
  if (result.unreadable.length > 0) {
    lines.push('', `读不到的部分（${result.unreadable.length} 处）：`)
    for (const u of result.unreadable.slice(0, 8)) lines.push(`  ${u.path}：${u.reason}`)
  }

  return lines.join('\n')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
