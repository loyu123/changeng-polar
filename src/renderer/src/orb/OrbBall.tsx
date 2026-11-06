import { useEffect, useRef, useState } from 'react'

type BallState = 'idle' | 'think' | 'ask' | 'done'

/** 长庚标记：缺口环 + 四角星，与主窗口标题栏、应用图标同一份几何 */
function Mark(): React.ReactNode {
  return (
    <>
      <circle className="ring" cx="12" cy="12" r="8.5" pathLength={100} strokeDasharray="78 22" />
      <path
        className="star"
        d="M12 6.6 Q12.72 11.28 17.4 12 Q12.72 12.72 12 17.4 Q11.28 12.72 6.6 12 Q11.28 11.28 12 6.6Z"
      />
      <path
        className="spark"
        d="M17.7 4.5 Q17.99 6.16 19.65 6.45 Q17.99 6.74 17.7 8.4 Q17.41 6.74 15.75 6.45 Q17.41 6.16 17.7 4.5Z"
      />
    </>
  )
}

/**
 * 桌面上的球。
 *
 * 拖动没有用 CSS 的 -webkit-app-region: drag：那个区域会把点击事件整个吃掉，
 * 球就再也点不开了。这里自己算位移，松手时按移动距离区分「点击」与「拖动」。
 */
export function OrbBall(): React.ReactNode {
  const [state, setState] = useState<BallState>('idle')
  const [idleAnimation, setIdleAnimation] = useState(true)
  const [dragging, setDragging] = useState(false)

  /** 按下时的屏幕坐标与是否已经算作拖动 */
  const pressRef = useRef({ x: 0, y: 0, moved: false, active: false })
  const doneTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void window.butler.orb.state().then(({ prefs }) => setIdleAnimation(prefs.idleAnimation))
    const offPrefs = window.butler.orb.onPrefs((prefs) => setIdleAnimation(prefs.idleAnimation))
    const offStatus = window.butler.orb.onStatus((next) => {
      window.clearTimeout(doneTimer.current)
      setState(next)
      // 绿勾亮完自己回到待命，不需要谁再发一次
      if (next === 'done') {
        doneTimer.current = window.setTimeout(() => setState('idle'), 1200)
      }
    })
    return () => {
      offPrefs()
      offStatus()
      window.clearTimeout(doneTimer.current)
    }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const p = pressRef.current
      if (!p.active) return
      const dx = e.screenX - p.x
      const dy = e.screenY - p.y
      if (!p.moved && Math.hypot(dx, dy) < 4) return
      if (!p.moved) {
        p.moved = true
        setDragging(true)
      }
      window.butler.orb.dragMove(e.screenX, e.screenY)
    }
    const onUp = (): void => {
      const p = pressRef.current
      if (!p.active) return
      p.active = false
      setDragging(false)
      if (p.moved) {
        window.butler.orb.dragEnd()
      } else {
        // 没移动 = 点击：展开/收起面板（球是 focusable:false，点它不会把面板的焦点抢走，
        // 所以不会先触发面板的 blur 再被这里重新打开）
        void window.butler.orb.toggle()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    // 交给主进程的是「按下点相对窗口左上角」的偏移，拖动时窗口才跟得住鼠标
    window.butler.orb.dragStart(e.clientX, e.clientY)
    pressRef.current = { x: e.screenX, y: e.screenY, moved: false, active: true }
  }

  const cls = ['ball', state, idleAnimation ? '' : 'no-idle-anim'].filter(Boolean).join(' ')

  return (
    <div
      className={`ball-wrap${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
      onContextMenu={(e) => {
        e.preventDefault()
        void window.butler.orb.menu()
      }}
      title="点一下跟我说话 · 右键更多"
    >
      <div className={cls}>
        {state === 'done' ? (
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="#3AA76D" strokeWidth="1.9" strokeLinecap="round" />
            <path
              d="M8 12.3l2.8 2.7 5-5.2"
              fill="none"
              stroke="#3AA76D"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <Mark />
          </svg>
        )}
        {state === 'ask' && <span className="badge" />}
      </div>
    </div>
  )
}
