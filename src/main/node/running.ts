import path from 'node:path'
import { runPs } from './ps'

/**
 * 「这个程序是不是已经开着了」。
 *
 * 为什么需要它：用户说「打开哔哩哔哩」时，如果它已经开着，再启动一次要么多出一个窗口，
 * 要么什么都看不见（单实例程序会把旧窗口顶上来）——用户那边看到的是"没反应"，
 * 于是再点一次，越点越乱。先问一句"它开着吗"，比事后道歉便宜得多。
 *
 * 判断口径故意保守：**只认完全同名**，不做包含匹配。
 * 宁可漏判（当它没开、照常打开）也不要误判——把一个其实没开的程序说成"已经开着"，
 * 用户连点都点不开，比多开一个窗口糟得多。所以 `Code` 绝不会匹配到 `CodeBuddy`。
 */

/** 一次探查同时拿到两样东西：快捷方式指向的 exe，以及当前进程表 */
export interface LaunchProbe {
  /** 快捷方式里写的目标 exe；MSIX 包（Store 应用）这类快捷方式这里是空的 */
  targetPath: string
  processes: RunningProcess[]
}

export interface RunningProcess {
  pid: number
  /** 进程名，不带 .exe（Windows 上就是 exe 的文件名主体） */
  name: string
  /** 有可见窗口才有；最小化在托盘的后台进程是空 */
  windowTitle: string
  /** 主窗口句柄，0 表示没有可见窗口 */
  windowHandle: number
  /** exe 的完整路径；没有权限读到的进程是空字符串 */
  exePath: string
}

interface RawProbe {
  targetPath?: string
  processes?: Array<{
    pid?: number
    name?: string
    title?: string
    handle?: number
    path?: string
  }>
}

/**
 * 脚本必须纯 ASCII（runPs 会检查），参数走 argv 不拼字符串。
 * 目标路径和进程表一起取：这两件事每次启动都要问，分成两次 PowerShell
 * 就是多等一个进程启动的时间（约 300~500ms），而用户已经说完"打开它"了。
 */
const PROBE_SCRIPT = `
$sh = New-Object -ComObject WScript.Shell
$target = ''
try { $target = $sh.CreateShortcut($P1).TargetPath } catch { $target = '' }
$list = @()
foreach ($p in @(Get-Process)) {
  $title = ''
  $handle = 0
  $exe = ''
  try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
  try { $handle = [int64]$p.MainWindowHandle } catch { $handle = 0 }
  try { $exe = [string]$p.Path } catch { $exe = '' }
  $list += [pscustomobject]@{
    pid = [int]$p.Id
    name = [string]$p.ProcessName
    title = $title
    handle = $handle
    path = $exe
  }
}
$payload = @{ targetPath = [string]$target; processes = $list }
$payload | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $Out -Encoding UTF8
`

export async function probeLaunch(lnkPath: string): Promise<LaunchProbe> {
  let raw: RawProbe = {}
  try {
    const text = await runPs(PROBE_SCRIPT, [lnkPath])
    raw = text ? (JSON.parse(text) as RawProbe) : {}
  } catch {
    // 读不到进程表不该挡住"打开程序"这件正事：当成"没开过"照常启动
    return { targetPath: '', processes: [] }
  }
  const processes = (Array.isArray(raw.processes) ? raw.processes : raw.processes ? [raw.processes] : [])
    .map((p) => ({
      pid: Number(p.pid ?? 0),
      name: String(p.name ?? ''),
      windowTitle: String(p.title ?? ''),
      windowHandle: Number(p.handle ?? 0),
      exePath: String(p.path ?? '')
    }))
    .filter((p) => p.pid > 0 && p.name)
  return { targetPath: String(raw.targetPath ?? ''), processes }
}

/** 比较用的归一化：大小写、空格、连字符、`.exe` 都不该影响"是不是同一个" */
export function normalizeAppName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[\s\-_.·]+/g, '')
}

/**
 * 已知的「AppID 包名 → 进程名」对应表。
 *
 * 为什么需要这张表：apps-folder 的 AppID 长这样 `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`，
 * 而进程名是 `Notepad`。两者之间没有可靠的通用换算规则（包名可以随便起），
 * 所以只对**确知的几个**做映射，其余仍退回按显示名匹配。
 *
 * 加这一条的直接原因：真机上模型为了"确保记事本开着"反复调 launch_app，
 * 每次都开一个新窗口，最后把真正输入了内容的那个挤没了。
 * 根因是 apps-folder 条目跳过了"已经开着就别再开"的检查。
 */
const APPID_PROCESS_HINTS: Record<string, string> = {
  // 包名小写 → 进程名
  'microsoft.windowsnotepad': 'notepad',
  'microsoft.windowscalculator': 'calculatorapp',
  'microsoft.windowsterminal': 'windowsterminal',
  'microsoft.paint': 'mspaint',
  'microsoft.screensketch': 'snippingtool',
  'microsoft.windows.photos': 'photos',
  'microsoft.windowscamera': 'windowscamera',
  'microsoft.zunemusic': 'music.ui',
  'microsoft.windowsstore': 'winstore.app'
}

/**
 * 从 AppID 里取进程名线索。
 *
 * `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App` → `microsoft.windowsnotepad`
 * 注意**只取到第一个下划线之前**：后面那串是包发布者哈希，取进来会变成无意义的键；
 * 也不能整串丢进 basename，那会得到 "Microsoft"（能匹配一堆东西）。
 */
export function processHintFromAppId(appId: string): string[] {
  const raw = String(appId ?? '').trim()
  if (!raw) return []
  // `!App` / `!MicrosoftEdge` 这类是入口名，去掉
  const pkg = raw.split('!')[0] ?? ''
  // 下划线后面是 PublisherId（哈希），不是包名的一部分
  const name = pkg.split('_')[0]?.toLowerCase() ?? ''
  if (!name) return []
  const hint = APPID_PROCESS_HINTS[name]
  // 只返回**确知**的进程名。没有映射就返回空——宁可多开一个窗口，
  // 也不要拿包名去猜进程名，猜错会说"已经开着"而用户看不到任何窗口。
  return hint ? [normalizeAppName(hint)] : []
}

/**
 * 一个程序可能对应哪些进程名。
 *
 * 两条来源都给：快捷方式上写的名字（`微信`），和它真正指向的 exe 名（`Weixin`）。
 * 只取其中一条会漏——中文名的程序，进程名常常是拉丁字母。
 *
 * apps-folder 条目的 `path` 是 AppID（`Microsoft.WindowsCalculator_...!App`），
 * 不是文件路径，对它做 basename 会得出 "Microsoft" 这种能匹配一堆东西的键。
 * 所以这类不走路径那一条，改走 `processHintFromAppId`（只认确知的映射）。
 */
export function appIdentity(
  shortcut: { name: string; path: string; kind?: string },
  targetPath: string
): string[] {
  const keys = new Set<string>()
  const byName = normalizeAppName(shortcut.name)
  if (byName) keys.add(byName)
  if (shortcut.kind === 'apps-folder') {
    // AppID 里能推出进程名时一起用上，这样「记事本已经开着」才认得出来
    for (const hint of processHintFromAppId(shortcut.path)) keys.add(hint)
    return [...keys]
  }

  const fromTarget = targetPath ? normalizeAppName(path.basename(targetPath)) : ''
  if (fromTarget) keys.add(fromTarget)
  const fromLnk = normalizeAppName(path.basename(shortcut.path, path.extname(shortcut.path)))
  if (fromLnk) keys.add(fromLnk)
  return [...keys]
}

/**
 * 在进程表里找那个"用户正看着"的窗口。
 *
 * **只认有可见窗口的进程**。同名的后台进程常常是一堆残留（Electron 的渲染进程、
 * 托盘常驻、更新器），它们开着并不等于用户"看见了"——把这种情况报成"已经打开了"
 * 会让用户对着空屏幕找不到东西。所以宁可多启动一次，也不把看不见的进程算成开着。
 */
export function findOpenWindow(
  processes: RunningProcess[],
  keys: string[]
): RunningProcess | null {
  if (keys.length === 0) return null
  const wanted = new Set(keys)
  return (
    processes.find(
      (p) =>
        p.windowHandle > 0 &&
        (wanted.has(normalizeAppName(p.name)) ||
          (p.exePath !== '' && wanted.has(normalizeAppName(path.basename(p.exePath)))))
    ) ?? null
  )
}

/**
 * 把已经开着的窗口调到前面来。
 *
 * 单独一次 PowerShell：只有真的发现它开着才需要，正常启动的路径不多付这份时间。
 * 调不动（窗口在另一个虚拟桌面、被系统拦下）不要紧，调用方会照实说"它在运行"。
 */
const FOCUS_SCRIPT = `
Add-Type -Namespace Butler -Name Win -MemberDefinition @"
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
$result = '{"ok":false,"why":"refused"}'
$p = Get-Process -Id ([int]$P1) -ErrorAction SilentlyContinue
if ($p -eq $null) {
  $result = '{"ok":false,"why":"process-gone"}'
} else {
  $h = [IntPtr]([int64]$p.MainWindowHandle)
  if ($h -eq [IntPtr]::Zero) {
    $result = '{"ok":false,"why":"no-window"}'
  } else {
    [void][Butler.Win]::ShowWindow($h, 9)
    if ([Butler.Win]::SetForegroundWindow($h)) { $result = '{"ok":true}' }
  }
}
$result | Set-Content -LiteralPath $Out -Encoding UTF8
`

export async function focusProcessWindow(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const text = await runPs(FOCUS_SCRIPT, [String(pid)])
    return JSON.parse(text).ok === true
  } catch {
    return false
  }
}
