import { describe, expect, it } from 'vitest'
import { runPs } from '../../src/main/node/ps'

/**
 * 探测：模拟输入的 P/Invoke 在这台机器上能不能加载。
 *
 * 背景：截图那条路已经因为 AMSI 判 `ScriptContainedMaliciousContent` 走不通了
 * （`System.Drawing.CopyFromScreen`）。模拟点击同样要 P/Invoke（`mouse_event`），
 * 如果也被拦，整个「真实点击」方案就得推翻，改走 UI Automation 的 Invoke——
 * 那个不需要 P/Invoke，但只能作用于支持 Invoke 模式的控件。
 *
 * 这个测试**只加载类型、不真的动鼠标**：加载成功就说明这条路通，
 * 真正点击留给集成测试和人工验证。
 */
const hasDisplay = process.platform === 'win32' && Boolean(process.env.SESSIONNAME)

const PROBE = String.raw`
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Probe{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}'
$exists = [bool]([Probe].GetMethod('mouse_event'))
[IO.File]::WriteAllText($Out, (@{ loaded = $exists } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`

describe.skipIf(!hasDisplay)('真机 · 模拟输入的 P/Invoke 可用性', () => {
  it('user32 的 mouse_event 能被加载（不调用）', async () => {
    const raw = await runPs(PROBE)
    const o = JSON.parse(raw) as { loaded: boolean }
    expect(o.loaded).toBe(true)
  }, 30_000)
})
