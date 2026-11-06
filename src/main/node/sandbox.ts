import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPs } from './ps'

/**
 * 授权闸门的演练沙箱。
 *
 * 为什么要它：v1.4 要求「闸门先建好、验收通过，才允许出现第一个销毁类工具」。
 * 但没有销毁类工具就无法演示「拦住」与「放行」。所以这里提供一个**作用域被代码写死**的
 * 销毁工具：只能在 %TEMP%\butler-sandbox 里操作，且走系统回收站（可捞回）。
 * 它不是正式的删除能力——正式卸载要等闸门验收通过后再加（v1.4 D7）。
 */
export const SANDBOX_ROOT = path.join(os.tmpdir(), 'butler-sandbox')

export interface SandboxFile {
  name: string
  path: string
  sizeKB: number
  modifiedAt: string
}

function assertInside(filePath: string): string {
  const root = path.resolve(SANDBOX_ROOT)
  const target = path.resolve(filePath)
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(':')) {
    throw new Error(`只允许操作演示沙箱目录内的文件（${root}）`)
  }
  return target
}

export async function ensureSandbox(): Promise<string> {
  await fs.mkdir(SANDBOX_ROOT, { recursive: true })
  return SANDBOX_ROOT
}

export async function listSandbox(): Promise<SandboxFile[]> {
  await ensureSandbox()
  const entries = await fs.readdir(SANDBOX_ROOT, { withFileTypes: true })
  const files: SandboxFile[] = []
  for (const entry of entries) {
    // 不跟随符号链接，避免从沙箱跳到沙箱外
    if (!entry.isFile()) continue
    const full = path.join(SANDBOX_ROOT, entry.name)
    const stat = await fs.stat(full)
    files.push({
      name: entry.name,
      path: full,
      sizeKB: Math.round((stat.size / 1024) * 10) / 10,
      modifiedAt: stat.mtime.toISOString()
    })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

/** 造几个演示文件，方便现场验收「能删、也能拦住」 */
export async function prepareSandbox(): Promise<SandboxFile[]> {
  await ensureSandbox()
  const samples: Array<[string, string]> = [
    ['月度报销单-2026-10.txt', '10 月报销：交通 240，餐饮 380，需在 11/08 前提交。\n'],
    ['会议记录-周会.txt', '周会结论：先把授权闸门做完，再谈删除能力。\n'],
    ['临时导出.csv', 'name,size\nfoo,1\nbar,2\n']
  ]
  for (const [name, content] of samples) {
    const full = path.join(SANDBOX_ROOT, name)
    try {
      await fs.access(full)
    } catch {
      await fs.writeFile(full, content, 'utf8')
    }
  }
  return listSandbox()
}

const RECYCLE_PS = String.raw`
Add-Type -AssemblyName Microsoft.VisualBasic
$p = $P1
if (-not (Test-Path -LiteralPath $p)) {
  [IO.File]::WriteAllText($Out, '{"ok":false,"error":"file not found"}', [Text.UTF8Encoding]::new($false))
  exit 0
}
$item = Get-Item -LiteralPath $p
$info = [pscustomobject]@{
  name        = $item.Name
  sizeBytes   = $item.Length
  lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
}
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
$stillThere = Test-Path -LiteralPath $p
$payload = [pscustomobject]@{
  ok      = (-not $stillThere)
  name    = $info.name
  sizeBytes = $info.sizeBytes
  lastWriteUtc = $info.lastWriteUtc
}
[IO.File]::WriteAllText($Out, ($payload | ConvertTo-Json -Depth 4 -Compress), [Text.UTF8Encoding]::new($false))
`

/**
 * 打不开"还原"就等于骗人：所以撤回落地的位置必须是用户自己能看到的地方。
 * 这里只负责把回收站窗口拉起来，还原动作仍然由用户点。
 */
export function openRecycleBin(): void {
  const child = spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' })
  child.unref()
}

export interface RecycleOutcome {
  ok: boolean
  name: string
  sizeKB: number
  modifiedAt: string
  error?: string
}

/** 删除到回收站（可捞回）。路径必须落在沙箱内。 */
export async function deleteToRecycle(filePath: string): Promise<RecycleOutcome> {
  const target = assertInside(filePath)
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(target)
  } catch {
    // 文件本来就不在：这是"失败"的一种，按返回值报告，别抛给上层——
    // 抛出去会被包装成 "没有执行：ENOENT..."，模型拿到的信息比"文件不存在"更难解释清楚
    return {
      ok: false,
      name: path.basename(target),
      sizeKB: 0,
      modifiedAt: '',
      error: 'file not found'
    }
  }
  if (!stat.isFile()) throw new Error('沙箱里只演示删除单个文件')
  const raw = await runPs(RECYCLE_PS, [target])
  const parsed = JSON.parse(raw || '{}') as {
    ok?: boolean
    error?: string
    name?: string
    sizeBytes?: number
    lastWriteUtc?: string
  }
  if (!parsed.ok) {
    return {
      ok: false,
      name: path.basename(target),
      sizeKB: Math.round((stat.size / 1024) * 10) / 10,
      modifiedAt: stat.mtime.toISOString(),
      error: parsed.error ?? '删除未生效'
    }
  }
  return {
    ok: true,
    name: parsed.name ?? path.basename(target),
    sizeKB: Math.round(((parsed.sizeBytes ?? stat.size) / 1024) * 10) / 10,
    modifiedAt: parsed.lastWriteUtc ?? stat.mtime.toISOString()
  }
}
