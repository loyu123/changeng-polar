import type { ButlerConfig, DesktopPrefs } from './types'

/**
 * 桌面常驻偏好的默认值与归一化。
 *
 * 放 shared 是因为主进程要用它决定关窗行为、渲染层要用它渲染开关，
 * 两边各写一份默认值迟早对不上（一处默认开、一处默认关，用户看到的就是「明明开着却没用」）。
 */

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  closeToTray: true,
  launchAtLogin: false,
  notifyOnTask: true
}

/**
 * 从配置里读桌面偏好。
 *
 * 逐字段判真值而不是取默认对象：旧的 config.json 里根本没有 desktop 这一段，
 * 而 store.getConfig 是浅合并，缺的字段会原样缺失，不能指望它补全。
 */
export function desktopPrefsOf(config: ButlerConfig | null | undefined): DesktopPrefs {
  const raw = config?.desktop
  return {
    closeToTray: raw?.closeToTray !== false,
    launchAtLogin: raw?.launchAtLogin === true,
    notifyOnTask: raw?.notifyOnTask !== false
  }
}

/** 桌面偏好的运行态：偏好值 + 系统里登录项的真实状态（两者可能不一致，界面上要能看出差别） */
export interface DesktopState {
  prefs: DesktopPrefs
  /** 系统登录项里当前是否真的开机自启 */
  atLogin: boolean
  /** 当前形态能否写登录项：开发态不写，否则会登记成 electron.exe 而缺应用路径 */
  canAutoLaunch: boolean
}
