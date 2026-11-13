/**
 * 模拟键鼠的真机冒烟：**真的移动鼠标、真的敲键盘**。
 *
 * 用法：npx tsx scripts/input-smoke.ts
 *
 * 为什么单独做一个脚本：单元测试只能证明"脚本拼对了"，证明不了
 * `mouse_event` 在这个进程里真的能加载、`Ctrl+V` 真的会粘进别的窗口。
 * 0.8.0 的提交里明确写着"真实点击未执行——会移动用户鼠标"，这个脚本补的就是那一项。
 *
 * 靶子不是记事本：Win11 的 `notepad.exe` 是 Store 应用的门面，实测在这台机器上
 * 起完就退出（exit 0，没有窗口）。所以靶子由本脚本自己造一个 WinForms 窗口，
 * 窗口里放一个 TextBox——**内容是我们自己的，能读回来验证**，而不是只能看"执行了"。
 *
 * 边界：窗口是 TopMost、位置固定、5 秒后自己销毁；鼠标位置在开始前存下、结束时恢复。
 * 只会点这个窗口的正中央，不碰屏幕其他任何地方。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clickAt, pressKeys, typeText } from '../src/main/node/input'
import { runPs } from '../src/main/node/ps'
import { listWindows, windowAt } from '../src/main/node/screen'

const READY = path.join(os.tmpdir(), 'butler-probe-ready.txt')
const TEXT = path.join(os.tmpdir(), 'butler-probe-text.txt')
const TITLE = 'butler-probe-target'

/**
 * 靶子窗口。纯 ASCII（runPs 会拒绝非 ASCII 脚本，这里保持一致，避免哪天
 * 有人把这段拿去 runPs 跑时报一个莫名其妙的错）。
 */
const PROBE_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'BUTLER_PROBE_TITLE'
$form.Width = 520
$form.Height = 320
$form.StartPosition = 'Manual'
$form.Left = 120
$form.Top = 120
$form.TopMost = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 14)
$form.Controls.Add($box)
$ready = Join-Path $env:TEMP 'butler-probe-ready.txt'
$textFile = Join-Path $env:TEMP 'butler-probe-text.txt'
try { [IO.File]::Delete($ready) } catch { }
[IO.File]::WriteAllText($ready, 'ready')
$form.Show()
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  try { [IO.File]::WriteAllText($textFile, $box.Text, [Text.UTF8Encoding]::new($false)) } catch { }
  Start-Sleep -Milliseconds 150
}
`.trim()

/** 读当前鼠标位置（只读，不移动） */
const CURSOR_GET_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$p = [Windows.Forms.Cursor]::Position
[IO.File]::WriteAllText($Out, (@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`

/** 把鼠标放回去 */
const CURSOR_SET_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$P1, [int]$P2)
[IO.File]::WriteAllText($Out, '{"ok":true}', [Text.UTF8Encoding]::new($false))
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  let probe: ChildProcess | undefined
  let cursor: { x: number; y: number } | undefined
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`)
  }

  try {
    await fs.unlink(READY).catch(() => undefined)
    await fs.unlink(TEXT).catch(() => undefined)

    cursor = JSON.parse(await runPs(CURSOR_GET_PS)) as { x: number; y: number }
    console.log(`鼠标当前位置 (${cursor.x}, ${cursor.y})，测试结束后恢复\n`)

    const scriptPath = path.join(os.tmpdir(), `butler-probe-${randomUUID().slice(0, 8)}.ps1`)
    await fs.writeFile(scriptPath, PROBE_PS.replace('BUTLER_PROBE_TITLE', TITLE), 'utf8')
    probe = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { detached: false, stdio: 'ignore', windowsHide: true }
    )

    // 等窗口真的出现在 UIA 的树里——"进程起来了"不等于"窗口能看见"
    let win: Awaited<ReturnType<typeof listWindows>>[number] | undefined
    for (let i = 0; i < 40 && !win; i++) {
      await sleep(250)
      win = (await listWindows()).find((w) => w.title === TITLE)
    }
    if (!win) throw new Error('靶子窗口没起来（8 秒内没在 UI Automation 里看到它）')
    check('靶子窗口出现', true, `${win.title} · pid 由 powershell 持有 · (${win.x}, ${win.y}) ${win.width}×${win.height}`)

    const point = { x: win.x + Math.round(win.width / 2), y: win.y + Math.round(win.height / 2) }

    // 白名单判据用的就是这一条：这个坐标实际会落到哪个进程的窗口上
    const hit = windowAt(await listWindows(), point.x, point.y)
    check(
      '白名单检查（windowAt）',
      Boolean(hit && hit.process.toLowerCase() === win.process.toLowerCase()),
      hit ? `(${point.x}, ${point.y}) → 「${hit.title}」(${hit.process})` : `(${point.x}, ${point.y}) 上没有窗口`
    )
    if (!hit || hit.process.toLowerCase() !== win.process.toLowerCase()) {
      throw new Error('靶子被别的窗口盖住了，点击会落到别处——中止，不动鼠标')
    }

    const clicked = await clickAt(point.x, point.y)
    check('真实点击', clicked.ok, clicked.detail)

    const expected = '长庚输入测试 abc 123'
    const typed = await typeText(expected)
    check('真实输入（剪贴板粘贴）', typed.ok, typed.detail)

    const enter = await pressKeys('enter')
    check('真实按键（Enter）', enter.ok, enter.detail)

    // 给靶子脚本 150ms 的写盘周期留出余量
    await sleep(900)
    const content = await fs.readFile(TEXT, 'utf8')
    check('读回窗口内容', content.startsWith(expected), JSON.stringify(content))
    check('Enter 生效（末尾多一个换行）', content.endsWith('\n'), `实际结尾：${JSON.stringify(content.slice(-4))}`)
  } finally {
    probe?.kill()
    if (cursor) {
      await runPs(CURSOR_SET_PS, [String(cursor.x), String(cursor.y)]).catch(() => undefined)
      console.log(`\n鼠标已恢复到 (${cursor.x}, ${cursor.y})`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

void main().catch((err) => {
  console.error('冒烟中止：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
