import { runPs } from '../src/main/node/ps'

/**
 * 能不能用 UI Automation 把微信的聊天内容读成**文字**。
 *
 * 为什么这个测试是决定性的：长庚的模型**没有视觉能力**——`llm.ts` 里没有任何
 * 图像块，`screen_capture` 只把宽高交给模型。所以"让长庚看微信"这条路
 * 不可能靠截图。唯一的可能是窗口本身把文字暴露在 UI Automation 树里。
 *
 * 为什么按**窗口句柄**而不是按可见窗口枚举：微信平时是最小化的，
 * 而 `listWindows` 过滤掉宽高为 0 的窗口（最小化的就是 0），于是它根本看不见微信。
 * `AutomationElement.FromHandle` 对最小化窗口照样能拿树——这正是这条路
 * 能不能成立的关键：如果连最小化都能读，就不需要把窗口摆到前台。
 */
const FIND_WINDOW = String.raw`
$proc = Get-Process -Name $P1 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
  [IO.File]::WriteAllText($Out, '{"ok":false}', [Text.UTF8Encoding]::new($false))
  return
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json @{ ok = $true; pid = $proc.Id; hwnd = [int64]$proc.MainWindowHandle; title = [string]$proc.MainWindowTitle } -Compress), [Text.UTF8Encoding]::new($false))
`

/**
 * RawView 比 ControlView 深：微信很多自绘控件的文字只在 Raw 树里。
 * 这条注释必须留在 TypeScript 这边——runPs 要求脚本本体纯 ASCII。
 */
const WALK = String.raw`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$P1)
if (-not $el) {
  [IO.File]::WriteAllText($Out, '{"ok":false}', [Text.UTF8Encoding]::new($false))
  return
}
$script:rows = @()
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Walk($node, $depth) {
  if ($depth -gt 14) { return }
  try {
    $c = $node.Current
    $name = [string]$c.Name
    $type = [string]$c.ControlType.ProgrammaticName
    if ($name -and $name.Trim().Length -gt 0) {
      $script:rows += [pscustomobject]@{ d = $depth; t = $type; x = $name }
    }
  } catch { }
  try {
    $child = $walker.GetFirstChild($node)
    while ($child) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }
  } catch { }
}
Walk $el 0
[IO.File]::WriteAllText($Out, (ConvertTo-Json @{ ok = $true; n = $script:rows.Count; rows = $script:rows } -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
`

async function main(): Promise<void> {
  const found = JSON.parse(await runPs(FIND_WINDOW, ['Weixin'])) as {
    ok: boolean
    pid?: number
    hwnd?: number
    title?: string
  }
  if (!found.ok) {
    console.log('没找到微信主窗口（进程名 Weixin）。先打开微信并登录。')
    return
  }
  console.log(`微信：pid=${found.pid} hwnd=${found.hwnd} 标题=${found.title}`)

  const t0 = Date.now()
  const raw = await runPs(WALK, [String(found.hwnd)])
  const ms = Date.now() - t0
  const parsed = JSON.parse(raw) as { ok: boolean; n?: number; rows?: Array<{ d: number; t: string; x: string }> }
  if (!parsed.ok) {
    console.log('❌ FromHandle 拿不到 UI Automation 元素')
    return
  }

  const rows = parsed.rows ?? []
  console.log(`\n耗时 ${ms}ms，读到 ${parsed.n} 个带文字的元素\n`)

  const byType: Record<string, number> = {}
  for (const r of rows) byType[r.t] = (byType[r.t] ?? 0) + 1
  console.log('控件类型分布：')
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${t.replace('ControlType.', '')}: ${n}`)
  }

  console.log('\n前 40 条文字：')
  for (const r of rows.slice(0, 40)) {
    console.log(`  [${r.t.replace('ControlType.', '')}] ${r.x.slice(0, 70)}`)
  }
}

void main().catch((err) => {
  console.error('失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
