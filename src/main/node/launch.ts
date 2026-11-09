import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPs } from './ps'

/**
 * 打开程序：把用户双击图标这件事，换成我们替他按下去。
 *
 * 三条通路，按代价从低到高排队（**前一条命中就不问后一条**）：
 *   1. `.lnk` 快捷方式（开始菜单 + 桌面）—— 文件系统扫描，最快，覆盖绝大多数程序
 *   2. `.url` Internet 快捷方式 —— Steam 游戏就是这种（真机上 ICEY 是
 *      `steam://rungameid/553640`），它根本不是 .lnk，只认 .lnk 会永远找不到
 *   3. `shell:AppsFolder\<AppID>` —— 系统的应用清单（`Get-StartApps`）。
 *      豆包、微软商店应用、计算器这类**不建任何快捷方式**的程序只有这一条路。
 *      代价是一次 PowerShell（约数百毫秒），所以只在前两条都没命中时才走
 *
 * 边界（改之前先看这几条）：
 * - **可执行目标只能来自这三份清单**（文件系统 / .url 文件 / 系统应用清单），
 *   不接受模型或用户临时给的任意路径、不接受命令行参数。模型能做的只是"点名"，
 *   点到哪个由这些清单决定。参数拼接是另一类风险，"打开程序"用不着它
 * - **不碰"卸载/修复/更新/帮助"这类条目**。真机上「哔哩哔哩」的程序组里
 *   `哔哩哔哩.lnk` 和 `卸载哔哩哔哩.lnk` 并排放着，只按名字做包含匹配的话，
 *   「打开哔哩哔哩」会命中卸载器——用户说"打开给我看看"，屏幕上弹出卸载确认框
 * - **http/https 的内容不算"程序"**：那是网页，打开它等于开浏览器，不是用户要的
 * - 名字对不上唯一目标就不猜（和卸载那边同一个口径：宁可让用户说清楚）
 * - 启动后不等它退出：那是用户自己在用的窗口，不是我们的子进程
 *
 * 为什么加上桌面（而不只是开始菜单）：有些程序装完只建了桌面快捷方式，
 * 开始菜单里没有入口（真机上「办公桌面助手」就是这样）。只扫开始菜单会漏掉它们，
 * 用户说「打开办公桌面助手」，管家明明看得见桌面那个图标却说没有，很奇怪。
 */

const CACHE_TTL_MS = 60 * 1000
const MAX_SHORTCUTS = 4000
/**
 * 最多钻进多少层目录。
 *
 * 开始菜单里两三层就到头了，再深是广告和帮助文档；桌面同理。
 * 这个上限主要不是为了"找得准"，而是为了别在用户桌面上某个巨大的项目文件夹里
 * 空转——桌面比开始菜单脏得多，不能假设它小而规整。
 */
const MAX_DEPTH = 4
/** 一次扫描最多打开这么多个目录（防止桌面上的大目录把这一轮拖住） */
const MAX_DIRS = 800

/**
 * 这些词说明这个条目不是"打开程序"：
 * 卸载、修复、更新、帮助文档、官网链接、命令行宿主。
 *
 * 「命令行」那几条是有意的：一个刚读完网页的模型如果能随手拉起一个终端窗口，
 * 等于把"用户会照着念的东西"塞进了他的屏幕（我们在卸载那条路上专门堵过这个）。
 * 加上 AppsFolder 之后条目从 98 涨到 176，多出来的里面就有 `Git Bash`、`Git CMD`、
 * `Windows Terminal`、`WSL` 这些，所以这里补了 `cmd`/`bash`/`terminal`/`wsl`。
 *
 * 这是**拒绝清单**，不是"安全的证明"：它只能挡住已知的坏名字。
 */
const NOT_A_LAUNCH_RE =
  /卸载|uninstall|修复|repair|移除|remove|帮助|help|readme|说明|文档|documentation|手册|manual|许可|licen[cs]e|更新|update|升级|网站|website|网页|主页|homepage|官网|反馈|feedback|日志|report|报告|设置|settings|配置|config|诊断|diagnos|命令行|命令提示符|command prompt|powershell|\bcmd\b|\bbash\b|\bwsl\b|终端|terminal/i

/** 这个条目靠哪条通路启动 */
export type LaunchKind =
  /** .lnk 快捷方式：目标写在文件里，交给外壳 */
  | 'shortcut'
  /** .url Internet 快捷方式：里面是一串协议（steam:// 等），同样交给外壳 */
  | 'url'
  /** 系统应用清单里的条目：用 explorer 打开 shell:AppsFolder\<AppID> */
  | 'apps-folder'

export interface Shortcut {
  /** 用户看到的那一行名字 */
  name: string
  /** .lnk/.url 是文件路径；apps-folder 条目这里放系统给的 AppID */
  path: string
  /** 从哪找到的：查不到东西时排查用，也写进审计 */
  source: 'start-menu' | 'desktop' | 'apps-folder'
  /** 缺省按 .lnk 处理（老调用方不用改） */
  kind?: LaunchKind
}

interface Root {
  dir: string
  source: Shortcut['source']
  /** 最多往下钻几层。桌面的子目录是用户自己的文件夹，不是程序组，不钻 */
  maxDepth: number
}

/**
 * 扫描顺序 = 去重时的优先级（同名只留第一个）。
 *
 * 开始菜单排在桌面前面：同一个程序两边都有时，开始菜单那份是安装程序建的、
 * 跟着程序一起更新；桌面那份常常是用户自己拖出来的副本，或者早就没人管的旧快捷方式。
 */
function shortcutRoots(): Root[] {
  const roots: Root[] = []
  const appData = process.env.APPDATA
  const programData = process.env.ProgramData
  if (appData) {
    roots.push({
      dir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      source: 'start-menu',
      maxDepth: MAX_DEPTH
    })
  }
  if (programData) {
    roots.push({
      dir: path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      source: 'start-menu',
      maxDepth: MAX_DEPTH
    })
  }

  /**
   * 桌面的两个位置都要看：
   *  - `%USERPROFILE%\Desktop` 是用户自己的（真机上的「ChatGPT」「办公桌面助手」在这里）
   *  - `%PUBLIC%\Desktop` 是所有用户共享的（真机上的「哔哩哔哩」「QQ」「微信」在这里）
   * 只看其中一个，就会有一半的桌面图标"看不见"。
   *
   * **maxDepth = 0**：只认桌面上摆着的那一层，不往文件夹里钻。桌面上的文件夹是用户
   * 自己的东西（真机上的 `Agent管家` 一个目录就带 600 多层 node_modules），
   * 钻进去既找不到该打开的"程序"，又会把 MAX_DIRS 的额度在开始菜单之外偷偷吃光——
   * 额度一满，后面的根目录就被静默跳过，表现成"某个明明装着的程序打不开"。
   */
  const publicDir = process.env.PUBLIC
  if (publicDir) roots.push({ dir: path.join(publicDir, 'Desktop'), source: 'desktop', maxDepth: 0 })
  roots.push({ dir: path.join(os.homedir(), 'Desktop'), source: 'desktop', maxDepth: 0 })
  return roots
}

/** 比较用的归一化：大小写、空格、连字符都不该影响"是不是同一个名字" */
export function normalizeLaunchName(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.·]+/g, '')
}

/** 这个快捷方式能不能拿来"打开"（纯函数，单测直接喂名字） */
export function isLaunchableShortcut(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2) return false
  return !NOT_A_LAUNCH_RE.test(trimmed)
}

let cache: { at: number; list: Shortcut[] } | null = null

interface WalkState {
  out: Shortcut[]
  /** 已经打开过多少个目录 */
  dirs: number
  /** 同一个快捷方式被多个根目录看到（比如桌面目录重定向）时的去重 */
  visitedDirs: Set<string>
}

/**
 * 读一个 `.url`（Internet 快捷方式）里写的协议地址。
 *
 * 文件是 INI 样子：`[InternetShortcut]` 下面一行 `URL=steam://rungameid/553640`。
 * 读不出来就返回空串——宁可当它不存在，也不要拿一个空地址去开外壳。
 */
export function readUrlShortcut(filePath: string): string {
  try {
    const text = readFileSync(filePath, 'utf8')
    const match = /^\s*URL\s*=\s*(.+)$/im.exec(text)
    return (match?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * 这个 `.url` 指向的东西算不算"程序"。
 *
 * http/https 是网页，不是程序：用户说"打开某某"时想要的不是浏览器里多一个标签页，
 * 而且提示词里另有 web_fetch 负责取网页内容。其余协议（steam:// 等）是真正的启动器。
 */
export function isLaunchableUrl(url: string): boolean {
  const text = url.trim()
  if (!text) return false
  if (/^https?:\/\//i.test(text)) return false
  // 盘符不是协议：`C:\Windows\notepad.exe` 里的 `C:` 长得像 scheme，
  // 放过去就等于让一个 .url 文件直接指向本机任意 exe。协议名至少两个字符
  if (/^[a-z]:[\\/]/i.test(text)) return false
  return /^[a-z][a-z0-9+.-]+:/i.test(text)
}

function walk(
  dir: string,
  depth: number,
  source: Shortcut['source'],
  maxDepth: number,
  state: WalkState
): void {
  if (depth > maxDepth || state.out.length >= MAX_SHORTCUTS || state.dirs >= MAX_DIRS) return
  // 桌面可能被重定向到同一个位置，别把同一个目录扫两遍
  const key = dir.toLowerCase()
  if (state.visitedDirs.has(key)) return
  state.visitedDirs.add(key)
  state.dirs += 1

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // 目录不存在/没权限都是常态（ProgramData 那侧在精简系统上可能没有；桌面目录也可能被重定向走）
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), depth + 1, source, maxDepth, state)
      continue
    }

    const full = path.join(dir, entry.name)

    if (/\.lnk$/i.test(entry.name)) {
      const name = entry.name.slice(0, -4).trim()
      if (!isLaunchableShortcut(name)) continue
      state.out.push({ name, path: full, source, kind: 'shortcut' })
      continue
    }

    // .url 排在后面：同一个程序两处都有时，.lnk 通常更"贴身"（带工作目录等）
    if (/\.url$/i.test(entry.name)) {
      const name = entry.name.slice(0, -4).trim()
      if (!isLaunchableShortcut(name)) continue
      if (!isLaunchableUrl(readUrlShortcut(full))) continue
      state.out.push({ name, path: full, source, kind: 'url' })
    }
  }
}

/** 开始菜单 + 桌面上的可启动项（60 秒缓存：装机/卸载不常见，列表不长） */
export function listShortcuts(force = false): Shortcut[] {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.list
  const state: WalkState = { out: [], dirs: 0, visitedDirs: new Set() }
  for (const root of shortcutRoots()) walk(root.dir, 0, root.source, root.maxDepth, state)
  const seen = new Set<string>()
  const list = state.out.filter((s) => {
    // 扫到不等于还在：MSIX（Store 应用）的快捷方式由外壳按需生成/回收，
    // 目录里留着、文件却已经没了的那种，点下去只会得到 "Failed to open path"。
    // 真机上「Claude」踩过：开始菜单那份被解析出来，启动时文件已经不在
    if (!existsSync(s.path)) return false
    const key = normalizeLaunchName(s.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  cache = { at: Date.now(), list }
  return list
}

/** 测试用：清掉缓存，免得一条用例的结果漏到下一条 */
export function resetShortcutCache(): void {
  cache = null
  appsCache = null
}

/** 系统的应用清单（`Get-StartApps`）——纯 ASCII，没有外部输入，参数只有输出文件 */
const START_APPS_SCRIPT = `
$list = @()
foreach ($a in @(Get-StartApps)) {
  $list += [pscustomobject]@{ name = [string]$a.Name; id = [string]$a.AppID }
}
@{ apps = $list } | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $Out -Encoding UTF8
`

let appsCache: { at: number; list: Shortcut[] } | null = null

/**
 * 系统应用清单：不建快捷方式的程序都在这儿（豆包、商店应用、各类 UWP）。
 *
 * 代价是一次 PowerShell 启动（数百毫秒），所以它只在前两条通路都没命中时才被调用，
 * 结果单独缓存一分钟。读失败就当空表——打不开一个没快捷方式的程序，
 * 不该演变成"整个打开程序功能坏掉"。
 */
export async function listStartApps(force = false): Promise<Shortcut[]> {
  if (!force && appsCache && Date.now() - appsCache.at < CACHE_TTL_MS) return appsCache.list

  let raw: { apps?: Array<{ name?: string; id?: string }> | { name?: string; id?: string } } = {}
  try {
    const text = await runPs(START_APPS_SCRIPT)
    raw = text ? JSON.parse(text) : {}
  } catch {
    appsCache = { at: Date.now(), list: [] }
    return []
  }

  const items = Array.isArray(raw.apps) ? raw.apps : raw.apps ? [raw.apps] : []
  const list: Shortcut[] = []
  for (const item of items) {
    const name = String(item.name ?? '').trim()
    const id = String(item.id ?? '').trim()
    if (!name || !id) continue
    if (!isLaunchableShortcut(name)) continue
    // 网页不是程序，交给 web_fetch 那条路
    if (/^https?:\/\//i.test(id)) continue
    list.push({ name, path: id, source: 'apps-folder', kind: 'apps-folder' })
  }
  appsCache = { at: Date.now(), list }
  return list
}

export type LaunchPlan =
  | { ok: true; shortcut: Shortcut }
  | { ok: false; reason: string }

/**
 * 解析出**唯一**要打开的程序。
 *
 * 匹配阶梯：名字完全相同 > 名字以它开头 > 名字含它。三级都只认唯一命中，
 * 两个都像就让用户说清楚——"打开微信"打开成「微信输入法」比打不开更糟。
 */
export function planLaunch(name: string, shortcuts: Shortcut[] = listShortcuts()): LaunchPlan {
  const query = normalizeLaunchName(name)
  if (!query) return { ok: false, reason: '没有给出要打开的程序名' }

  const exact = shortcuts.filter((s) => normalizeLaunchName(s.name) === query)
  if (exact.length === 1) return { ok: true, shortcut: exact[0] }

  const prefix = exact.length > 1 ? exact : shortcuts.filter((s) => normalizeLaunchName(s.name).startsWith(query))
  if (prefix.length === 1) return { ok: true, shortcut: prefix[0] }

  const pool =
    prefix.length > 1 ? prefix : shortcuts.filter((s) => normalizeLaunchName(s.name).includes(query))

  if (pool.length === 0) {
    return {
      ok: false,
      reason: `开始菜单和桌面上都没有「${name.trim()}」的快捷方式。不要编一个名字重试；可以先用 list_installed_apps 核对它到底在不在`
    }
  }
  const shown = pool.slice(0, 6).map((s) => s.name).join('、')
  return {
    ok: false,
    reason: `开始菜单和桌面上有 ${pool.length} 个像「${name.trim()}」的：${shown}。不要自己挑一个，把名字说给用户让他确认`
  }
}

/**
 * 用"现在的"清单解析一遍，必要时才去问系统应用清单。
 *
 * 三段各自的理由：
 * - 缓存是 60 秒的，这 60 秒里程序可能刚装上/刚卸掉，也可能某个 MSIX 快捷方式
 *   被外壳收走了 —— 所以命中缓存也要确认文件还在，不在就重扫
 * - 前两条（.lnk / .url）都没命中时，才去问 `Get-StartApps`。豆包这类不建快捷方式
 *   的程序只在那儿。这一步要起一次 PowerShell，不该在每次打开程序时都付
 * - 三段全空 = 真的没有，这时才说"找不到"
 */
export async function resolveLaunch(name: string): Promise<LaunchPlan> {
  const cached = planLaunch(name)
  if (cached.ok && existsSync(cached.shortcut.path)) return cached

  const rescanned = planLaunch(name, listShortcuts(true))
  if (rescanned.ok) return rescanned

  // 歧义就停在这里：系统清单里还有几百条，掺进来只会让候选更难选
  if (rescanned.reason.includes('个像')) return rescanned

  const systemApps = await listStartApps()
  const fromSystem = planLaunch(name, systemApps)
  if (fromSystem.ok) return fromSystem

  // 系统清单里也没有：给用户最好的一条线索（歧义候选 > 原本的"没有"）
  if (fromSystem.reason.includes('个像')) return fromSystem
  return rescanned
}
