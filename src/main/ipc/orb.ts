import { app, ipcMain, Menu } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ChatSession, OrbPrefs } from '../../shared/types'
import { ORB_SESSIONS_MAX, orbPrefsOf } from '../../shared/orb'
import type { IpcContext } from './app'
import { logError } from '../log'
import {
  currentOrbPrefs,
  beginDrag,
  endDrag,
  getOrbWindow,
  hidePanel,
  hotkeyRegistered,
  moveOrbTo,
  sendToOrb,
  showPanel,
  togglePanel
} from '../orb'
import { markQuitting, sendToWindow, showMainWindow } from '../window'

/** 桌面悬浮助手：偏好、拖动、桌面侧会话、移到主窗口 */
export function registerOrbIpc(ctx: IpcContext): void {
  const state = async (): Promise<{ prefs: OrbPrefs; hotkeyOk: boolean }> => {
    const prefs = orbPrefsOf(await ctx.store.getConfig())
    return { prefs, hotkeyOk: hotkeyRegistered() }
  }

  ipcMain.handle('orb:state', () => state())

  ipcMain.handle('orb:set', async (_e, patch: Partial<OrbPrefs>) => {
    const current = orbPrefsOf(await ctx.store.getConfig())
    // 只接受认识得下的字段：渲染层传什么就存什么的话，一个畸形 hotkey 会
    // 让下次启动注册不上快捷键，而设置页看着是"已开启"
    const next: OrbPrefs = {
      enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
      x: typeof patch?.x === 'number' && Number.isFinite(patch.x) ? patch.x : current.x,
      y: typeof patch?.y === 'number' && Number.isFinite(patch.y) ? patch.y : current.y,
      idleAnimation: typeof patch?.idleAnimation === 'boolean' ? patch.idleAnimation : current.idleAnimation,
      hotkey: typeof patch?.hotkey === 'string' ? patch.hotkey : current.hotkey
    }
    await ctx.store.saveConfig({ orb: next })
    // 拖动结束时落盘位置：写失败只影响下次开机的位置，不该让这一次拖动报错
    ctx.orb.apply(next, {
      onPositionSaved: (x, y) =>
        void ctx.store
          .saveConfig({ orb: { ...currentOrbPrefs(), x, y } })
          .catch((err) => logError('orb-position', err))
    })
    return state()
  })

  // ---- 球与面板的交互 ----
  // 「展开」没有 IPC：球上那一下走 toggle，托盘菜单在主进程里直接调 showPanel，
  // 渲染层从不需要「不管现在什么状态都展开」。留着它只是多一个没人调的通路。
  ipcMain.handle('orb:close', () => {
    hidePanel()
    return true
  })
  ipcMain.handle('orb:toggle', () => {
    togglePanel()
    return true
  })

  // 拖动：渲染层报告光标位置（screenX/screenY，CSS 像素 = DIP），主进程只累加增量
  ipcMain.on('orb:drag-start', (_e, cursor: { x: number; y: number }) => {
    beginDrag({ x: Number(cursor?.x) || 0, y: Number(cursor?.y) || 0 })
  })
  ipcMain.on('orb:drag-move', (_e, cursor: { x: number; y: number }) => {
    moveOrbTo({ x: Number(cursor?.x) || 0, y: Number(cursor?.y) || 0 })
  })
  ipcMain.on('orb:drag-end', () => endDrag())

  /**
   * 球的状态由面板上报、主进程转发。
   *
   * 两个窗口各自的渲染进程，球没法直接读到面板里的对话状态；而「等你确认」
   * 这种状态恰恰要在面板收起时也能看见——所以必须由主进程当中转。
   */
  ipcMain.on('orb:status', (_e, status: string) => {
    const allowed = status === 'idle' || status === 'think' || status === 'ask' || status === 'done'
    sendToOrb('orb:status', allowed ? status : 'idle')
  })

  /** 球的右键菜单：用系统原生菜单，72px 的窗口里画不下自己的菜单 */
  ipcMain.handle('orb:menu', () => {
    const win = getOrbWindow()
    if (!win) return false
    const menu = Menu.buildFromTemplate([
      { label: '展开对话', click: () => showPanel() },
      {
        label: '打开主窗口',
        click: () => {
          showMainWindow()
          sendToWindow('app:route', 'chat')
        }
      },
      {
        label: '设置…',
        click: () => {
          showMainWindow()
          sendToWindow('app:route', 'settings')
        }
      },
      { type: 'separator' },
      {
        // 逃生出口：任何时候都能让这个球从桌面上消失，且不牵连托盘与定时任务
        label: '隐藏助手',
        click: () => {
          void (async () => {
            const current = orbPrefsOf(await ctx.store.getConfig())
            await ctx.store.saveConfig({ orb: { ...current, enabled: false } })
            ctx.orb.apply({ ...current, enabled: false }, {
              onPositionSaved: (x, y) =>
                void ctx.store
                  .saveConfig({ orb: { ...currentOrbPrefs(), x, y } })
                  .catch((err) => logError('orb-position', err))
            })
          })().catch((err) => logError('orb-hide', err))
        }
      },
      {
        label: '退出长庚',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
    try {
      menu.popup({ window: win })
    } catch {
      // 球是 focusable:false 的窗口，个别系统上弹不出原生菜单；
      // 这是可选的便利功能，弹不出不该让整次右键报错
      return false
    }
    return true
  })

  // ---- 桌面侧会话 ----
  ipcMain.handle('orb:sessions:list', () => ctx.store.listOrbSessions())

  ipcMain.handle('orb:sessions:save', async (_e, raw: Partial<ChatSession>) => {
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()
    const entry: ChatSession = {
      id,
      ts: Number(raw?.ts) || Date.now(),
      title: String(raw?.title ?? '未命名').slice(0, 80),
      // 桌面侧是草稿本：留的轮次比主窗口少，20 条按条数封顶
      messages: Array.isArray(raw?.messages) ? raw.messages.slice(-40) : []
    }
    await ctx.store.mutateOrbSessions((current) => {
      const list = current.filter((s) => s.id !== id)
      list.unshift(entry)
      return { list: list.sort((a, b) => b.ts - a.ts).slice(0, ORB_SESSIONS_MAX), result: [] }
    })
    return entry
  })

  ipcMain.handle('orb:sessions:delete', (_e, id: string) =>
    ctx.store.mutateOrbSessions((current) => {
      const next = current.filter((s) => s.id !== id)
      return { list: next, result: next }
    })
  )

  ipcMain.handle('orb:sessions:clear', async () => {
    await ctx.store.mutateOrbSessions(() => ({ list: [], result: [] }))
    return []
  })

  /**
   * 移到主窗口：把一条桌面会话搬进 sessions.json 并打上 origin 标记，然后从桌面侧删掉。
   *
   * 是「搬」不是「复制」：两边各留一份的话，用户在面板里删了它，主窗口那份还在，
   * 看起来像删除没生效。
   */
  ipcMain.handle('orb:promote', async (_e, sessionId: string) => {
    const list = await ctx.store.listOrbSessions()
    const found = list.find((s) => s.id === sessionId)
    if (!found) return { ok: false as const, reason: '这条会话已经不在了' }

    // 主窗口侧用新 id 落盘：两边 id 相同会让「删除」在另一侧看起来也生效
    const promoted: ChatSession = {
      id: randomUUID(),
      ts: Date.now(),
      title: found.title,
      messages: found.messages,
      origin: 'orb'
    }
    let inserted = false
    await ctx.store.mutateSessions((current) => {
      if (current.some((s) => s.id === promoted.id)) {
        return { list: current, result: [] }
      }
      inserted = true
      const next = [promoted, ...current].sort((a, b) => b.ts - a.ts).slice(0, 300)
      return { list: next, result: [] }
    })

    await ctx.store.mutateOrbSessions((current) => ({
      list: current.filter((s) => s.id !== sessionId),
      result: []
    }))

    if (inserted) {
      showMainWindow()
      sendToWindow('orb:open-session', promoted.id)
    }
    return { ok: true as const, sessionId: promoted.id }
  })
}
