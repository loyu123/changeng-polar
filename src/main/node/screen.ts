import { runPs } from './ps'

/**
 * 屏幕截图与窗口查询。
 *
 * 为什么截图是这套功能的**前置条件**而不是附加功能：
 * 远程授权卡上如果只写「点击 (1240, 460)」，用户批准的是一个他自己看不见的坐标——
 * 那里可能是「保存」，也可能是「格式化」。签得再勤也等于没签。
 * 所以卡上必须带一张当前屏幕，并标出要点的位置。
 *
 * 窗口枚举走 .NET 的 UI Automation，**不写内嵌 C#**：
 * `Add-Type -TypeDefinition`（P/Invoke）会触发 AMSI 扫描，实测直接被安全软件
 * 拦成 `ScriptContainedMaliciousContent`，脚本根本跑不起来。
 *
 * 截图**不在这个文件里**：`System.Drawing.CopyFromScreen` 同样被 AMSI 拦
 * （屏幕抓取是敏感操作），改用 Electron 自带的 desktopCapturer，见 `capture.ts`。
 */

export interface WinInfo {
  title: string
  /** 进程名（不带 .exe），白名单按它匹配；标题可以被网页改写，进程名不能 */
  process: string
  /** 窗口矩形（屏幕坐标） */
  x: number
  y: number
  width: number
  height: number
}

/**
 * 截一张全屏（含所有显示器），缩到 `targetWidth` 宽再编码成 JPEG。
 *
 * 缩小是有意的：手机流量和授权卡的显示面积都有限，原尺寸 4096×1152 的 PNG
 * 有几 MB，而标一个点击位置不需要那个精度。**缩放比例会返回给调用方**，
 * 标记位置时要用它把屏幕坐标换算成图片坐标，否则标记会画在错误的地方。
 */
/**
 * 列出可见的顶层窗口。
 *
 * 走 UI Automation（.NET 自带），不写 P/Invoke——见文件头的说明。
 * `BoundingRectangle` 给的是屏幕坐标，正好和鼠标坐标同一套。
 */
const WINS_PS = String.raw`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$rows = @()
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
  try {
    $cur = $w.Current
    $r = $cur.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $proc = ''
    try { $proc = (Get-Process -Id $cur.ProcessId -ErrorAction Stop).ProcessName } catch { $proc = '' }
    $rows += [pscustomobject]@{
      title   = [string]$cur.Name
      process = [string]$proc
      x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height
    }
  } catch { }
}
[IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json -Depth 3 -Compress), [Text.UTF8Encoding]::new($false))
`

export async function listWindows(): Promise<WinInfo[]> {
  const raw = await runPs(WINS_PS)
  if (!raw || raw === 'null') return []
  const parsed = JSON.parse(raw) as WinInfo[] | WinInfo
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter((w) => w && w.width > 0 && w.height > 0)
}

/**
 * 某个屏幕坐标落在哪个窗口里。
 *
 * 取**第一个命中的**——UI Automation 的 Children 顺序基本就是 Z 序，
 * 判断"点这里会点到谁"，被盖住的窗口不该算数。
 * 这个函数是白名单检查的依据：模型说要点的位置，实际会落到哪个进程的窗口上。
 */
export function windowAt(windows: WinInfo[], x: number, y: number): WinInfo | null {
  for (const w of windows) {
    if (x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height) return w
  }
  return null
}
