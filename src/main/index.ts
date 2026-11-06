import { app, safeStorage } from 'electron'
import path from 'node:path'
import type { TaskDef } from '../shared/types'
import { Store } from './node/store'
import { makeSafeStorageCodec } from './node/secrets'
import { prepareSandbox } from './node/sandbox'
import { TaskRunner } from './node/tasks'
import { AuthBroker, TurnRuntime, openSettingsPage } from './runtime'
import { createWindow, getMainWindow, sendToWindow } from './window'
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

const taskRunner = new TaskRunner({
  getTasks: () => store.listTasks(),
  updateTask: (id, patch) => store.updateTask(id, patch),
  execute: (task: TaskDef) => runtime.runTaskOnce(task),
  onTaskUpdated: () => sendToWindow('tasks:changed')
})

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

void app.whenReady().then(async () => {
  await store.init()
  // 先把「始终允许」写进内存，否则重启后闸门会以为用户从没授权过
  for (const entry of await store.listAlwaysAllowed()) alwaysAllowed.add(entry.key)

  // 演示沙箱只是闸门的验收脚手架，仅开发态造一次。
  // 正式运行时不再往用户临时目录里塞假文件（删了下次开机又长出来，很怪）
  if (!app.isPackaged && process.env.BUTLER_SANDBOX !== '0') {
    await prepareSandbox().catch(() => [])
  }

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
      broadcast: () => sendToWindow('tasks:changed'),
      runOnce: (id) => runTaskNow(id)
    }
  })

  // 记录页的「去还原」在 ipc/app.ts 里注册

  createWindow()

  // 定时任务调度器：启动即排程，错过今天这一次的任务会补跑一次
  taskRunner.start()

  app.on('activate', () => {
    if (!getMainWindow()) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
