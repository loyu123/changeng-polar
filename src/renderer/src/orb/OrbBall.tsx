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

  /** 按下点与「是否已经算作拖动」。指针捕获之后，这些状态只在一次按下会话内有效 */
  const pressRef = useRef({ x: 0, y: 0, moved: false, active: false, pointerId: -1 })
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
    /**
     * 兜底：窗口失焦或指针捕获意外丢失时收口。
     *
     * 不这么做的后果在真机上很直观——球只有 72px，鼠标一拖就出了窗口边界。
     * 没有指针捕获时，松开发生在窗口外面，渲染层根本收不到 pointerup，
     * 于是「正在拖动」这个状态永远留在 true：此后鼠标在球附近任何一次移动
     * 都会被当成拖动，球就自己飘起来了。
     */
    const abort = (): void => {
      const p = pressRef.current
      if (!p.active) return
      p.active = false
      setDragging(false)
      window.butler.orb.dragEnd()
    }
    window.addEventListener('blur', abort)
    return () => window.removeEventListener('blur', abort)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // 捕获这只指针：之后即使光标移出这 72px 的窗口，pointermove / pointerup
    // 仍然会发到这里（Chromium 会向系统申请鼠标捕获）。这是球能一直跟着走、
    // 并且松手一定能被收到的前提。
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 个别情况下指针已失效；退化成普通事件流也不会崩
    }
    pressRef.current = { x: e.screenX, y: e.screenY, moved: false, active: true, pointerId: e.pointerId }
    window.butler.orb.dragStart(e.screenX, e.screenY)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = pressRef.current
    if (!p.active || e.pointerId !== p.pointerId) return
    // 阈值只是用来区分「点击」和「拖动」；一旦开始拖就不再回头看位移
    if (!p.moved) {
      if (Math.hypot(e.screenX - p.x, e.screenY - p.y) < 4) return
      p.moved = true
      setDragging(true)
    }
    // 只报坐标：主进程按「这一帧与上一帧的差」累加窗口位置，不做绝对定位
    window.butler.orb.dragMove(e.screenX, e.screenY)
  }

  const finishPress = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = pressRef.current
    if (!p.active || e.pointerId !== p.pointerId) return
    p.active = false
    setDragging(false)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 已自动释放 */
    }
    // 不论点还是拖都要收口：按下时已经开了场，纯点击不关会让「正在拖动」悬着。
    // 位置没变时主进程自己会跳过落盘，所以点一下不会写配置。
    window.butler.orb.dragEnd()
    if (!p.moved) {
      // 没移动 = 点击：展开/收起面板（球是 focusable:false，点它不会把面板的焦点抢走，
      // 所以不会先触发面板的 blur 再被这里重新打开）
      void window.butler.orb.toggle()
    }
  }

  const cls = ['ball', state, idleAnimation ? '' : 'no-idle-anim'].filter(Boolean).join(' ')

  return (
    <div
      className={`ball-wrap${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPress}
      onPointerCancel={finishPress}
      onLostPointerCapture={finishPress}
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
