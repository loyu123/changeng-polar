import { promises as fs } from 'node:fs'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'

/**
 * 桌面应用：只列**桌面上实际显示的那些**。
 *
 * 为什么不做成"注册表里所有已安装程序"：那有 129 条，绝大多数用户根本不认识
 * （运行库、驱动、系统组件）。桌面是用户自己摆过的地方，那里有什么就是什么。
 *
 * 三个必须守住的点：
 * 1. **两个桌面都要看**：用户桌面（`~/Desktop`）+ 公共桌面（`C:\Users\Public\Desktop`），
 *    只扫前者会漏掉装给所有用户的快捷方式。
 * 2. **图标用应用自己的**：`app.getFileIcon()` 拿的是系统给这个 .lnk 解析出的
 *    真实图标（和资源管理器里显示的一致），而不是我们先前的首字母色块。
 *    拿不到就如实不给图标，由界面退化成一个灰底占位——不编一个假图标。
 * 3. **随桌面变化**：桌面是用户会随时动的地方（下载完拖一个上去、卸载后删掉）。
 *    所以这里不缓存，并且提供一个 watch 让主进程盯着两个桌面目录。
 */

export interface DesktopApp {
  /** 稳定的标识：快捷方式文件名（同名不同目录时带上来源） */
  key: string
  /** 显示名：快捷方式去掉扩展名 */
  name: string
  /** 快捷方式绝对路径（点开时用它） */
  lnkPath: string
  /** 解析出的目标（exe 或文件夹），解析不到为 undefined */
  target?: string
  /** 图标 dataURL（png）。取不到就没有这个字段 */
  icon?: string
  /** 来自哪个桌面 */
  from: 'user' | 'public'
  /** 排序用：修改时间越新越靠前 */
  mtime: number
}

/** 桌面目录（两个：用户 + 公共） */
export function desktopDirs(): { dir: string; from: 'user' | 'public' }[] {
  const out: { dir: string; from: 'user' | 'public' }[] = []
  const user = path.join(os.homedir(), 'Desktop')
  out.push({ dir: user, from: 'user' })
  // 公共桌面：装给所有用户的程序，快捷方式落在这儿
  const pub = process.env.PUBLIC
    ? path.join(process.env.PUBLIC, 'Desktop')
    : path.join('C:\\Users\\Public', 'Desktop')
  if (pub && path.resolve(pub) !== path.resolve(user)) out.push({ dir: pub, from: 'public' })
  return out
}

/** 桌面上的哪些东西算"应用"：快捷方式、网址快捷方式、直接摆着的 exe/msi */
const APP_EXT = new Set(['.lnk', '.url', '.exe', '.appref-ms'])

/**
 * 列表：只读扩展名匹配的文件，不递归（桌面就是一层）。
 *
 * 不缓存：桌面随时会变，缓存反而会出现"刚拖上去的看不见"。
 * 一次 readdir + 每个文件一次 stat，几毫秒的事。
 */
export async function listDesktopApps(): Promise<DesktopApp[]> {
  const seen = new Map<string, DesktopApp>()

  for (const { dir, from } of desktopDirs()) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue // 目录不存在（比如没有公共桌面）
    }
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase()
      if (!APP_EXT.has(ext)) continue
      // 跳过隐藏/系统残留
      if (name.startsWith('.') || name.startsWith('~$')) continue
      const full = path.join(dir, name)
      let mtime = 0
      try {
        const st = await fs.stat(full)
        if (!st.isFile()) continue
        mtime = st.mtimeMs
      } catch {
        continue
      }
      const key = `${from}:${name}`
      seen.set(key, {
        key,
        name: path.basename(name, ext),
        lnkPath: full,
        from,
        mtime
      })
    }
  }

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return Promise.all(list.map(async (a) => ({ ...a, icon: await iconOf(a.lnkPath) })))
}

/**
 * 取系统给这个快捷方式解析出的真实图标。
 *
 * `app.getFileIcon` 会走到 shell 的图标解析（和资源管理器同一个来源），
 * 所以 .lnk 拿到的是**目标程序的图标**，不是"快捷方式箭头"。
 * 拿不到就返回 undefined —— 界面退化成占位，不编。
 */
const iconCache = new Map<string, string | null>()

export async function iconOf(filePath: string): Promise<string | undefined> {
  const hit = iconCache.get(filePath)
  if (hit !== undefined) return hit ?? undefined
  try {
    const img = await app.getFileIcon(filePath, { size: 'large' })
    if (img.isEmpty()) {
      iconCache.set(filePath, null)
      return undefined
    }
    const url = img.toDataURL()
    iconCache.set(filePath, url)
    return url
  } catch {
    iconCache.set(filePath, null)
    return undefined
  }
}

/** 图标缓存按路径+修改时间失效：程序换了版本图标会变 */
export function clearIconCache(): void {
  iconCache.clear()
}

/**
 * 盯住两个桌面目录，有变化就回调。
 *
 * 为什么要 watch 而不是定时轮询：用户拖一个快捷方式到桌面，希望界面马上看到；
 * 轮询要么慢要么费。fs.watch 在 Windows 上对目录增删改名都能报。
 * watch 失败（权限/网络盘）就静默降级——界面仍有手动刷新按钮。
 */
export function watchDesktop(onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | null = null
  // 拖动/复制会连续触发多次，合并成一次
  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      clearIconCache()
      onChange()
    }, 400)
  }
  for (const { dir } of desktopDirs()) {
    try {
      const w = fsWatch(dir, debounced)
      watchers.push(w)
    } catch {
      /* 这个桌面盯不了，跳过 */
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        /* 已经关了 */
      }
    }
  }
}

/**
 * 从 .lnk 解析目标路径。
 *
 * 不引第三方库：用 PowerShell 的 WScript.Shell 读 TargetPath，
 * 这是系统自带能力，比解析二进制 .lnk 格式可靠。
 * 解析不到就返回 undefined —— 界面上如实显示"未解析到目标"。
 */
export async function resolveShortcutTarget(lnkPath: string): Promise<string | undefined> {
  if (path.extname(lnkPath).toLowerCase() !== '.lnk') return undefined
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath`
  return new Promise<string | undefined>((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err) return resolve(undefined)
        const t = String(stdout).trim()
        resolve(t || undefined)
      }
    )
  })
}
