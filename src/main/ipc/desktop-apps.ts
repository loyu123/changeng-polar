import { ipcMain, BrowserWindow } from 'electron'
import { listDesktopApps, resolveShortcutTarget, watchDesktop } from '../node/desktop-apps'

/**
 * 桌面应用清单的 IPC。
 *
 * 和「应用台账」（读注册表 Uninstall 键的 129 条已安装程序）是**两件事**：
 * 这里只回答"桌面上摆着什么"，因为那才是用户认得的东西。
 * 台账那套仍在设置里，服务的是"这个程序是什么、装在哪"的查证场景。
 */
export function registerDesktopAppsIpc(): void {
  ipcMain.handle('desktop-apps:list', () => listDesktopApps())

  ipcMain.handle('desktop-apps:target', (_e, lnkPath: string) => resolveShortcutTarget(String(lnkPath ?? '')))

  let stopWatch: (() => void) | null = null

  /** 开始盯桌面：有变化就推一条事件给所有窗口，前端自己刷新 */
  ipcMain.handle('desktop-apps:watch', () => {
    if (stopWatch) return true
    stopWatch = watchDesktop(() => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('desktop-apps:changed')
      }
    })
    return true
  })

  ipcMain.handle('desktop-apps:unwatch', () => {
    stopWatch?.()
    stopWatch = null
    return true
  })
}
