import { app, ipcMain, shell, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Store } from '../node/store'
import { machineEnv } from '../runtime'
import { getMainWindow } from '../window'
import { createTools } from '../agent/tools'
import { openRecycleBin } from '../node/sandbox'

/** IPC 注册时共用的依赖：主进程入口只负责把它们装配起来传下去 */
export interface IpcContext {
  store: Store
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
  /** 授权卡：作答与按请求收口 */
  auth: {
    answer: (authId: string, answer: import('../../shared/types').AuthAnswer) => boolean
    settleRequest: (requestId: string, answer: import('../../shared/types').AuthAnswer) => void
  }
  /** 定时任务：保存/删除后重排，跑完广播刷新 */
  tasks: {
    reschedule: () => void
    broadcast: () => void
    runOnce: (id: string) => Promise<{ ok: boolean; detail: string }>
  }
}

export function registerAppIpc(ctx: IpcContext): void {
  ipcMain.handle('app:info', () => ({
    ...machineEnv(),
    appVersion: app.getVersion(),
    userData: app.getPath('userData')
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

  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (!/^(https?:\/\/|ms-settings:)/i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  // 打开数据目录（存储与缓存分区）：只允许打开 userData 里的东西
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    const dir = app.getPath('userData')
    if (typeof p !== 'string' || !path.resolve(p).startsWith(path.resolve(dir))) return false
    const err = await shell.openPath(path.resolve(p))
    return err === ''
  })

  // 存储占用：列 userData 下的数据文件与大小
  ipcMain.handle('storage:stats', async () => {
    const dir = app.getPath('userData')
    const names = [
      'config.json',
      'records.jsonl',
      'records.jsonl.1',
      'records.jsonl.2',
      'tasks.json',
      'projects.json',
      'todos.json',
      'sessions.json',
      'auth-memory.json',
      'verify.json',
      'notes.json',
      'snapshots.json'
    ]
    const files: Array<{ file: string; bytes: number }> = []
    for (const file of names) {
      try {
        const st = await fs.stat(path.join(dir, file))
        files.push({ file, bytes: st.size })
      } catch {
        /* 不存在 = 还没生成 */
      }
    }
    return { dir, files }
  })

  // ---- 能力开关（图标条 · 插头）：工具清单 + 启用状态 ----
  ipcMain.handle('tools:list', async () => {
    const config = await ctx.store.getConfig()
    const toggles = config.toolToggles ?? {}
    // 这里只需要工具的元信息，不真的执行，所以依赖给空实现
    const tools = createTools({
      openSettings: async () => {},
      officialSite: async () => undefined,
      saveSnapshot: async () => {},
      appNotes: async () => ({}),
      appVerify: async () => ({})
    })
    return tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      effect: t.effect,
      allowAlways: t.allowAlways === true,
      enabled: toggles[t.name] !== false
    }))
  })

  // 记录页的「去还原」：只打开回收站窗口，还原仍然由用户点
  ipcMain.handle('shell:recycle', () => {
    openRecycleBin()
    return true
  })

  // 项目档案导出：渲染层拼好 Markdown，这里只负责选路径、写文件
  ipcMain.handle('projects:export', async (_e, payload: { name: string; markdown: string }) => {
    const name = String(payload?.name ?? '项目').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '项目'
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      title: '导出项目档案',
      defaultPath: path.join(app.getPath('documents'), `${name}-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await fs.writeFile(result.filePath, String(payload?.markdown ?? ''), 'utf8')
    return { ok: true, path: result.filePath }
  })
}
