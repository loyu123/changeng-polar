import { desktopCapturer, screen } from 'electron'

/**
 * 屏幕截图（给授权卡看当前画面用）。
 *
 * 为什么不用 PowerShell 的 `CopyFromScreen`：实测被安全软件拦成
 * `ScriptContainedMaliciousContent`——屏幕抓取是敏感操作，AMSI 会扫。
 * Electron 自带的 `desktopCapturer` 一样能拿画面，还不用起子进程。
 *
 * **只截包含目标坐标的那一块屏幕**：双显示器时全拼起来既费流量又让标记坐标变复杂。
 * 这次要点的位置在哪块屏上，就截哪块。
 */

export interface Shot {
  /** data URI，可以直接塞进 <img src> */
  dataUrl: string
  width: number
  height: number
  /** 这块屏幕左上角在虚拟桌面里的坐标（副屏可能在左边，为负） */
  originX: number
  originY: number
  /** 缩放比例：截图像素 / 屏幕像素（<= 1） */
  scale: number
}

/** 找包含该坐标的显示器；没给坐标就用主屏 */
function displayFor(x?: number, y?: number): Electron.Display {
  const all = screen.getAllDisplays()
  if (typeof x === 'number' && typeof y === 'number') {
    const hit = all.find(
      (d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width && y >= d.bounds.y && y < d.bounds.y + d.bounds.height
    )
    if (hit) return hit
  }
  return screen.getPrimaryDisplay()
}

/**
 * 截一块屏幕。
 *
 * `maxWidth` 是**上限**：授权卡上的图不需要原始分辨率，手机流量也要省。
 * 返回的 `scale` 必须跟着走——标记点击位置要把屏幕坐标乘以它，
 * 否则标记会画在错误的像素上（缩了四倍还按原坐标画，就会偏到屏幕外）。
 */
export async function captureAt(x?: number, y?: number, maxWidth = 900): Promise<Shot> {
  const d = displayFor(x, y)
  const b = d.bounds
  const scale = Math.min(1, maxWidth / b.width)
  const targetW = Math.max(320, Math.round(b.width * scale))
  const targetH = Math.max(200, Math.round(b.height * scale))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  })
  // display_id 对得上就用它；对不上（某些驱动不填）就退回第一个
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0]
  if (!src) throw new Error('拿不到屏幕画面（desktopCapturer 没返回任何来源）')

  const img = src.thumbnail
  const size = img.getSize()
  return {
    dataUrl: img.toDataURL(),
    width: size.width,
    height: size.height,
    originX: b.x,
    originY: b.y,
    scale
  }
}

/**
 * 把屏幕坐标换算成截图像素坐标（给授权卡画标记用）。
 *
 * 单独抽出来是为了能被测：这个换算错一位，标记就画错地方，
 * 而"标记画错"比"没有标记"更糟——用户会照着错的位置判断。
 */
export function toShotCoords(
  shot: Pick<Shot, 'originX' | 'originY' | 'scale'>,
  screenX: number,
  screenY: number
): { x: number; y: number } {
  return {
    x: (screenX - shot.originX) * shot.scale,
    y: (screenY - shot.originY) * shot.scale
  }
}
