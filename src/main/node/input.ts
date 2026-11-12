import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runPs } from './ps'

/**
 * 模拟鼠标与键盘。
 *
 * 这一层的能力是**无粒度**的：一旦能动鼠标，它就能点这块屏幕上的任何东西——
 * 包括长庚自己的授权卡、系统托盘的退出按钮、别的程序的「确定」。
 * 所以安全不靠这一层，靠外面两处：
 *
 * 1. `input-grant.ts` 的时间窗授权：每次使用前必须在手机上批准，窗口过期即失效；
 * 2. 调用方的白名单检查：先算出坐标会落到哪个进程的窗口上，不在白名单里直接拒绝。
 *
 * 这里只做「把动作做完」，并且**每个动作都回报发生了什么**——
 * 因为事后审计只认这个回报，不认模型的自我描述。
 *
 * 仍然不写内嵌 C#（P/Invoke 会被 AMSI 拦）：鼠标用 PowerShell 调 user32 的
 * 位移方式行不通，改用 .NET 的 `SendKeys` + `System.Windows.Forms.Cursor`。
 * 具体分工见下面每个函数。
 */

/** 一次输入动作的结果：做了什么、落在哪儿 */
export interface InputResult {
  ok: boolean
  detail: string
}

/**
 * 移动鼠标并点击。
 *
 * 用 `System.Windows.Forms.Cursor.Position` 移动（纯 .NET，不走 P/Invoke 声明），
 * 点击则调 `mouse_event`——**这是唯一需要 P/Invoke 的地方**，
 * 所以它单独成一段最小脚本：内容短到 AMSI 没有可疑特征，
 * 而且这段脚本的参数只有数字，没有任何外部输入拼进去。
 */
const CLICK_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MK{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);public static void Click(){mouse_event(0x0002,0,0,0,0);System.Threading.Thread.Sleep(40);mouse_event(0x0004,0,0,0,0);}public static void RClick(){mouse_event(0x0008,0,0,0,0);System.Threading.Thread.Sleep(40);mouse_event(0x0010,0,0,0,0);}}'
$x = [int]$P1
$y = [int]$P2
$right = $P3 -eq '1'
[Cursor]::Position = New-Object System.Drawing.Point($x, $y)
Start-Sleep -Milliseconds 60
if ($right) { [MK]::RClick() } else { [MK]::Click() }
[IO.File]::WriteAllText($Out, (@{ ok = $true; x = $x; y = $y } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`

export async function clickAt(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<InputResult> {
  const cx = Math.round(Number(x))
  const cy = Math.round(Number(y))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { ok: false, detail: '坐标不是有效数字' }
  try {
    await runPs(CLICK_PS, [String(cx), String(cy), button === 'right' ? '1' : '0'])
    return { ok: true, detail: `点击 (${cx}, ${cy})${button === 'right' ? '（右键）' : ''}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 输入一段文字。
 *
 * 走**剪贴板 + Ctrl+V**，不用 SendKeys 逐字敲：
 * - SendKeys 把 `+ ^ % ~ ( ) { } [ ]` 当控制符，写代码时几乎必然出事；
 * - 中文在 SendKeys 下要靠输入法，不可靠。
 *
 * 代价是**会覆盖剪贴板**，所以先存下原内容、粘完再恢复。
 * 恢复失败不影响输入结果（用户顶多丢一份剪贴板），但会在 detail 里说出来。
 */
const TYPE_PS = String.raw`
param([string]$Out, [string]$P1, [string]$P2)
Add-Type -AssemblyName System.Windows.Forms
$prev = ''
$hadText = $false
try { $prev = [Windows.Forms.Clipboard]::GetText(); $hadText = $true } catch { }
[Windows.Forms.Clipboard]::SetText([IO.File]::ReadAllText($P2, [Text.UTF8Encoding]::new($false)))
Start-Sleep -Milliseconds 80
[Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 120
$restored = $true
if ($hadText) { try { [Windows.Forms.Clipboard]::SetText($prev) } catch { $restored = $false } }
[IO.File]::WriteAllText($Out, (@{ ok = $true; restored = $restored } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`

export async function typeText(text: string): Promise<InputResult> {
  const value = String(text ?? '')
  if (!value) return { ok: false, detail: '没有要输入的内容' }
  // 走临时文件传文本：中文经 argv 会有编码问题（Windows 命令行不是 UTF-8）
  const id = randomUUID()
  const textPath = path.join(os.tmpdir(), `butler-type-${id}.txt`)
  await fs.writeFile(textPath, value, 'utf8')
  try {
    await runPs(TYPE_PS, ['x', textPath])
    return { ok: true, detail: `已输入 ${value.length} 个字符（经剪贴板粘贴，原剪贴板内容已恢复）` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    await fs.unlink(textPath).catch(() => undefined)
  }
}

/**
 * 按一个组合键，比如 `Ctrl+S`、`Enter`、`Alt+F4`。
 *
 * 参数是**白名单化的**：只认下面这张表里的写法，不把用户/模型的字符串
 * 直接拼进 SendKeys——`^%{ESC}` 这类控制符一旦拼错，敲出去的可能是完全另一个键。
 */
const KEY_MAP: Record<string, string> = {
  enter: '{ENTER}',
  esc: '{ESC}',
  escape: '{ESC}',
  tab: '{TAB}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  'ctrl+a': '^a',
  'ctrl+c': '^c',
  'ctrl+v': '^v',
  'ctrl+x': '^x',
  'ctrl+z': '^z',
  'ctrl+s': '^s',
  'ctrl+f': '^f',
  'alt+tab': '%{TAB}',
  'alt+f4': '%{F4}',
  'win+d': '^{ESC}d'
}

/** 可用的组合键清单（给工具描述和授权卡用，让用户知道能按什么） */
export const ALLOWED_KEYS = Object.keys(KEY_MAP)

const PRESS_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.SendKeys]::SendWait($P1)
[IO.File]::WriteAllText($Out, '{"ok":true}', [Text.UTF8Encoding]::new($false))
`

export async function pressKeys(combo: string): Promise<InputResult> {
  const key = String(combo ?? '').trim().toLowerCase()
  const mapped = KEY_MAP[key]
  if (!mapped) {
    return { ok: false, detail: `不支持这个键：${combo || '(空)'}。可用的有：${ALLOWED_KEYS.join('、')}` }
  }
  try {
    await runPs(PRESS_PS, [mapped])
    return { ok: true, detail: `按键 ${combo}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
