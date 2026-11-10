import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'

/**
 * 桌面图标提取。
 *
 * **为什么不用 Electron 的 `app.getFileIcon`**（试过，两个坑）：
 * 1. 直接喂 `.lnk` 拿到的是**通用快捷方式图标**（一张白纸），不是目标程序的图标。
 *    实测四个完全不同的应用返回的 PNG 字节数与像素比例**一模一样**。
 * 2. 改成先解析出目标 exe 再喂 `getFileIcon`，返回的还是同一个通用图标
 *    （745 B，三个不同 exe 完全一致）——在这个进程环境里它拿不到真实图标。
 *
 * **现在用 .NET 的 `Icon.ExtractAssociatedIcon`**：它会穿透 `.lnk` 取到
 * 快捷方式指向的程序图标，和资源管理器里看到的那个一致。
 * 实测五个不同应用返回 1324~2618 B，各不相同，说明确实是各自的图标。
 *
 * **一次调用取全部**，不是每个文件起一次 PowerShell：起进程约 1 秒，
 * 22 个文件就是 22 秒，用户会觉得界面卡死。
 */

/** 批量提取结果：文件路径 → dataURL */
export type IconMap = Map<string, string>

/**
 * 给一组文件批量取图标。
 *
 * 路径通过 UTF-8 临时文件传给 PowerShell，不走命令行参数——
 * 中文路径在 Windows 上过 argv 会被编码毁掉（这个项目已经踩过好几次）。
 */
export async function extractIcons(files: string[]): Promise<IconMap> {
  const map: IconMap = new Map()
  if (files.length === 0) return map

  const stamp = `${process.pid}-${Date.now()}`
  const listFile = path.join(os.tmpdir(), `polar-icon-list-${stamp}.txt`)
  await fs.writeFile(listFile, files.join('\n'), 'utf8')

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$paths = [System.IO.File]::ReadAllLines('${listFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
foreach ($p in $paths) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  try {
    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
    if ($ico -ne $null) {
      $bmp = $ico.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      # 用 | 分隔：base64 里没有 |，路径里可能有制表符不再担心
      Write-Output ($p + '|' + $b64)
      $bmp.Dispose(); $ms.Dispose(); $ico.Dispose()
    }
  } catch { }
}
`
  const out = await new Promise<string>((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout))
    )
  })

  await fs.unlink(listFile).catch(() => undefined)

  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('|')
    if (i <= 0) continue
    const file = line.slice(0, i)
    const b64 = line.slice(i + 1).trim()
    if (!b64) continue
    // 核对确实是 PNG：不核的话，万一 PowerShell 吐了别的东西，
    // 界面上会显示成裂图，比没有图标更让人困惑
    const head = Buffer.from(b64.slice(0, 12), 'base64')
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    if (!isPng) continue
    map.set(file, `data:image/png;base64,${b64}`)
  }
  return map
}

/**
 * 带缓存的图标取用。
 *
 * 缓存键带上**文件修改时间**：程序升级换了图标要能反映出来，
 * 只按路径缓存会一直显示旧图标。
 */
export class IconCache {
  private byFile = new Map<string, { mtime: number; url: string }>()

  /** 给一批文件取图标；命中缓存的直接用，没命中的一次批量补 */
  async get(files: { file: string; mtime: number }[]): Promise<IconMap> {
    const out: IconMap = new Map()
    const missing: string[] = []
    for (const f of files) {
      const hit = this.byFile.get(f.file)
      if (hit && hit.mtime === f.mtime) out.set(f.file, hit.url)
      else missing.push(f.file)
    }
    if (missing.length > 0) {
      const fresh = await extractIcons(missing)
      for (const [file, url] of fresh) {
        const mtime = files.find((f) => f.file === file)?.mtime ?? 0
        this.byFile.set(file, { mtime, url })
        out.set(file, url)
      }
    }
    return out
  }

  clear(): void {
    this.byFile.clear()
  }
}
