import { app, ipcMain, shell, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DesktopPrefs } from '../../shared/types'
import type { DesktopState } from '../../shared/desktop'
import { desktopPrefsOf } from '../../shared/desktop'
import type { Store } from '../node/store'
import { filterTools, machineEnv } from '../runtime'
import { getMainWindow } from '../window'
import { createTools } from '../agent/tools'
import { openRecycleBin } from '../node/sandbox'
import { isInsideOutput } from '../node/document'

/** IPC 注册时共用的依赖：主进程入口只负责把它们装配起来传下去 */
export interface IpcContext {
  store: Store
  /** 便携模式状态：配置是否跟着 exe 走、配置目录在哪 */
  portable: import('../portable').PortableState
  /** 远程入口（手机 App）：开关、配对码、设备白名单 */
  remote: import('../remote/service').RemoteService
  /** 「始终允许」的内存副本，撤销时要同步清掉 */
  alwaysAllowed: Set<string>
  /** 本轮在跑的请求：停止时要能精确打断 */
  inflight: Map<string, AbortController>
  /** 跑一轮对话（有人看着的那种） */
  executeTurn: (params: {
    requestId: string
    messages: import('../../shared/types').ChatMessage[]
    controller: AbortController
    emit: (raw: import('../../shared/types').ChatPayload) => void
    uiAuth: boolean
  }) => Promise<import('../../shared/types').TurnResult>
  /** 授权卡：作答与按请求收口；候选卡：选择 */
  auth: {
    answer: (authId: string, answer: import('../../shared/types').AuthAnswer) => boolean
    /** 候选卡作答；值不在候选集里按「没选」处理，返回 false 表示卡已失效 */
    choose: (choiceId: string, value: string) => boolean
    settleRequest: (requestId: string, answer: import('../../shared/types').AuthAnswer) => void
  }
  /** 定时任务：保存/删除后重排，跑完广播刷新 */
  tasks: {
    reschedule: () => void
    broadcast: () => void
    runOnce: (id: string) => Promise<{ ok: boolean; detail: string }>
  }
  /** 桌面常驻：关窗行为、开机自启、任务通知的实际生效动作 */
  desktop: {
    /** 把偏好落到窗口、托盘与系统登录项上 */
    apply: (prefs: DesktopPrefs) => void
    /** 当前能否写系统登录项（开发态不写） */
    canAutoLaunch: () => boolean
    /** 系统登录项里现在的真实状态 */
    atLogin: () => boolean
  }
  /** 悬浮助手：建/藏球与面板、注册快捷键 */
  orb: {
    apply: (prefs: import('../../shared/types').OrbPrefs, hooks: { onPositionSaved: (x: number, y: number) => void }) => void
  }
  /** 后台安装的任务清单：界面列出"还在装什么"、取消、装完清掉 */
  installJobs: import('../node/install-jobs').InstallJobs
}

export function registerAppIpc(ctx: IpcContext): void {
  ipcMain.handle('app:info', () => ({
    ...machineEnv(),
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    portable: {
      active: ctx.portable.active,
      configDir: ctx.portable.configDir,
      exeDir: ctx.portable.exeDir,
      reason: ctx.portable.reason
    }
  }))

  ipcMain.handle('win:minimize', () => getMainWindow()?.minimize())
  ipcMain.handle('win:toggle-maximize', () => {
    const win = getMainWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:close', () => getMainWindow()?.close())

  // ---- 桌面常驻：关窗收托盘、开机自启、任务通知 ----
  // 偏好存在 config.json（与其它设置同一份），但「系统登录项到底是不是开的」只能问系统，
  // 所以 state 里两个值分开给：prefs 是用户的选择，atLogin 是系统的现状。
  const desktopState = async (prefs: DesktopPrefs): Promise<DesktopState> => ({
    prefs,
    atLogin: ctx.desktop.atLogin(),
    canAutoLaunch: ctx.desktop.canAutoLaunch()
  })

  ipcMain.handle('desktop:state', async () => {
    const config = await ctx.store.getConfig()
    return desktopState(desktopPrefsOf(config))
  })

  ipcMain.handle('desktop:set', async (_e, patch: Partial<DesktopPrefs>) => {
    const current = await ctx.store.getConfig()
    const next = { ...desktopPrefsOf(current), ...sanitizeDesktopPatch(patch) }
    await ctx.store.saveConfig({ desktop: next })
    ctx.desktop.apply(next)
    return desktopState(next)
  })

  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (!/^(https?:\/\/|ms-settings:)/i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  // 打开数据目录（存储与缓存分区）：只允许打开 userData 里的东西，
  // 以及便携版的配置目录——它在 U 盘上，不在 userData 里
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    if (typeof p !== 'string') return false
    const target = path.resolve(p)
    const allowed = [path.resolve(app.getPath('userData')), path.resolve(ctx.portable.configDir)]
    if (!allowed.some((dir) => target === dir || target.startsWith(dir + path.sep))) return false
    const err = await shell.openPath(target)
    return err === ''
  })

  // 存储占用：列数据文件与大小。config.json 可能在便携目录里，单独查
  ipcMain.handle('storage:stats', async () => {
    const dir = app.getPath('userData')
    const configDir = ctx.portable.configDir
    const names = [
      'config.json',
      'records.jsonl',
      'records.jsonl.1',
      'records.jsonl.2',
      'tasks.json',
      'sessions.json',
      'auth-memory.json',
      'snapshots.json',
      // 项目档案：这个列表曾经漏了它，于是设置里的存储占用看不见这份数据，
      // 而它恰恰是"模型会去读哪个目录"的配置——用户想知道它在哪、多大
      'project-archive.json',
      'memory.json'
    ]
    const files: Array<{ file: string; bytes: number; dir: string }> = []
    for (const file of names) {
      // 配置文件跟着 portable 走，别处仍是 userData
      const base = file === 'config.json' ? configDir : dir
      try {
        const st = await fs.stat(path.join(base, file))
        files.push({ file, bytes: st.size, dir: base })
      } catch {
        /* 不存在 = 还没生成 */
      }
    }
    return { dir, configDir, portable: ctx.portable.active, files }
  })

  // ---- 能力开关（图标条 · 插头）：工具清单 + 启用状态 ----
  ipcMain.handle('tools:list', async () => {
    const config = await ctx.store.getConfig()
    const toggles = config.toolToggles ?? {}
    const readOnly = config.readOnly === true
    // 这里只需要工具的元信息，不真的执行，所以依赖给空实现
    const tools = createTools({
      openSettings: async () => {},
      saveSnapshot: async () => {},
      listSnapshots: async () => []
    })
    // 和对话里用的是同一个过滤函数：插件页显示的状态必须和实际能调到的工具一致
    const allowed = new Set(filterTools(tools, { toggles, readOnly }).map((t) => t.name))
    const mutating = (effect: string): boolean => effect === 'write' || effect === 'destroy' || effect === 'install'
    return tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      effect: t.effect,
      allowAlways: t.allowAlways === true,
      enabled: allowed.has(t.name),
      // 只读模式挡下的，要和「用户自己关掉的」区分开，否则用户找不到原因
      blockedByReadOnly: readOnly && mutating(t.effect) ? true : undefined
    }))
  })

  // 记录页的「去还原」：只打开回收站窗口，还原仍然由用户点
  ipcMain.handle('shell:recycle', () => {
    openRecycleBin()
    return true
  })

  /**
   * 在资源管理器里指出一个**长庚自己写出的文件**（记录页「打开所在位置」）。
   *
   * 作用域写死在产出目录：这是把 shell 能力暴露给渲染层的唯一一处，
   * 而"传个任意路径就能让系统去定位它"等于把本机文件系统的浏览权交出去了。
   * 只认 `write_document` 自己的落点，别处一律 false——不给理由，也不回显路径。
   */
  ipcMain.handle('shell:reveal', async (_e, p: string) => {
    if (typeof p !== 'string' || !p.trim()) return false
    if (!isInsideOutput(app.getPath('desktop'), p)) return false
    // 文件已经不在（用户自己删了/移了）：不假装定位成功
    try {
      await fs.access(p)
    } catch {
      return false
    }
    shell.showItemInFolder(path.resolve(p))
    return true
  })
}

/** 只接受三个已知的布尔字段：渲染层多传的键不该被写进配置文件 */
function sanitizeDesktopPatch(patch: Partial<DesktopPrefs> | null | undefined): Partial<DesktopPrefs> {
  const out: Partial<DesktopPrefs> = {}
  if (!patch || typeof patch !== 'object') return out
  if (typeof patch.closeToTray === 'boolean') out.closeToTray = patch.closeToTray
  if (typeof patch.launchAtLogin === 'boolean') out.launchAtLogin = patch.launchAtLogin
  if (typeof patch.notifyOnTask === 'boolean') out.notifyOnTask = patch.notifyOnTask
  return out
}
