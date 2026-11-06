import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveUninstallEntries, type UninstallEntry } from './registry'

/**
 * 卸载：只做「识别 → 拉起程序自己的卸载程序」，不做静默卸载。
 *
 * 边界（改之前先看这几条）：
 * - 名字必须与注册表 DisplayName 完全一致，不做模糊匹配：模糊匹配会挑错程序
 * - 同名多条（多版本 / 32-64 位）不猜，直接拒绝，让用户自己处理
 * - 系统组件不卸
 * - 只执行「.exe + 参数」形式的命令行，且 exe 必须真实存在；
 *   cmd / powershell / mshta 这类脚本包装一律拒绝（那等于执行任意字符串）
 * - 启动后不等待退出：卸载由那个窗口完成，应用不代用户点"下一步"
 */

export interface ParsedCommand {
  exe: string
  args: string[]
}

/** 这些宿主程序会把后面的字符串当脚本执行，等于绕过我们的"只启动 exe"约定 */
const SCRIPT_HOSTS = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe'
])

function tokenize(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** 解析失败返回原因字符串，成功返回可执行命令 */
export function parseUninstallCommand(raw: string): ParsedCommand | string {
  const command = raw.trim()
  if (!command) return '命令为空'

  let exe = ''
  let rest = ''
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1)
    if (end < 0) return '引号没有闭合'
    exe = command.slice(1, end)
    rest = command.slice(end + 1).trim()
  } else {
    const tokens = command.split(/\s+/)
    if (tokens.length === 1) {
      exe = command
    } else {
      // 无引号且带空格（如 C:\Program Files\NetEase\...\Uninstall.exe /S）：
      // 不能按第一个空格截断——那会把 exe 截成 C:\Program（真机踩过）。
      // 从最长组合往短试，第一个「真实存在的 .exe」就是卸载程序
      let matched = false
      for (let i = tokens.length; i >= 1; i--) {
        const candidate = tokens.slice(0, i).join(' ')
        if (!/\.exe$/i.test(candidate)) continue
        if (!existsSync(candidate)) continue
        exe = candidate
        rest = tokens.slice(i).join(' ')
        matched = true
        break
      }
      if (!matched) {
        // 磁盘上不存在：退回「以 .exe 结尾的最长组合」，让后面的存在性检查给出准确报错
        for (let i = tokens.length; i >= 1; i--) {
          const candidate = tokens.slice(0, i).join(' ')
          if (/\.exe$/i.test(candidate)) {
            exe = candidate
            rest = tokens.slice(i).join(' ')
            break
          }
        }
      }
    }
  }

  if (!exe) {
    // 整串里找不到 .exe：可能是 .bat/.vbs 之类，也可能是纯参数。
    // 说"没有可执行文件"会误导——把实际是什么说出来，用户才知道该怎么办
    const head = command.split(/\s+/)[0]
    return /[\\/]/.test(head) ? `不是 .exe：${head}` : '没有可执行文件'
  }
  if (!/\.exe$/i.test(exe)) return `不是 .exe：${exe}`
  const base = path.basename(exe).toLowerCase()
  if (SCRIPT_HOSTS.has(base)) return `是脚本宿主（${base}），等于执行任意命令，不做`
  if (!existsSync(exe)) return `卸载程序不在原位置：${exe}`

  return { exe, args: rest ? tokenize(rest) : [] }
}

export type UninstallPlan =
  | { ok: true; entry: UninstallEntry; command: ParsedCommand }
  | { ok: false; reason: string }

/** 解析出**唯一**的卸载目标；拿不到唯一目标就拒绝，不猜 */
export async function planUninstall(name: string): Promise<UninstallPlan> {
  const target = name.trim()
  if (!target) return { ok: false, reason: '没有给出要卸载的程序名' }

  const entries = await resolveUninstallEntries(target)
  if (entries.length === 0) {
    return {
      ok: false,
      reason: `注册表里没有名称完全等于「${target}」的卸载项。名称必须与「已安装程序」里的一致，先用 list_installed_apps 核对（模糊记忆的名字不算）`
    }
  }
  if (entries.length > 1) {
    const list = entries
      .map((e) => `${e.version || '版本未知'}（${e.scope === 'machine' ? '本机' : '当前用户'} · ${e.arch} 位 · 键 ${e.key}）`)
      .join('；')
    return {
      ok: false,
      reason: `「${target}」在注册表里有 ${entries.length} 条卸载项，无法确定卸哪个：${list}。这种情况让用户自己在「设置 → 应用」里处理`
    }
  }

  const entry = entries[0]
  if (entry.systemComponent === 1) return { ok: false, reason: `「${entry.name}」被注册表标记为系统组件，不卸载` }
  if (!entry.uninstallString.trim()) {
    return {
      ok: false,
      reason: entry.quietUninstallString.trim()
        ? `「${entry.name}」只登记了静默卸载命令，无法让你在窗口里确认，不做`
        : `「${entry.name}」没有登记卸载命令，只能由用户手动处理`
    }
  }

  const parsed = parseUninstallCommand(entry.uninstallString)
  if (typeof parsed === 'string') return { ok: false, reason: `「${entry.name}」的卸载命令不能安全执行：${parsed}` }

  return { ok: true, entry, command: parsed }
}

/** 拉起卸载程序；不等待退出，也不代用户点确认 */
export function launchUninstaller(exe: string, args: string[]): { ok: boolean; detail?: string } {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
