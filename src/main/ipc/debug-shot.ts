import { BrowserWindow, ipcMain, app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 临时诊断：把主窗口当前画面截下来存到临时目录。
 * 用于开发期确认"界面上到底画出了什么"，验完即删。
 */
export function registerDebugShotIpc(): void {
  ipcMain.handle('debug:shot', async () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getSize()[0] > 400)
    if (!win) return { ok: false, reason: '没有主窗口' }
    const img = await win.webContents.capturePage()
    const out = path.join(os.tmpdir(), 'polar-shot.png')
    await fs.writeFile(out, img.toPNG())
    return { ok: true, path: out, size: img.getSize() }
  })

  /** 把渲染层实际拿到的第一个图标写到磁盘，验证它是不是一张有效 PNG */
  ipcMain.handle('debug:dumptopicon', async (_e, dataUrl: string) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return { ok: false, reason: `不是一个图片 dataURL：${String(dataUrl).slice(0, 60)}` }
    }
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const buf = Buffer.from(b64, 'base64')
    const out = path.join(os.tmpdir(), 'polar-icon.png')
    await fs.writeFile(out, buf)
    // PNG 魔数检查
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    return { ok: true, path: out, bytes: buf.length, isPng, head: buf.subarray(0, 8).toString('hex') }
  })

  void app
}
