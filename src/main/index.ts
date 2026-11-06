import { app, safeStorage } from 'electron'
import path from 'node:path'
import type { DesktopPrefs, TaskDef } from '../shared/types'
import { desktopPrefsOf } from '../shared/desktop'
import { orbPrefsOf } from '../shared/orb'
import { Store } from './node/store'
import { makeSafeStorageCodec } from './node/secrets'
import { prepareSandbox } from './node/sandbox'
import { TaskRunner } from './node/tasks'
import { AuthBroker, TurnRuntime, openSettingsPage } from './runtime'
import { createWindow, getMainWindow, markQuitting, sendToWindow, setCloseToTray, showMainWindow } from './window'
import { createTray, destroyTray, hasTray, refreshTray, type TrayOptions } from './tray'
import { applyOrbPrefs, createOrb, destroyOrb } from './orb'
import { notifyReady, notifyTask } from './notify'
import { registerIpc } from './ipc'

/**
 * 主进程入口：只做装配。
 *
 * 具体的活儿分在四处——
 * - window.ts    窗口与导航安全
 * - runtime.ts   工具装配、授权闸门实现、跑一轮对话
 * - ipc/*        按领域注册 IPC
 * - node/*       读注册表、邮件、安装、存储这些本机能力
 * 这样改一个功能不用先通读八百行入口。
 */

const store = new Store(path.join(app.getPath('userData')), makeSafeStorageCodec(safeStorage))
const inflight = new Map<string, AbortController>()
const broker = new AuthBroker()
/**
 * 「始终允许」白名单（只有 allowAlways 的工具才会写进来：当前仅 install_app，
 * 销毁/卸载类永远不写）。
 * 内存 + `auth-memory.json` 双份：内存保证闸门同步判断，文件保证设置页能看见、能撤销。
 */
const alwaysAllowed = new Set<string>()

const runtime = new TurnRuntime({
  store,
  broker,
  alwaysAllowed,
  openSettings: openSettingsPage
})

/** 托盘菜单：状态行、打开哪一页、真退出 */
const trayOptions: TrayOptions = {
  onQuit: () => {
    markQuitting()
    app.quit()
  },
  statusLine: async () => {
    const tasks = (await store.listTasks()).filter((t) => t.enabled && t.prompt.trim())
    if (tasks.length === 0) return '没有开着的定时任务'
    return `${tasks.length} 条定时任务在运行`
  },
  // 托盘只负责把窗口叫回来，具体落到哪一页由渲染层决定
  onOpen: (route) => sendToWindow('app:route', route)
}

const taskRunner = new TaskRunner({
  getTasks: () => store.listTasks(),
  updateTask: (id, patch) => store.updateTask(id, patch),
  execute: (task: TaskDef) => runtime.runTaskOnce(task),
  onTaskUpdated: () => {
    sendToWindow('tasks:changed')
    // 托盘里的「N 条在运行」跟着变，别停在启动那一刻
    refreshTray(trayOptions)
  },
  onFinish: (task, summary, ok) => {
    // 通知开关每次都重读：用户可能刚在设置里关掉，而这一轮是几小时前排的程
    void store
      .getConfig()
      .then((config) => {
        if (!desktopPrefsOf(config).notifyOnTask) return
        notifyTask(task.name, summary, ok)
      })
      .catch(() => {})
  }
})

/** 关掉窗口是否等于退出：没有托盘可点回来时，必须退出，否则进程会变成幽灵 */
let quitOnAllClosed = true

/**
 * 开机自启时带上的标记参数。
 *
 * 不能用 getLoginItemSettings().wasOpenedAtLogin：那个字段只有 macOS 有，
 * Windows 上恒为假，写了也等于没写（窗口照样在登录时弹出来）。
 */
const STARTUP_FLAG = '--startup'

/** 把桌面偏好落到窗口与系统登录项上。托盘建不起来时「关窗收托盘」强制失效 */
function applyDesktopPrefs(prefs: DesktopPrefs): void {
  const trayReady = hasTray()
  const hideOnClose = prefs.closeToTray && trayReady
  setCloseToTray(hideOnClose)
  quitOnAllClosed = !hideOnClose

  // 开发态不写登录项：会登记成 electron.exe 而丢掉应用路径，开机只会起一个空 Electron
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: prefs.launchAtLogin,
      path: process.execPath,
      args: [STARTUP_FLAG]
    })
  } catch {
    /* 写登录项失败不该让应用挂掉；设置页会显示系统现状仍是关闭 */
  }
}

/** 立即跑一次定时任务：结果回写任务卡，失败也留痕 */
async function runTaskNow(id: string): Promise<{ ok: boolean; detail: string }> {
  const task = (await store.listTasks()).find((t) => t.id === id)
  if (!task) return { ok: false, detail: '任务不存在' }
  try {
    const summary = await runtime.runTaskOnce(task)
    await store.updateTask(task.id, { lastRun: new Date().toISOString(), lastResult: summary })
    sendToWindow('tasks:changed')
    return { ok: true, detail: summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void store.appendRecord({
      kind: 'task',
      title: `定时任务「${task.name}」运行`,
      sub: task.prompt.slice(0, 80),
      result: 'rejected',
      reversible: false
    })
    return { ok: false, detail: message.slice(0, 160) }
  }
}

/**
 * 单实例锁。
 *
 * 关窗只是收进托盘之后，「再点一次桌面图标」变成了很自然的动作，而它以前
 * 会直接开第二个进程。两个进程共用同一份 userData 的后果是具体的：
 * - Chromium 的磁盘缓存目录抢不到，控制台刷 "Unable to move the cache: 拒绝访问"
 * - 两个 TaskRunner 各自排程同一批定时任务 → 到点跑两遍，通知也来两条
 * - Store 的串行队列只在进程内有效，跨进程的「读全量→改→写回」没有任何互斥
 * 所以第二个实例不启动，直接把已有窗口叫到前面来。
 */
const gotTheLock = app.requestSingleInstanceLock()
/** 主进程是否由 --startup 拉起：只在拿到锁之后才有意义 */
const launchedAtLogin = app.isPackaged && process.argv.includes(STARTUP_FLAG)

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户又点了一次图标：把已有窗口叫回来，而不是再开一份
    showMainWindow()
  })
}

void app.whenReady().then(async () => {
  // 没拿到锁的实例已经在退出的路上，别再去抢托盘、文件与系统登录项
  if (!gotTheLock) return
  await store.init()
  // 先把「始终允许」写进内存，否则重启后闸门会以为用户从没授权过
  for (const entry of await store.listAlwaysAllowed()) alwaysAllowed.add(entry.key)

  // Windows 的系统通知要靠 AppUserModelID 归属到应用，打包后的快捷方式也用它分组
  app.setAppUserModelId('com.loyu123.butler')

  // 演示沙箱只是闸门的验收脚手架，仅开发态造一次。
  // 正式运行时不再往用户临时目录里塞假文件（删了下次开机又长出来，很怪）
  if (!app.isPackaged && process.env.BUTLER_SANDBOX !== '0') {
    await prepareSandbox().catch(() => [])
  }

  // 先把托盘立起来，再按偏好决定关窗行为——顺序反了，「关窗收托盘」会因为
  // 那一刻托盘还不存在而被关掉
  createTray(trayOptions)

  const prefs = desktopPrefsOf(await store.getConfig())
  applyDesktopPrefs(prefs)

  registerIpc({
    store,
    alwaysAllowed,
    inflight,
    executeTurn: (params) => runtime.executeTurn(params),
    auth: {
      answer: (authId, answer) => broker.answer(authId, answer),
      settleRequest: (requestId, answer) => broker.settleRequest(requestId, answer)
    },
    tasks: {
      reschedule: () => taskRunner.reschedule(),
      // 增删任务都会走到这里：托盘菜单里的「N 条在运行」也要跟着变
      broadcast: () => {
        sendToWindow('tasks:changed')
        refreshTray(trayOptions)
      },
      runOnce: (id) => runTaskNow(id)
    },
    desktop: {
      apply: (next) => applyDesktopPrefs(next),
      // 开发态不写登录项，界面上要能看出「这个开关现在不生效」
      canAutoLaunch: () => app.isPackaged,
      atLogin: () => (app.isPackaged ? app.getLoginItemSettings().openAtLogin : false)
    },
    orb: {
      apply: (next, hooks) => applyOrbPrefs(next, hooks)
    }
  })

  // 记录页的「去还原」在 ipc/app.ts 里注册

  // 开机自启拉起来的这一次：不弹窗，只在托盘待命，并告诉用户它在
  createWindow({ hidden: launchedAtLogin })
  if (launchedAtLogin && hasTray()) notifyReady()

  // 悬浮助手：球常驻桌面，面板按需弹出。位置落盘走 store，拖动结束时才写
  createOrb({
    onPositionSaved: (x, y) => {
      void store.getConfig().then((config) => store.saveConfig({ orb: { ...orbPrefsOf(config), x, y } }))
    }
  })

  // 定时任务调度器：启动即排程，错过今天这一次的任务会补跑一次
  taskRunner.start()
  app.on('activate', () => {
    if (!getMainWindow()) createWindow()
  })
})

app.on('before-quit', () => {
  // 先标记再退：否则 close 处理器会把这次退出拦成「收进托盘」
  markQuitting()
  destroyTray()
  destroyOrb()
})

app.on('window-all-closed', () => {
  if (quitOnAllClosed) app.quit()
})
