import { Notification } from 'electron'
import { showMainWindow } from './window'

/**
 * 系统通知。
 *
 * 只给「用户不在看窗口」的场景用：定时任务跑完、跑失败。对话里的回答不弹——
 * 那时候用户就在窗口前，弹出来只是把屏幕上的东西再念一遍。
 *
 * 通知只带任务名和一句摘要（runTaskOnce 已经截到 140 字），不把回答正文
 * 整个倒进 Windows 通知中心——那是个离屏的持久存储，写进去就收不回来。
 */

export function notifyTask(name: string, summary: string, ok: boolean): void {
  if (!Notification.isSupported()) return
  const body = summary.trim().slice(0, 160) || (ok ? '已完成' : '运行失败')
  const note = new Notification({
    title: ok ? `定时任务「${name}」已完成` : `定时任务「${name}」失败`,
    body
  })
  note.on('click', () => showMainWindow())
  note.show()
}

/** 托盘刚起来、用户还没见过面时的自我说明；只在开机自启时用 */
export function notifyReady(): void {
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: '长庚已在后台待命',
    body: '窗口已收起，定时任务照常运行。点托盘图标可以重新打开。'
  })
  note.on('click', () => showMainWindow())
  note.show()
}
