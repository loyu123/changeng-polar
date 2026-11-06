import { BrowserWindow, globalShortcut, screen } from 'electron'
import path from 'node:path'
import type { OrbPrefs } from '../shared/types'
import { DEFAULT_ORB_PREFS, ORB_SIZE, PANEL_HEIGHT, PANEL_WIDTH, DragAccumulator, clampToDisplay, defaultOrbPosition } from '../shared/orb'

/**
 * 桌面悬浮助手：一个是球，一个是面板。
 *
 * 为什么是两个窗口而不是一个会伸缩的窗口：
 * 球要常驻在桌面某个位置，面板要从球旁边弹出来又要能独立关闭。做成一个窗口的话，
 * 展开时窗口矩形必须同时盖住球和面板，中间那块透明区域会把点击吃掉——用户点桌面
 * 图标点不动，却看不出为什么。两个窗口各占各的矩形，没有死区。
 *
 * 代价是两个渲染进程。这里的取舍是"交互正确"优先于"省几十兆内存"。
 */

let orbWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null

let prefs: OrbPrefs = { ...DEFAULT_ORB_PREFS }

export interface OrbHooks {
  /** 球被移动了（松手时落盘，拖动过程中不写文件） */
  onPositionSaved: (x: number, y: number) => void
}

let hooks: OrbHooks | null = null

export function getOrbWindow(): BrowserWindow | null {
  return orbWindow && !orbWindow.isDestroyed() ? orbWindow : null
}

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function sendToOrb(channel: string, ...args: unknown[]): void {
  const win = getOrbWindow()
  if (!win) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    /* 窗口正在关闭 */
  }
}

export function sendToPanel(channel: string, ...args: unknown[]): void {
  const win = getPanelWindow()
  if (!win) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    /* 窗口正在关闭 */
  }
}

/** 渲染页地址：开发态走 dev server，打包后读同一份 orb.html，用 query 区分角色 */
function loadRole(win: BrowserWindow, role: 'ball' | 'panel'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/orb.html?view=${role}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/orb.html'), { query: { view: role } })
  }
}

function commonPrefs(win: BrowserWindow): void {
  // 球与面板都只在桌面这一层出现：不进任务栏、不进 Alt+Tab
  win.setSkipTaskbar(true)
  // 外链一律走系统浏览器；球和面板都不该在应用内加载任何远程页面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function createOrbWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea
  const size = ORB_SIZE
  const pos =
    prefs.x !== null && prefs.y !== null
      ? clampToDisplay(prefs.x, prefs.y, size, area)
      : defaultOrbPosition(size, area)

  const win = new BrowserWindow({
    width: size,
    height: size,
    x: pos.x,
    y: pos.y,
    // 圆形球必须靠透明，投影也在透明画布里画，不要系统阴影
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不抢焦点：点球不该让当前正在打字的窗口失焦
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // floating 层：在普通窗口之上，但不至于盖住系统级弹窗（如任务切换器）
  win.setAlwaysOnTop(true, 'floating')
  commonPrefs(win)
  loadRole(win, 'ball')
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    orbWindow = null
  })
  return win
}

function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    // 面板不需要透明：不透明窗口在 Windows 11 上会拿到系统的圆角与投影，
    // 比自己在透明画布里画一圈阴影更接近原生
    transparent: false,
    frame: false,
    backgroundColor: '#FFFFFF',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  commonPrefs(win)
  loadRole(win, 'panel')

  // 点到别处就收起：这是弹出面板该有的行为。
  // 但刚 show 出来那一刻也可能立刻收到 blur（焦点还没落稳），照收就会「点了没反应」，
  // 所以显示后的短暂窗口里忽略这一次。
  let shownAt = 0
  win.on('blur', () => {
    if (win.isDestroyed()) return
    if (Date.now() - shownAt < 250) return
    win.hide()
  })
  win.on('show', () => {
    shownAt = Date.now()
  })
  win.on('closed', () => {
    panelWindow = null
  })
  return win
}

/** 面板贴着球弹出：球在右半边就向左展开，否则向右展开；纵向夹进可见区域 */
function positionPanel(): void {
  const ball = getOrbWindow()
  const panel = getPanelWindow()
  if (!panel) return

  const gap = 10
  let anchorX: number
  let anchorY: number
  let anchorW = ORB_SIZE

  if (ball) {
    const b = ball.getBounds()
    anchorX = b.x
    anchorY = b.y
    anchorW = b.width
  } else {
    // 球没显示（被关掉）时，面板落到右下角
    const area = screen.getPrimaryDisplay().workArea
    const fallback = defaultOrbPosition(ORB_SIZE, area)
    anchorX = fallback.x
    anchorY = fallback.y
  }

  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
  const area = display.workArea
  const panelW = panel.getBounds().width
  const panelH = panel.getBounds().height

  // 球在屏幕右半边 → 面板往左放，反之往右
  const ballCenter = anchorX + anchorW / 2
  const screenCenter = area.x + area.width / 2
  const openLeft = ballCenter > screenCenter

  let x = openLeft ? anchorX - panelW - gap : anchorX + anchorW + gap
  // 纵向以球为中心，再夹进可见区域
  let y = anchorY + ORB_SIZE / 2 - panelH / 2
  const clamped = clampToDisplay(x, y, 1, area)
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - panelW - 8)
  y = Math.min(Math.max(clamped.y, area.y + 8), area.y + area.height - panelH - 8)

  panel.setBounds({ x: Math.round(x), y: Math.round(y), width: panelW, height: panelH })
}

export function isPanelVisible(): boolean {
  const win = getPanelWindow()
  return Boolean(win && win.isVisible())
}

export function showPanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelWindow = createPanelWindow()
  }
  const win = panelWindow
  positionPanel()
  win.showInactive()
  win.focus()
  sendToPanel('orb:panel-shown')
}

export function hidePanel(): void {
  const win = getPanelWindow()
  if (win && win.isVisible()) win.hide()
}

export function togglePanel(): void {
  if (isPanelVisible()) hidePanel()
  else showPanel()
}

/* ---------------- 拖动 ---------------- */

/**
 * 手动拖动。
 *
 * 不用 CSS 的 -webkit-app-region: drag：那个区域会把点击事件整个吃掉，
 * 球就再也点不开了。
 *
 * 位移用「增量」而不是「光标绝对位置 − 抓取偏移」。
 *
 * 绝对式看似直接，实机上却会持续偏向某个方向：它要求「光标坐标」和
 * 「窗口坐标」严格处在同一个坐标系里，只要主进程取的屏幕点与 setBounds
 * 认定的原点差一点点（缩放取整、虚拟屏幕原点、透明窗口的边框修正），
 * 每一帧都会把这个差值重复算进去，于是越拖越偏，且方向固定。
 *
 * 增量式不碰坐标系原点：只关心光标这一帧比上一帧挪了多少，把这个差值
 * 累加到窗口位置上。差值为零时窗口一动不动，差值为正时窗口跟着走同样的距离。
 * 另外它天然没有自我推进的问题——窗口移动不会改变「光标两次采样之间的差」。
 *
 * 采样坐标来自渲染层的 pointer 事件（screenX/screenY 是 CSS 像素，与
 * setBounds 的 DIP 同一尺度），两边不会打架。
 */
let dragActive = false
/** 增量累加器：把光标的逐帧位移换算成窗口位置 */
const dragAcc = new DragAccumulator()
/** 按下那一刻的窗口位置：用来判断这次到底有没有真的挪动过 */
let dragStartPos = { x: 0, y: 0 }
/**
 * 尺寸全程钉死。
 *
 * Windows 上透明无边框窗口每调一次 setPosition 就把客户区往外撑 1px
 * （实测 76 → 77 → … → 106）。所以这里一律用 setBounds 并把宽高一并写回，
 * 而且固定用创建时的 ORB_SIZE，不读 getBounds().width——那个值可能是虚高的。
 */
const dragSize = { width: ORB_SIZE, height: ORB_SIZE }
/** 拖动结束的兜底定时器：见 armDragWatchdog */
let dragWatchdog: NodeJS.Timeout | null = null

/**
 * 兜底：一段时间没有任何移动事件就把这次拖动收口。
 *
 * 指针捕获正常时永远不会触发。它防的是捕获没拿到、pointerup 又发生在窗口外
 * 的那种极端情况——那时渲染层会一直以为还在拖，主进程这边也就一直跟着光标跑，
 * 表现为「没按键，球却跟着鼠标走」。宁可让一次拖动提前结束（再按一下即可），
 * 也不要让状态永久卡在「正在拖动」。
 */
function armDragWatchdog(): void {
  if (dragWatchdog) clearTimeout(dragWatchdog)
  dragWatchdog = setTimeout(() => endDrag(), 5000)
}

function clearDragWatchdog(): void {
  if (dragWatchdog) clearTimeout(dragWatchdog)
  dragWatchdog = null
}

/**
 * 开始拖动。cursor 是按下那一刻的光标屏幕坐标（渲染层 pointerdown 的
 * screenX/screenY，CSS 像素，与 setBounds 的 DIP 同尺度）。
 */
export function beginDrag(cursor: { x: number; y: number }): void {
  const win = getOrbWindow()
  if (!win) return
  const b = win.getBounds()
  dragStartPos = { x: b.x, y: b.y }
  dragAcc.begin({ x: b.x, y: b.y }, cursor)
  dragActive = true
  armDragWatchdog()
  // 立刻就位一次：把可能已经被撑大的窗口拉回标准尺寸。
  // 这一次不产生位移（位置不变），所以不会引起跳动。
  if (b.width !== dragSize.width || b.height !== dragSize.height) {
    win.setBounds({ x: b.x, y: b.y, width: dragSize.width, height: dragSize.height })
  }
}

/**
 * 拖动中：只把「光标这一帧比上一帧挪了多少」累加到窗口位置上。
 * 不读绝对坐标，因此不受任何坐标系原点/缩放取整差异的影响。
 *
 * 每一步都夹进当前屏幕的可见区：球一旦出界，就可能再也拖不回来
 * （窗口在屏幕外时收不到指针事件）。在过程中夹，而不是等松手才夹，
 * 也顺带消除了「松手时球突然跳一下」的观感。
 */
export function moveOrbTo(cursor: { x: number; y: number }): void {
  if (!dragActive) return
  const win = getOrbWindow()
  if (!win) return
  armDragWatchdog()

  const next = dragAcc.step(cursor)
  if (!next) return
  const area = screen.getDisplayNearestPoint({ x: cursor.x, y: cursor.y }).workArea
  const pos = clampToDisplay(next.x, next.y, dragSize.width, area)
  // 只有真的被夹住时才回写累加器。无条件回写会把取整后的小数抹掉——
  // 每帧丢 0.3px，几十帧后就是可见的「拖不到位」（实测 60 帧少走 20px）。
  if (pos.x !== next.x || pos.y !== next.y) dragAcc.set(pos)
  win.setBounds({ x: pos.x, y: pos.y, width: dragSize.width, height: dragSize.height })
}

/** 松手：把落点夹进屏幕并落盘。重复调用是安全的 */
export function endDrag(): void {
  if (!dragActive) return
  dragActive = false
  dragAcc.end()
  clearDragWatchdog()
  const win = getOrbWindow()
  if (!win) return
  const b = win.getBounds()
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  // 用按下时钉住的尺寸来夹边，不用 b.width：后者可能已经被 setPosition 撑大过
  const pos = clampToDisplay(b.x, b.y, dragSize.width, area)
  // 一次纯点击（按住没动）也会走到这里。位置没变就别碰窗口、也别写配置——
  // 球是要被反复点的，每点一下落一次盘没有必要
  if (pos.x === dragStartPos.x && pos.y === dragStartPos.y) return
  win.setBounds({ x: pos.x, y: pos.y, width: dragSize.width, height: dragSize.height })
  prefs = { ...prefs, x: pos.x, y: pos.y }
  hooks?.onPositionSaved(pos.x, pos.y)
  if (isPanelVisible()) positionPanel()
}

export function isDragging(): boolean {
  return dragActive
}

/** 设置里改了位置/贴边等：把窗口挪回该在的地方 */
export function repositionOrb(): void {
  const win = getOrbWindow()
  if (!win) return
  const b = win.getBounds()
  // 尺寸以创建的 72 为准，不读 b.width：透明窗口的 bounds 会被撑大（见 dragSize 的说明）
  const size = ORB_SIZE
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  const pos =
    prefs.x === null || prefs.y === null
      ? defaultOrbPosition(size, area)
      : clampToDisplay(prefs.x, prefs.y, size, area)
  win.setBounds({ x: pos.x, y: pos.y, width: size, height: size })
  if (isPanelVisible()) positionPanel()
}

/* ---------------- 生命周期 ---------------- */

function registerHotkey(): void {
  globalShortcut.unregisterAll()
  const key = prefs.hotkey.trim()
  if (!key) return
  try {
    globalShortcut.register(key, () => togglePanel())
  } catch {
    // 被别的程序占用了：设置页读得到失败状态，不该因此让应用起不来
  }
}

export function hotkeyRegistered(): boolean {
  const key = prefs.hotkey.trim()
  if (!key) return false
  return globalShortcut.isRegistered(key)
}

export function applyOrbPrefs(next: OrbPrefs, h: OrbHooks): void {
  hooks = h
  const wantVisible = next.enabled
  const posChanged = next.x !== prefs.x || next.y !== prefs.y
  prefs = next

  if (!wantVisible) {
    const win = getOrbWindow()
    if (win) win.hide()
    hidePanel()
  } else {
    if (!orbWindow || orbWindow.isDestroyed()) {
      orbWindow = createOrbWindow()
    } else {
      orbWindow.show()
      if (posChanged) repositionOrb()
      sendToOrb('orb:prefs', prefs)
    }
  }
  // 面板可能开着：让它的渲染层立刻跟上动画与尺寸相关的偏好
  sendToPanel('orb:prefs', prefs)
  registerHotkey()
}

export function createOrb(h: OrbHooks): void {
  hooks = h
  if (prefs.enabled) orbWindow = createOrbWindow()
  registerHotkey()
}

export function destroyOrb(): void {
  globalShortcut.unregisterAll()
  for (const win of [panelWindow, orbWindow]) {
    if (win && !win.isDestroyed()) win.destroy()
  }
  panelWindow = null
  orbWindow = null
}

/** 当前偏好（渲染层要读它决定动画开关） */
export function currentOrbPrefs(): OrbPrefs {
  return prefs
}
