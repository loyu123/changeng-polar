import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthAnswer, AuthRequest, ChatMessage, ChatSession, Evidence, ToolChoiceRequest } from '../../../shared/types'
import { MarkdownText } from '../components/MarkdownText'

/** 与主进程 runtime.ts 的 AUTH_TIMEOUT_MS 对齐：卡 60 秒没人理就按拒绝收口 */
const AUTH_TIMEOUT_MS = 60_000

/** 候选卡的两个非选项状态（与 ChatPage 一致，\u0000 开头不会撞真实候选值） */
const CANCEL = '\u0000cancel'
const EXPIRED = '\u0000expired'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  status?: string
  error?: string
  streaming?: boolean
  evidence: Evidence[]
  auth?: AuthRequest
  authAnswer?: AuthAnswer
  choice?: ToolChoiceRequest
  choiceAnswer?: string
}

const SUGGESTS = ['这台机器上装了哪些应用', '今天有哪些开机自启', '看看邮箱未读', '下载文件夹里最大的文件']

const nextId = (): string => crypto.randomUUID()

function Mark({ size = 14 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke="#A8C8E8"
        strokeWidth="2.1"
        pathLength={100}
        strokeDasharray="78 22"
        strokeLinecap="round"
      />
      <path
        d="M12 7.4 Q12.6 11.4 16.6 12 Q12.6 12.6 12 16.6 Q11.4 12.6 7.4 12 Q11.4 11.4 12 7.4Z"
        fill="#8CB6E0"
      />
    </svg>
  )
}

const EFFECT_LABEL: Record<string, { text: string; danger: boolean }> = {
  destroy: { text: '销毁类 · 逐次授权', danger: true },
  install: { text: '会安装软件 · 逐次授权', danger: true },
  write: { text: '会改动内容 · 可撤回', danger: false },
  ui: { text: '只打开界面', danger: false },
  read: { text: '只读', danger: false }
}

/**
 * 紧凑候选卡：名字有歧义时先让用户在窄面板里点一个。
 *
 * 面板小，但补充行（包 Id+版本 / 完整路径）**必须露出来**：
 * 同名候选只看名字分不出谁是谁，折进 title 提示等于在触屏和键盘操作下没有。
 * 没有这张卡，抽屉里点「装个 Kimi」会 60 秒超时，然后告诉用户"你取消了选择"，
 * 而用户根本没看见任何卡。宁可窄一点，不能假装问过。
 */
function CompactChoice({
  request,
  answer,
  onPick
}: {
  request: ToolChoiceRequest
  answer?: string
  onPick: (value: string) => void
}): React.ReactNode {
  const picked = answer && answer !== CANCEL && answer !== EXPIRED ? answer : null
  const pickedLabel = picked ? (request.options.find((o) => o.value === picked)?.label ?? picked) : null
  return (
    <div className="authc" role="group" aria-label={`需要选择：${request.title}`}>
      <div className="authc-h">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2.6 8.4h3.1l1.5 1.7h1.6l1.5-1.7h3.1" />
          <path d="M8 2.6v5.8M5.6 4.8 8 2.6l2.4 2.2" />
        </svg>
        {answer ? '已选择' : '需要你选一个'}
        <span className="tag">名字有歧义</span>
      </div>
      <div className="authc-t">{request.title}</div>
      {answer === EXPIRED ? (
        <div className="authc-result">60 秒未响应，已按取消处理，这一步没有执行</div>
      ) : answer === CANCEL ? (
        <div className="authc-result">你取消了选择，这一步没有执行</div>
      ) : pickedLabel ? (
        <div className="authc-result">你选了「{pickedLabel}」，正在按这个继续</div>
      ) : (
        <>
          <div className="authc-btns col">
            {request.options.map((opt) => (
              <button key={opt.value} className="abtn ghost opt" title={opt.detail} onClick={() => onPick(opt.value)}>
                {opt.label}
                {opt.detail && <span className="abtn-detail">{opt.detail}</span>}
              </button>
            ))}
          </div>
          <div className="authc-btns">
            <button className="abtn deny" onClick={() => onPick(CANCEL)}>
              都不是
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 紧凑授权卡。
 *
 * 比主窗口那张多一条倒计时：主窗口的卡也是 60 秒超时，但那里没显示，
 * 用户以为可以慢慢想，然后被无声拒绝。窄面板更隐蔽，必须给出来。
 */
function CompactAuth({
  request,
  answer,
  onAnswer
}: {
  request: AuthRequest
  answer?: AuthAnswer
  onAnswer: (a: AuthAnswer) => void
}): React.ReactNode {
  const tone = EFFECT_LABEL[request.effect] ?? EFFECT_LABEL.read
  const [left, setLeft] = useState(AUTH_TIMEOUT_MS)
  const primaryRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (answer) return
    primaryRef.current?.focus()
    const started = Date.now()
    const timer = window.setInterval(() => {
      const rest = AUTH_TIMEOUT_MS - (Date.now() - started)
      setLeft(Math.max(0, rest))
      if (rest <= 0) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [answer])

  const pct = Math.max(0, (left / AUTH_TIMEOUT_MS) * 100)
  const secs = Math.ceil(left / 1000)

  return (
    <div className={`authc${tone.danger ? ' warn' : ''}`} role="group" aria-label={`需要确认：${request.title}`}>
      <div className="authc-h">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" />
          <path d="M5.6 7V5.2a2.4 2.4 0 014.8 0V7" />
        </svg>
        {answer ? '本次操作已作答' : '需要你确认'}
        <span className="tag">{tone.text}</span>
      </div>
      <div className="authc-t">{request.title}</div>
      <div className="authc-kv">
        <b>目标</b>
        <span>{request.target}</span>
      </div>
      <div className="authc-kv">
        <b>影响</b>
        <span>{request.impact}</span>
      </div>
      {request.undoHint && (
        <div className="authc-kv">
          <b>能撤回</b>
          <span>{request.undoHint}</span>
        </div>
      )}
      {answer === 'expired' ? (
        <div className="authc-result">60 秒未响应，已按拒绝处理，什么都没有改动</div>
      ) : answer ? (
        <div className="authc-result">
          {answer === 'deny' ? '你拒绝了这次操作，什么都没有改动' : '你允许了这次操作'}
        </div>
      ) : (
        <>
          <div className="authc-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="authc-cd">
            <span>60 秒后自动按拒绝处理</span>
            <span>还剩 {secs} 秒</span>
          </div>
          <div className="authc-btns">
            <button ref={primaryRef} className="abtn primary" onClick={() => onAnswer('once')}>
              允许这一次
            </button>
            {request.allowAlways && (
              <button className="abtn ghost" onClick={() => onAnswer('always')}>
                始终允许
              </button>
            )}
            <button className="abtn deny" onClick={() => onAnswer('deny')}>
              拒绝
            </button>
          </div>
          <div className="authc-note">Esc 拒绝 · Tab 切换</div>
        </>
      )}
    </div>
  )
}

export function OrbPanel(): React.ReactNode {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  /** 是否有一条回答失败过（用来提示「模型没配」这类事） */
  const [activeReq, setActiveReq] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dirtyRef = useRef(false)
  const stoppedRef = useRef(false)

  /** 面板把对话状态报给主进程，球才知道自己该转圈还是转金 */
  const reportStatus = useCallback((s: 'idle' | 'think' | 'ask' | 'done') => {
    window.butler.orb.reportStatus(s)
  }, [])

  useEffect(() => {
    void window.butler.orb.sessions.list().then(setSessions)
    const off = window.butler.orb.onPanelShown(() => {
      inputRef.current?.focus()
    })
    inputRef.current?.focus()
    return off
  }, [])

  // 滚到底：面板里一次只该有一屏内容，不需要"要不要跟随"的判断
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // 面板收起时球回到待命
  useEffect(() => {
    const onHide = (): void => {
      if (!busy) reportStatus('idle')
    }
    window.addEventListener('blur', onHide)
    return () => window.removeEventListener('blur', onHide)
  }, [busy, reportStatus])

  /** 一轮结束、且真的产生过新消息，才落进桌面侧历史 */
  useEffect(() => {
    if (busy || messages.length < 2) return
    if (messages[messages.length - 1].streaming) return
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const firstUser = messages.find((m) => m.role === 'user')
    if (!firstUser) return
    const id = activeId ?? crypto.randomUUID()
    const entry: Partial<ChatSession> = {
      id,
      ts: Date.now(),
      title: firstUser.text.slice(0, 40),
      messages
    }
    void window.butler.orb.sessions.save(entry).then(() => {
      setActiveId(id)
      void window.butler.orb.sessions.list().then(setSessions)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages])

  const patch = (id: string, updater: (m: Msg) => Msg): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)))
  }

  const buildHistory = (list: Msg[], extra: string): ChatMessage[] => {
    const history: ChatMessage[] = list
      .filter((m) => m.text.trim() && !m.error)
      .map((m) => ({ role: m.role, content: m.text }) as ChatMessage)
    history.push({ role: 'user', content: extra })
    // 桌面侧是短对话：只带最近 6 条，别把上下文撑得比主窗口还长
    return history.slice(-6)
  }

  const answerAuth = async (request: AuthRequest, answer: AuthAnswer): Promise<void> => {
    setMessages((prev) =>
      prev.map((m) => (m.auth?.id === request.id ? { ...m, authAnswer: answer, status: undefined } : m))
    )
    try {
      await window.butler.chat.answer(request.id, answer)
    } catch {
      /* 主进程可能已经收口 */
    }
    if (answer !== 'deny') reportStatus('think')
    inputRef.current?.focus()
  }

  const pickChoice = async (request: ToolChoiceRequest, value: string): Promise<void> => {
    setMessages((prev) =>
      prev.map((m) => (m.choice?.id === request.id ? { ...m, choiceAnswer: value, status: undefined } : m))
    )
    try {
      await window.butler.chat.choose(request.id, value)
    } catch {
      /* 主进程可能已经收口 */
    }
    reportStatus('think')
    inputRef.current?.focus()
  }

  const stop = async (): Promise<void> => {
    stoppedRef.current = true
    if (activeReq) await window.butler.chat.abort(activeReq)
  }

  const send = async (raw?: string): Promise<void> => {
    const text = (raw ?? input).trim()
    if (!text || busy) return
    const requestId = nextId()
    const botId = nextId()
    const snapshot = messages
    dirtyRef.current = true
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text, ts: Date.now(), evidence: [] },
      { id: botId, role: 'assistant', text: '', ts: Date.now(), evidence: [], streaming: true, status: '思考中…' }
    ])
    setInput('')
    setBusy(true)
    setActiveReq(requestId)
    setShowHistory(false)
    stoppedRef.current = false
    reportStatus('think')

    const off = window.butler.chat.onEvent((event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'delta') {
        patch(botId, (m) => ({ ...m, text: m.text + event.text, status: undefined }))
      } else if (event.type === 'status') {
        patch(botId, (m) => ({ ...m, status: m.text ? undefined : event.text }))
      } else if (event.type === 'tool') {
        patch(botId, (m) => ({ ...m, status: `正在${event.label}…` }))
      } else if (event.type === 'auth') {
        patch(botId, (m) => ({ ...m, auth: event.request, authAnswer: undefined, status: '等你确认…' }))
        reportStatus('ask')
      } else if (event.type === 'authExpired') {
        patch(botId, (m) => (m.auth?.id === event.authId ? { ...m, authAnswer: 'expired', status: undefined } : m))
        reportStatus('think')
      } else if (event.type === 'choice') {
        patch(botId, (m) => ({ ...m, choice: event.request, choiceAnswer: undefined, status: '等你选一个…' }))
        reportStatus('ask')
      } else if (event.type === 'choiceExpired') {
        patch(botId, (m) => (m.choice?.id === event.choiceId ? { ...m, choiceAnswer: EXPIRED, status: undefined } : m))
        reportStatus('think')
      }
    })

    try {
      const result = await window.butler.chat.send(requestId, buildHistory(snapshot, text))
      if (stoppedRef.current) {
        patch(botId, (m) => ({
          ...m,
          text: m.text ? `${m.text}\n\n（已停止）` : '（已停止，这次没有继续）',
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer,
          choiceAnswer: m.choice && !m.choiceAnswer ? CANCEL : m.choiceAnswer
        }))
        reportStatus('idle')
      } else if (result && 'error' in result) {
        patch(botId, (m) => ({
          ...m,
          error: result.error,
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer,
          choiceAnswer: m.choice && !m.choiceAnswer ? CANCEL : m.choiceAnswer
        }))
        reportStatus('idle')
      } else if (result) {
        patch(botId, (m) => ({
          ...m,
          text: result.text,
          evidence: result.evidence,
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer,
          choiceAnswer: m.choice && !m.choiceAnswer ? CANCEL : m.choiceAnswer
        }))
        reportStatus('done')
      }
    } catch (err) {
      patch(botId, (m) => ({
        ...m,
        error: err instanceof Error ? err.message : String(err),
        status: undefined,
        streaming: false,
        authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
      }))
      reportStatus('idle')
    } finally {
      setBusy(false)
      setActiveReq(null)
      off()
    }
  }

  const openSession = (s: ChatSession): void => {
    if (busy) return
    dirtyRef.current = false
    setMessages(s.messages as Msg[])
    setActiveId(s.id)
    setShowHistory(false)
  }

  const newChat = (): void => {
    if (busy) return
    dirtyRef.current = false
    setMessages([])
    setActiveId(null)
    setShowHistory(false)
    inputRef.current?.focus()
  }

  const removeSession = async (id: string): Promise<void> => {
    const list = await window.butler.orb.sessions.delete(id)
    setSessions(list)
    if (activeId === id) {
      setMessages([])
      setActiveId(null)
    }
  }

  const promote = async (): Promise<void> => {
    const id = activeId
    if (!id) return
    const res = await window.butler.orb.promote(id)
    if (!res.ok) return
    // 搬走之后面板这边就空了：它是移交，不是共享
    setMessages([])
    setActiveId(null)
    setSessions(await window.butler.orb.sessions.list())
    void window.butler.orb.close()
  }

  // Esc 收起面板；有未作答的卡时按拒绝
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const pending = messages.find((m) => m.auth && !m.authAnswer)
      if (pending?.auth) {
        e.preventDefault()
        void answerAuth(pending.auth, 'deny')
        return
      }
      void window.butler.orb.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  const pendingAuth = useMemo(
    () => messages.some((m) => m.auth && !m.authAnswer),
    [messages]
  )
  const thinking = useMemo(
    () => messages.some((m) => m.streaming),
    [messages]
  )

  const statusText = pendingAuth ? '等你确认' : thinking ? '思考中' : '就绪'
  const dotCls = pendingAuth ? 'dot ask' : thinking ? 'dot think' : 'dot'

  return (
    <div className="panel">
      <div className="ph">
        <span className={dotCls} />
        <h3>长庚</h3>
        <span className={`sub${pendingAuth ? ' warn' : ''}`}>· {statusText}</span>
        <span className="sp" />
        <button
          className={`iconbtn${showHistory ? ' on' : ''}`}
          title={`桌面会话（${sessions.length}）`}
          onClick={() => setShowHistory((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="12" cy="12" r="8.3" />
            <path d="M12 7.4v4.9l3.2 2" />
          </svg>
        </button>
        <button
          className="iconbtn"
          title={activeId ? '移到主窗口（把这段对话归档进去）' : '当前还没有可归档的对话'}
          disabled={!activeId}
          style={activeId ? undefined : { opacity: 0.35, cursor: 'default' }}
          onClick={() => void promote()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4h6v6M20 4l-6.4 6.4M10 20H4v-6M4 20l6.4-6.4" />
          </svg>
        </button>
        <button className="iconbtn" title="收起" onClick={() => void window.butler.orb.close()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="pbody" ref={bodyRef}>
        {showHistory ? (
          <div className="hist">
            <div className="hist-h">
              桌面会话<span className="sp" />
              <span className="cap">保留最近 20 条</span>
            </div>
            {sessions.length === 0 ? (
              <div style={{ padding: '20px 6px', textAlign: 'center', fontSize: 11.8, color: 'var(--ink4)', lineHeight: 1.7 }}>
                还没有桌面会话。
                <br />
                面板里问过的话会留在这里。
              </div>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className={`hrow${activeId === s.id ? ' on' : ''}`} role="button" onClick={() => openSession(s)}>
                  <span className="t">{s.title}</span>
                  <span className="tm">
                    {new Date(s.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    className="del"
                    title="删除这条会话"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeSession(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
            <div className="hist-foot">想长期留着，用标题栏的「移到主窗口」</div>
          </div>
        ) : messages.length === 0 ? (
          <div className="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 16.4h18M6.6 16.4V9.8a5.4 5.4 0 0110.8 0v6.6M4.2 16.4h15.6" />
            </svg>
            <div>问点什么，或者直接让我去做</div>
            <div className="chips">
              {SUGGESTS.map((s) => (
                <button className="chip" key={s} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div className="msg-user" key={m.id}>
                {m.text}
              </div>
            ) : (
              <div className="msg-bot" key={m.id}>
                <span className="av">
                  <Mark />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {m.text ? (
                    <div className={`txt${m.streaming ? ' cursor-blink' : ''}`}>
                      <MarkdownText text={m.text} />
                    </div>
                  ) : m.error ? null : (
                    <div className="tool-line">
                      <span className="spinner" />
                      {m.status ?? '思考中…'}
                    </div>
                  )}

                  {m.choice && (
                    <CompactChoice request={m.choice} answer={m.choiceAnswer} onPick={(v) => void pickChoice(m.choice!, v)} />
                  )}
                  {m.auth && <CompactAuth request={m.auth} answer={m.authAnswer} onAnswer={(a) => void answerAuth(m.auth!, a)} />}

                  {m.error && <div className="txt err">出错了：{m.error}</div>}

                  {!m.streaming && !m.error && m.text && m.evidence.length > 0 && (
                    <div className="msg-meta">
                      <span className="chip-src">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 8.4l3.2 3.1L13 4.6" />
                        </svg>
                        {m.evidence.length} 个来源
                      </span>
                    </div>
                  )}
                  {!m.streaming && !m.error && m.text && m.evidence.length === 0 && (
                    <div className="msg-meta">
                      <span className="chip-src low">无出处</span>
                    </div>
                  )}
                </div>
              </div>
            )
          )
        )}
      </div>

      <div className="pfoot">
        <div className={`pinput${pendingAuth ? ' off' : ''}`}>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={pendingAuth ? '等你确认…' : '问点什么，或者直接让我去做…'}
            disabled={pendingAuth}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {busy ? (
            <button className="sendbtn" title="停止" onClick={() => void stop()}>
              <svg viewBox="0 0 16 16" fill="#fff" stroke="none">
                <rect x="4" y="4" width="8" height="8" rx="1.4" />
              </svg>
            </button>
          ) : (
            <button className="sendbtn" disabled={!input.trim() || pendingAuth} title="发送" onClick={() => void send()}>
              <svg viewBox="0 0 24 24">
                <path d="M12 19.4V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <div className="phint">Esc 收起 · 写操作会先征求你同意</div>
      </div>
    </div>
  )
}
