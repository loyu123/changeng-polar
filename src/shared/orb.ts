import type { ButlerConfig, OrbPrefs } from './types'

/**
 * 桌面悬浮助手的默认值与归一化。
 *
 * 和 desktop.ts 同一套理由：主进程要用它决定建不建窗口、渲染层要用它渲染开关，
 * 两边各写一份默认值迟早对不上。
 */

/** 桌面侧会话的保留条数：它是草稿本，不是档案馆 */
export const ORB_SESSIONS_MAX = 20

/** 球与面板的尺寸（含投影留白），主进程与渲染层共用 */
export const ORB_SIZE = 72
export const PANEL_WIDTH = 380
export const PANEL_HEIGHT = 560

export const DEFAULT_ORB_PREFS: OrbPrefs = {
  enabled: true,
  x: null,
  y: null,
  idleAnimation: true,
  hotkey: 'CommandOrControl+Shift+K'
}

/**
 * 从配置里读悬浮助手偏好。
 *
 * 逐字段判真值：旧的 config.json 里没有 orb 这一段，而 getConfig 是浅合并，
 * 缺的字段会原样缺失，不能指望它补全。
 */
export function orbPrefsOf(config: ButlerConfig | null | undefined): OrbPrefs {
  const raw = config?.orb
  return {
    enabled: raw?.enabled !== false,
    x: typeof raw?.x === 'number' && Number.isFinite(raw.x) ? raw.x : null,
    y: typeof raw?.y === 'number' && Number.isFinite(raw.y) ? raw.y : null,
    idleAnimation: raw?.idleAnimation !== false,
    hotkey: typeof raw?.hotkey === 'string' ? raw.hotkey : DEFAULT_ORB_PREFS.hotkey
  }
}

/**
 * 把球的坐标夹进某块屏幕的可见区域。
 *
 * 必须做，而且要用「当下这一块屏幕」而不是保存时那块：拔掉外接显示器之后，
 * 存在副屏上的坐标会落到不存在的区域里——窗口照建，但谁也看不见它，
 * 用户只能去设置里关掉再打开。
 */
export function clampToDisplay(
  x: number,
  y: number,
  size: number,
  area: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const minX = area.x
  const minY = area.y
  const maxX = area.x + area.width - size
  const maxY = area.y + area.height - size
  return {
    x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY)))
  }
}

/** 没有保存过位置时的落点：右下角，避开任务栏 */
export function defaultOrbPosition(
  size: number,
  area: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  return { x: area.x + area.width - size - 28, y: area.y + area.height - size - 28 }
}
