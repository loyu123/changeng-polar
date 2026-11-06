import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

/**
 * 主窗口。
 *
 * 与 IPC、对话编排无关，所以单独放：窗口的安全配置（导航拦截、外链处理）
 * 是独立的一块，改它不该牵动主进程入口。
 */

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 往渲染层推一条事件；窗口不在或正在关闭时静默丢弃 */
export function sendToWindow(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send(channel, ...args)
  } catch {
    /* 窗口正在关闭 */
  }
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#F3F3F3',
    title: '长庚',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 外链一律走系统浏览器，应用内不加载远程页面
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 同一窗口内的导航也要挡住：页面一旦被导航到远端，preload 的 window.butler
  // 会跟着挂上去，那个页面就能直接调 config:get 读到密钥
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (allowed) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}
