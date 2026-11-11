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

/**
 * 后台安装装完了。
 *
 * 和定时任务的通知分开写：标题要说的是"哪个软件"，而不是"任务"——
 * 用户看到的是一句"哔哩哔哩装好了"，不是"某条定时任务完成了"。
 *
 * 失败也通知，但措辞要收敛：安装器是用户自己在点的，取消和失败不由我们定性，
 * 所以这里只说"没装成"，把工具给出的原因原样带上。
 */
export function notifyInstall(name: string, detail: string, ok: boolean): void {
  if (!Notification.isSupported()) return
  const body = detail.trim().slice(0, 160) || (ok ? '已装上，记录里能查到核对结果' : '没装成')
  const note = new Notification({
    title: ok ? `「${name}」装好了` : `「${name}」没装成`,
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
