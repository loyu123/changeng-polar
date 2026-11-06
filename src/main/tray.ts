import { Menu, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { showMainWindow } from './window'

/**
 * 系统托盘。
 *
 * 存在的理由只有一个：定时任务只在进程活着的时候跑（见 node/tasks.ts 的边界），
 * 而窗口一关进程就结束，等于用户关个窗顺手把定时任务废了。托盘给「关窗 ≠ 退出」
 * 一个落点，也让任务跑完的通知有个可以点回来的地方。
 *
 * 托盘不承载任何操作入口：装什么、卸什么、删什么仍然只能从对话走闸门，
 * 这里多一个菜单项就等于多一条绕过授权卡的路径。
 */

let tray: Tray | null = null

/** 托盘图标：Windows 优先取 .ico（多尺寸，比 png 缩放发虚少）；打包后与 out/ 同在 asar 内 */
function trayIconPath(): string | undefined {
  for (const name of ['icon.ico', 'icon.png']) {
    const file = path.join(__dirname, '../../build', name)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

export interface TrayOptions {
  /** 真退出：由调用方先 markQuitting 再 app.quit */
  onQuit: () => void
  /** 菜单里展示的一行状态（定时任务开着几条） */
  statusLine: () => Promise<string>
  /** 打开窗口并落到某个页面 */
  onOpen: (route: 'chat' | 'tasks') => void
}

/**
 * 建托盘。返回 false 表示没建起来（典型是图标缺失）。
 *
 * 调用方必须据此关掉「关窗收进托盘」——窗口藏了却没有托盘图标可以点回来，
 * 用户就只能去任务管理器结束进程，比关窗即退难用得多。
 */
export function createTray(opts: TrayOptions): boolean {
  const icon = trayIconPath()
  if (!icon) return false

  if (tray && !tray.isDestroyed()) {
    void refreshTrayMenu(opts)
    return true
  }

  try {
    tray = new Tray(icon)
  } catch {
    tray = null
    return false
  }
  tray.setToolTip('长庚 · 本地电脑管家')

  // 左键单击直接唤起窗口，右键才出菜单——与 Windows 上多数常驻程序的习惯一致
  tray.on('click', () => {
    opts.onOpen('chat')
    showMainWindow()
  })
  // 双击在某些 Windows 版本里只发 single-click 事件，这里不再重复处理

  void refreshTrayMenu(opts)
  return true
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

export function hasTray(): boolean {
  return Boolean(tray && !tray.isDestroyed())
}

async function refreshTrayMenu(opts: TrayOptions): Promise<void> {
  if (!tray || tray.isDestroyed()) return
  let status = ''
  try {
    status = await opts.statusLine()
  } catch {
    status = ''
  }
  if (!tray || tray.isDestroyed()) return

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status || '长庚已就绪', enabled: false },
      { type: 'separator' },
      {
        label: '打开长庚',
        click: () => {
          opts.onOpen('chat')
          showMainWindow()
        }
      },
      {
        label: '定时任务…',
        click: () => {
          opts.onOpen('tasks')
          showMainWindow()
        }
      },
      { type: 'separator' },
      { label: '退出长庚', click: () => opts.onQuit() }
    ])
  )
}

/** 任务状态变了就重画菜单（「开着几条」不能一直停在启动那一刻） */
export function refreshTray(opts: TrayOptions): void {
  void refreshTrayMenu(opts)
}
