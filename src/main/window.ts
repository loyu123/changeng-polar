import { BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 主窗口。
 *
 * 与 IPC、对话编排无关，所以单独放：窗口的安全配置（导航拦截、外链处理）
 * 是独立的一块，改它不该牵动主进程入口。
 */

let mainWindow: BrowserWindow | null = null

/** 关窗时是否收进托盘（跟随配置；false 时关窗即退出） */
let closeToTray = true
/** 真的在退出：区分「用户点了关闭」和「程序要结束」，只有后者才允许窗口关掉 */
let quitting = false

/** 窗口/任务栏图标：开发态从 build/ 取，打包后同在 asar 内同一相对位置 */
function iconPath(): string | undefined {
  const file = path.join(__dirname, '../../build/icon.png')
  return fs.existsSync(file) ? file : undefined
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setCloseToTray(enabled: boolean): void {
  closeToTray = enabled
}

/** 退出前必须先调它，否则 close 处理器会把退出拦成「收进托盘」 */
export function markQuitting(): void {
  quitting = true
}

/** 把窗口显示到前台；已经关掉就重建一个 */
export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function hideMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.hide()
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

export function createWindow(options: { hidden?: boolean } = {}): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    // 与 index.css 的 --white 一致，否则启动/缩放时会闪一帧偏灰的底
    backgroundColor: '#FFFFFF',
    icon: iconPath(),
    title: '长庚',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 开机自启进来的这一次不该弹窗：用户刚登录，没有要看的东西
  mainWindow.on('ready-to-show', () => {
    if (options.hidden) return
    mainWindow?.show()
  })

  // 关窗不退出：定时任务只在进程活着时跑，收进托盘才能让它接着跑。
  // markQuitting 之后这一条放行，否则托盘菜单的「退出」会被自己拦住。
  mainWindow.on('close', (event) => {
    if (quitting || !closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })

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
