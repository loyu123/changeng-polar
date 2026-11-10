import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 字段旁的「?」：默认收起，点一下展开。
 *
 * 为什么要有这个：设置页原来每个字段下面挂一段 40~235 字的说明，
 * 一屏里能堆四五百字，用户想找"我该填什么"得在解释里翻。
 *
 * **为什么用 portal + fixed 而不是 absolute**（这版改的原因）：
 * 设置页的字段装在 `.cardbox` 里（`overflow: hidden`），外面还套着
 * `.form`（`overflow-y: auto`）。绝对定位的浮层会被这两层一起裁掉 ——
 * 实测表现就是"浮层只露出一截，下半截被切了"。渲染到 body 上、
 * 用 fixed 按按钮位置算坐标，就不受任何祖先的 overflow 影响。
 */
export function FieldHelp({
  children,
  label = '说明'
}: {
  children: ReactNode
  /** 无障碍标签 + 鼠标悬停提示 */
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

  /** 按按钮位置算浮层坐标，并做视口边缘收口 */
  const place = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const width = 300 // 与 CSS 的 max-width 一致
    const gap = 6
    const margin = 8

    // 水平：默认居中对齐按钮，贴边就往里推
    let left = r.left + r.width / 2 - width / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))

    // 垂直：默认在按钮下方；下面放不下就翻到上方
    const below = window.innerHeight - r.bottom - gap - margin
    const above = r.top - gap - margin
    const preferBelow = below >= 140 || below >= above
    const maxHeight = Math.max(120, Math.min(260, preferBelow ? below : above))
    const top = preferBelow ? r.bottom + gap : Math.max(margin, r.top - gap - maxHeight)

    setPos({ top, left, maxHeight })
  }, [])

  // 打开时算一次；窗口尺寸变化/滚动时跟着走
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    const onChange = (): void => place()
    window.addEventListener('resize', onChange)
    // capture 阶段才收得到页面内滚动容器的事件
    window.addEventListener('scroll', onChange, true)
    return () => {
      window.removeEventListener('resize', onChange)
      window.removeEventListener('scroll', onChange, true)
    }
  }, [open, place])

  // 点别处 / Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`fh-btn${open ? ' on' : ''}`}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="fh-pop"
            role="tooltip"
            style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  )
}
