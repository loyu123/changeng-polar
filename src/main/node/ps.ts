import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const PS = 'powershell.exe'

/**
 * 运行一段**写死在源码里**的 PowerShell 脚本，结果走临时文件回读（避开控制台编码问题）。
 *
 * 安全约定：
 * - 脚本本体必须是纯 ASCII 且不含任何外部输入，所有参数通过 argv 传入（execFile 数组形式，不经 shell）
 * - 只用于只读读取与明确的受控动作，不接受拼接进来的字符串
 */
export async function runPs(script: string, args: string[] = []): Promise<string> {
  const id = randomUUID()
  const scriptPath = path.join(os.tmpdir(), `butler-${id}.ps1`)
  const outPath = path.join(os.tmpdir(), `butler-${id}.json`)
  const paramList = ['[string]$Out', ...args.map((_, index) => `[string]$P${index + 1}`)].join(', ')
  const body = `param(${paramList})\n$ErrorActionPreference = 'SilentlyContinue'\n${script}\n`
  if (/[^\x00-\x7F]/.test(body)) throw new Error('内部脚本必须保持纯 ASCII')

  await fs.writeFile(scriptPath, body, 'utf8')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        PS,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          outPath,
          ...args
        ],
        { timeout: 90_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err) => (err ? reject(new Error(`PowerShell 执行失败：${err.message}`)) : resolve())
      )
    })
    const raw = await fs.readFile(outPath, 'utf8')
    return raw.replace(/^\uFEFF/, '').trim()
  } finally {
    await Promise.allSettled([fs.unlink(scriptPath), fs.unlink(outPath)])
  }
}

export function parseArray<T>(raw: string): T[] {
  if (!raw || raw === 'null') return []
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed as T[]
  return [parsed as T]
}
