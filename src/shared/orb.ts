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

/**
 * 把光标连续采样换算成窗口位置的累加器。
 *
 * 拖动走的是「增量」：只关心光标这一帧比上一帧挪了多少，累加到窗口位置上。
 * 这样完全不需要「光标坐标」和「窗口坐标」处在同一个原点——而正是那个前提
 * 在真机上不成立（缩放取整、虚拟屏幕原点、透明窗口的边框修正），
 * 导致绝对式算法每帧都重复同一个误差，表现为球越拖越偏、方向还固定。
 *
 * 累积值保持浮点：逐帧取整会把小数误差攒起来，几十帧后一样能看出偏移。
 */
export class DragAccumulator {
  private pos = { x: 0, y: 0 }
  private last = { x: 0, y: 0 }
  private started = false

  /** 按下：以窗口当前位置为基准，记住光标起点 */
  begin(windowPos: { x: number; y: number }, cursor: { x: number; y: number }): void {
    this.pos = { x: windowPos.x, y: windowPos.y }
    this.last = { x: cursor.x, y: cursor.y }
    this.started = true
  }

  /** 移动：返回窗口应当去的位置；光标没动就返回 null，调用方无需碰窗口 */
  step(cursor: { x: number; y: number }): { x: number; y: number } | null {
    if (!this.started) return null
    const dx = cursor.x - this.last.x
    const dy = cursor.y - this.last.y
    this.last = { x: cursor.x, y: cursor.y }
    if (dx === 0 && dy === 0) return null
    this.pos = { x: this.pos.x + dx, y: this.pos.y + dy }
    return { x: Math.round(this.pos.x), y: Math.round(this.pos.y) }
  }

  /**
   * 外部修正累积值。
   *
   * 夹边之后窗口实际落在别处，累积值必须同步过去；否则下一帧又从中途那个
   * 位置继续累加，球会在屏幕边缘来回弹。
   */
  set(pos: { x: number; y: number }): void {
    if (!this.started) return
    this.pos = { x: pos.x, y: pos.y }
  }

  end(): void {
    this.started = false
  }

  get active(): boolean {
    return this.started
  }
}
