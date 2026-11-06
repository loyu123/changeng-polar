import { useEffect, useRef, useState } from 'react'
import type {
  AuthAnswer,
  AuthRequest,
  ChatMessage,
  ChatSession,
  Evidence,
  ProjectDef,
  ToolTrace
} from '../../../shared/types'
import { MarkdownText } from '../components/MarkdownText'
import { SaveToProject } from '../components/SaveToProject'
import { conclusionOf, speak, stopSpeaking } from '../utils/speech'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 产生这条消息的时间（ms）。旧会话里没有这个字段，加载时用会话时间补齐 */
  ts?: number
  status?: string
  tools: ToolTrace[]
  evidence: Evidence[]
  unsourced?: boolean
  error?: string
  streaming?: boolean
  /** 等待/已作答的授权卡 */
  auth?: AuthRequest
  authAnswer?: AuthAnswer
}

const EFFECT_LABEL: Record<string, { text: string; tone: 'danger' | 'muted' }> = {
  destroy: { text: '销毁类操作 · 逐次授权', tone: 'danger' },
  install: { text: '会安装软件 · 逐次授权', tone: 'danger' },
  write: { text: '会改动内容 · 可撤回', tone: 'muted' },
  ui: { text: '只打开界面', tone: 'muted' },
  read: { text: '只读', tone: 'muted' }
}

function AuthCard({ request, answer, onAnswer }: { request: AuthRequest; answer?: AuthAnswer; onAnswer: (a: AuthAnswer) => void }) {
  const tone = EFFECT_LABEL[request.effect] ?? EFFECT_LABEL.read
  const boxRef = useRef<HTMLDivElement | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  // onAnswer 每次渲染都是新函数，放进 ref 才不会让监听器反复解绑重绑
  const answerRef = useRef(onAnswer)
  answerRef.current = onAnswer

  useEffect(() => {
    if (answer) return
    // 卡一出现就把焦点放进来：键盘用户不用先 Tab 十几下找按钮
    primaryRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answerRef.current('deny')
        return
      }
      if (e.key !== 'Tab') return
      const box = boxRef.current
      if (!box) return
      const items = Array.from(box.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = active ? box.contains(active) : false
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [answer])

  return (
    <div
      ref={boxRef}
      role="group"
      aria-label={`需要确认：${request.title}`}
      className={`authcard${answer ? ' decided' : ''}${tone.tone === 'danger' ? ' danger' : ''}`}
    >
      <div className="authcard-h">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" />
          <path d="M5.6 7V5.2a2.4 2.4 0 014.8 0V7" />
        </svg>
        {answer ? '本次操作已作答' : '需要你确认'}
        <span className="tag">{tone.text}</span>
      </div>
      <div className="authcard-t">{request.title}</div>
      <div className="authcard-kv">
        <b>目标</b>
        <span>{request.target}</span>
      </div>
      <div className="authcard-kv">
        <b>影响</b>
        <span>{request.impact}</span>
      </div>
      {request.undoHint && (
        <div className="authcard-kv">
          <b>能撤回</b>
          <span>{request.undoHint}</span>
        </div>
      )}
      {request.reinstallHint && (
        <div className="authcard-kv">
          <b>怎么装回</b>
          <span>{request.reinstallHint}</span>
        </div>
      )}
      {answer === 'expired' ? (
        <div className="authcard-result">授权卡 60 秒未响应，已自动按拒绝处理，什么都没有改动</div>
      ) : answer ? (
        <div className="authcard-result">
          {answer === 'deny' ? '你拒绝了这次操作，什么都没有改动' : '你允许了这次操作'}
        </div>
      ) : (
        <div className="authcard-btns">
          <button ref={primaryRef} className="btn btn-primary btn-sm" onClick={() => onAnswer('once')}>
            允许这一次
          </button>
          {request.allowAlways && (
            <button className="btn btn-ghost btn-sm" onClick={() => onAnswer('always')}>
              始终允许
            </button>
          )}
          <button className="btn btn-ghost btn-sm deny" onClick={() => onAnswer('deny')}>
            拒绝
          </button>
          <span style={{ fontSize: 11, color: '#7A7A7A', marginLeft: 'auto' }}>Esc 拒绝 · Tab 切换</span>
        </div>
      )}
    </div>
  )
}

interface Props {
  prefill: { text: string; nonce: number }
  info: { machineName: string; userName: string } | null
  /** 输入框右下角的模型标记 / 首页「权限设置」：跳到设置对应分区 */
  onOpenSettings?: (section?: 'model' | 'security') => void
  /** 中栏「项目」分组：跳到项目页 */
  onOpenProjects?: () => void
  /** 从项目页「出自对话」或全局搜索跳过来：打开这条会话，有 messageId 就定位那条回答 */
  focusChat?: { sessionId: string; messageId?: string; nonce: number } | null
}

/** 首页快捷问题：每一项都是当前工具真能回答的 */
const SUGGESTS: Array<{ text: string; icon: string }> = [
  { text: '这台机器上装了哪些应用', icon: 'M3.2 4.6h17.6v11.4H3.2zM9 20h6M12 16.2V20' },
  { text: '开机会自己起来什么', icon: 'M12 3.6v8M8.2 6.6A7 7 0 1 0 15.8 6.6' },
  { text: '看看邮箱里有什么未读', icon: 'M3.4 5.6h17.2v12.8H3.4zM4.2 7.2l7.1 5.3c.4.3 1 .3 1.4 0l7.1-5.3' },
  { text: '这个软件是做什么的', icon: 'M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4ZM15.4 15.4 20 20' }
]

/** 稳定的消息 id：方案/任务的"出处"要能跨重启定位到同一条回答 */
const nextId = (): string => crypto.randomUUID()

/** 中栏「最近」列表的一条会话：整段消息存在 userData/sessions.json，点开即恢复 */
interface Session {
  id: string
  ts: number
  title: string
  messages: Msg[]
}
/** 旧版把会话塞在 localStorage（只留 20 条），首次启动搬到磁盘 */
const LEGACY_KEY = 'polar-chat-sessions'
const SESSIONS_MAX = 200

function readLegacySessions(): Session[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    const list = raw ? (JSON.parse(raw) as Session[]) : []
    return Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.messages)).slice(0, 20) : []
  } catch {
    return []
  }
}

/** 主进程只负责存取，消息结构在这里还原成渲染层类型 */
function toSession(raw: ChatSession): Session {
  // 旧版本没存 ts：用会话时间补上，否则回看历史时每条都显示"现在"
  const messages = (raw.messages as Msg[]).map((m) => (typeof m?.ts === 'number' ? m : { ...m, ts: raw.ts }))
  return { id: raw.id, ts: raw.ts, title: raw.title, messages }
}

/** 一条消息的时间：取消息自己的 ts，没有就退回当前时间 */
function timeLabel(ts?: number): string {
  const d = new Date(typeof ts === 'number' ? ts : Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 中栏「最近」右侧的时间：今天给时分，昨天给「昨天」，一周内给星期，再往前给月/日 */
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= dayStart) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (ts >= dayStart - 86_400_000) return '昨天'
  if (ts >= dayStart - 6 * 86_400_000) return `周${'日一二三四五六'[d.getDay()]}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function trustOf(evidence: Evidence[]): { level: 'high' | 'mid' | 'low'; text: string; hint: string } {
  if (evidence.length === 0) {
    return { level: 'low', text: '可信度 低 · 本轮无出处', hint: '没有调用任何工具' }
  }
  const local = evidence.filter((e) => e.type === 'local').length
  const readFull = evidence.filter((e) => e.type === 'web' && (e.detail ?? '').includes('已读取正文')).length
  const webSearch = evidence.filter((e) => e.type === 'web' && !(e.detail ?? '').includes('已读取正文')).length
  if (local > 0 && readFull > 0) {
    return { level: 'high', text: `可信度 高 · ${evidence.length} 个来源`, hint: '本机实测 + 官方原文' }
  }
  if (local > 0) {
    return { level: 'high', text: `可信度 高 · 本机实测 ${local} 项`, hint: '来自注册表只读读取' }
  }
  if (readFull > 0) {
    return { level: 'high', text: `可信度 较高 · 官方原文 ${readFull} 篇`, hint: '已打开网页核对' }
  }
  return {
    level: 'mid',
    text: `可信度 中 · ${webSearch} 条检索结果`,
    hint: '只看了检索摘要，未读全文'
  }
}

function SourceBox({ evidence }: { evidence: Evidence[] }) {
  const [open, setOpen] = useState(evidence.length <= 3)
  return (
    <div className="srcbox">
      <div className="srcbox-h" onClick={() => setOpen(!open)}>
        来源 {evidence.length} 条
        <span className="cnt">{open ? '已展开' : '折叠'}</span>
        <span className={`chev${open ? '' : ' closed'}`}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </span>
      </div>
      {open &&
        evidence.map((item) => (
          <div className="src-row" key={item.id}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#8A8A8A" strokeWidth="1.5">
              {item.type === 'web' ? (
                <>
                  <path d="M6.6 9.4a3 3 0 004.2 0l1.8-1.8a3 3 0 00-4.2-4.2l-1 1" />
                  <path d="M9.4 6.6a3 3 0 00-4.2 0L3.4 8.4a3 3 0 004.2 4.2l1-1" />
                </>
              ) : (
                <>
                  <rect x="2" y="2.6" width="12" height="10.8" rx="1.6" />
                  <path d="M5.2 8h5.6" />
                </>
              )}
            </svg>
            <b>{item.title}</b>
            {item.url ? (
              <span className="dom" onClick={() => void window.butler.shell.open(item.url!)}>
                {hostOf(item.url)}
              </span>
            ) : (
              <span className="dom" style={{ color: '#7A7A7A', cursor: 'default' }}>
                {item.detail}
              </span>
            )}
            <span className="k">
              {item.url ? item.detail?.split(' · ')[0] : new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
    </div>
  )
}

export default function ChatPage({ prefill, info, onOpenSettings, onOpenProjects, focusChat }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  /** 正在跑的请求：点「停止」时要拿它去中断 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 这次是用户按的停止，不是真出错——收尾时显示「已停止」而不是红字 */
  const stoppedRef = useRef(false)
  /** 播报开关：默认关；打开后每轮回答结束自动朗读结论句 */
  const [voiceOn, setVoiceOn] = useState(false)
  /** 中栏「最近」会话列表 + 当前会话 id */
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [modelName, setModelName] = useState('')
  /** 中栏「项目」分组 */
  const [projects, setProjects] = useState<ProjectDef[]>([])
  /** 中栏搜索 */
  const [showSearch, setShowSearch] = useState(false)
  const [midQuery, setMidQuery] = useState('')
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** 已经处理过的出处跳转（避免会话刷新时重复滚动） */
  const lastFocusRef = useRef(0)
  /** 已经为哪一次跳转重拉过会话列表（防止 setSessions 触发自己无限重跑） */
  const refetchRef = useRef(0)
  /**
   * 画布上的消息是否比上次落盘的更新。
   * 没有这一位的话，「打开一条旧会话」也会被下面的保存 effect 当成刚发生：
   * 时间被改成现在、会话被顶到「最近」最前面，回看历史就等于篡改排序。
   */
  const dirtyRef = useRef(false)

  // 输入框底栏显示当前模型名（点它去设置里换）
  useEffect(() => {
    void window.butler.config.get().then((cfg) => setModelName(cfg.model ?? ''))
  }, [])

  // 中栏项目分组：项目页增删改后跟着刷新
  useEffect(() => {
    const reload = (): void => {
      void window.butler.projects.list().then(setProjects)
    }
    reload()
    window.addEventListener('polar:projects-changed', reload)
    return () => window.removeEventListener('polar:projects-changed', reload)
  }, [])

  // 会话从磁盘读；磁盘为空且本地还留着旧记录时，搬迁一次
  useEffect(() => {
    void (async () => {
      let list = await window.butler.sessions.list()
      if (list.length === 0) {
        const legacy = readLegacySessions()
        for (const item of legacy) await window.butler.sessions.save(item)
        if (legacy.length > 0) {
          localStorage.removeItem(LEGACY_KEY)
          list = await window.butler.sessions.list()
        }
      }
      setSessions(list.map(toSession))
    })()
  }, [])

  // 从项目页点「出自对话」：打开这条会话，滚到那条回答并闪一下
  useEffect(() => {
    if (!focusChat || focusChat.nonce === lastFocusRef.current) return
    const session = sessions.find((s) => s.id === focusChat.sessionId)
    if (!session) {
      // 桌面的「移到主窗口」刚把会话写进 sessions.json，这边的列表还是旧的。
      // 重拉一次就好——但必须按 nonce 只重拉一次：每次 setSessions 都会换新数组、
      // 让这个 effect 再跑一遍，不记住「已经拉过」就会无限循环。
      if (refetchRef.current === focusChat.nonce) return
      refetchRef.current = focusChat.nonce
      void window.butler.sessions.list().then((list) => setSessions(list.map(toSession)))
      return
    }
    lastFocusRef.current = focusChat.nonce
    dirtyRef.current = false
    setMessages(session.messages)
    setActiveSession(session.id)
    if (!focusChat.messageId) return
    window.setTimeout(() => {
      const el = document.getElementById(`msg-${focusChat.messageId}`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash-msg')
      window.setTimeout(() => el.classList.remove('flash-msg'), 1800)
    }, 60)
  }, [focusChat, sessions])

  // 一轮结束（非流式中、非等待授权中）就把当前消息落进「最近」列表
  useEffect(() => {
    if (busy || messages.length < 2) return
    if (messages[messages.length - 1].streaming) return
    // 只有真的产生了新消息才落盘（打开旧会话、切换会话都不算）
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const firstUser = messages.find((m) => m.role === 'user')
    if (!firstUser) return
    const id = activeSession ?? crypto.randomUUID()
    const entry: Session = { id, ts: Date.now(), title: firstUser.text.slice(0, 40), messages }
    setSessions((prev) => [entry, ...prev.filter((s) => s.id !== id)].slice(0, SESSIONS_MAX))
    void window.butler.sessions.save(entry)
    setActiveSession(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, messages])

  /** 删掉一条历史会话（磁盘 + 列表） */
  const removeSession = async (id: string): Promise<void> => {
    const list = await window.butler.sessions.delete(id)
    setSessions(list.map(toSession))
    if (activeSession === id) {
      setMessages([])
      setActiveSession(null)
    }
  }

  /** 新对话：当前那轮已在「最近」里，直接清空画布 */
  const newChat = (): void => {
    if (busy) return
    dirtyRef.current = false
    setMessages([])
    setActiveSession(null)
    setInput('')
    inputRef.current?.focus()
  }

  /** 打开一条旧会话：整段恢复（授权卡都已作答，只读展示） */
  const openSession = (s: Session): void => {
    if (busy) return
    dirtyRef.current = false
    setMessages(s.messages)
    setActiveSession(s.id)
  }

  useEffect(() => {
    if (prefill.text) {
      setInput(prefill.text)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.nonce])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const patch = (id: string, updater: (m: Msg) => Msg): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)))
  }

  const buildHistory = (list: Msg[], extra: string): ChatMessage[] => {
    const history: ChatMessage[] = list
      .filter((m) => m.text.trim() && !m.error)
      .map((m) => ({ role: m.role, content: m.text } as ChatMessage))
    history.push({ role: 'user', content: extra })
    return history.slice(-12)
  }

  /** 授权卡作答：交给主进程，然后就地标记（不依赖 done 事件，避免卡一直可点） */
  const answerAuth = async (request: AuthRequest, answer: AuthAnswer): Promise<void> => {
    setMessages((prev) => prev.map((m) => (m.auth?.id === request.id ? { ...m, authAnswer: answer, status: undefined } : m)))
    try {
      await window.butler.chat.answer(request.id, answer)
    } catch {
      /* 主进程已经收尾时这里可能返回 false，不影响界面标记 */
    }
    // 作答后把焦点还给输入框，键盘用户不用再找一遍
    inputRef.current?.focus()
  }

  /** 停止：中断请求，并把还没作答的授权卡按拒绝收口（主进程侧同步做） */
  const stop = async (): Promise<void> => {
    stoppedRef.current = true
    if (activeId) await window.butler.chat.abort(activeId)
  }

  const send = async (raw?: string): Promise<void> => {
    const text = (raw ?? input).trim()
    if (!text || busy) return
    const requestId = crypto.randomUUID()
    const botId = nextId()
    const snapshot = messages
    const now = Date.now()
    dirtyRef.current = true
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text, ts: now, tools: [], evidence: [] },
      { id: botId, role: 'assistant', text: '', ts: now, tools: [], evidence: [], streaming: true, status: '思考中…' }
    ])
    setInput('')
    setBusy(true)
    setActiveId(requestId)
    stoppedRef.current = false

    // 工具调用的中间事件只增不改；最终状态一律以 invoke 的返回值为准，
    // 避免 done 事件与 invoke 回复在通道上的先后不确定导致消息一直"流式中"。
    const off = window.butler.chat.onEvent((event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'delta') {
        patch(botId, (m) => ({ ...m, text: m.text + event.text, status: undefined }))
      } else if (event.type === 'status') {
        patch(botId, (m) => ({ ...m, status: m.text ? undefined : event.text }))
      } else if (event.type === 'tool') {
        patch(botId, (m) => ({
          ...m,
          tools: [...m.tools, { name: event.name, label: event.label, ok: true, effect: event.effect, args: {} }],
          status: `正在${event.label}…`
        }))
      } else if (event.type === 'auth') {
        patch(botId, (m) => ({ ...m, auth: event.request, authAnswer: undefined, status: '等你确认…' }))
      } else if (event.type === 'authExpired') {
        // 卡 60 秒没响应：主进程已按拒绝收口，界面同步标成超时，不用等 turn 结束
        patch(botId, (m) => (m.auth?.id === event.authId ? { ...m, authAnswer: 'expired', status: undefined } : m))
      }
    })

    try {
      const result = await window.butler.chat.send(requestId, buildHistory(snapshot, text))
      if (stoppedRef.current) {
        // 用户自己按的停止：把已生成的部分留下，补一句「已停止」，不当成报错
        patch(botId, (m) => ({
          ...m,
          text: m.text ? `${m.text}\n\n（已停止）` : '（已停止，这次没有继续）',
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
        }))
      } else if (result && 'error' in result) {
        patch(botId, (m) => ({
          ...m,
          error: result.error,
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
        }))
      } else if (result) {
        patch(botId, (m) => ({
          ...m,
          text: result.text,
          evidence: result.evidence,
          unsourced: result.unsourced,
          tools: result.tools,
          status: undefined,
          streaming: false,
          // 请求结束时主进程会把没作答的卡按「拒绝」收口，界面保持一致
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
        }))
        // 播报开关开着 = 用户明确要听：只读结论句，不读正文
        if (voiceOn) speak(conclusionOf(result.text))
      }
    } catch (err) {
      if (stoppedRef.current) {
        patch(botId, (m) => ({
          ...m,
          text: m.text ? `${m.text}\n\n（已停止）` : '（已停止，这次没有继续）',
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
        }))
      } else {
        patch(botId, (m) => ({
          ...m,
          error: err instanceof Error ? err.message : String(err),
          status: undefined,
          streaming: false,
          authAnswer: m.auth && !m.authAnswer ? 'deny' : m.authAnswer
        }))
      }
    } finally {
      setBusy(false)
      setActiveId(null)
      off()
    }
  }

  const composerEl = (
    <div className="composer">
      <textarea
        ref={inputRef}
        className="comp-input"
        placeholder="问点什么，或者直接让我去做…"
        value={input}
        rows={1}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="cbar">
        <button
          className={`cbtn${voiceOn ? ' on' : ''}`}
          title={voiceOn ? '播报已开：每轮结束自动读结论句' : '播报关闭：每条回答可点「播结论」单听'}
          onClick={() => {
            stopSpeaking()
            setVoiceOn((v) => !v)
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9.4h3l4.4-3.6v12.4L7 14.6H4z" />
            <path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8M18 6a8 8 0 0 1 0 12" />
          </svg>
        </button>
        <button
          className="cbtn2"
          title="让长庚先说明打算做什么、会影响什么，等你确认再动手"
          onClick={() => {
            setInput((prev) => (prev.trim() ? prev : '先说明你打算做什么、会影响什么，等我确认再动手：'))
            inputRef.current?.focus()
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3.6 19 6v5.4c0 4.2-2.9 7.5-7 8.8-4.1-1.3-7-4.6-7-8.8V6Z" />
            <path d="M9.2 11.8l2 2 3.7-3.7" />
          </svg>
          请求批准
        </button>
        <span className="csp" />
        <button
          className="cmodel"
          title={modelName ? `当前模型：${modelName}，点此更换` : '还没配模型，点此去设置'}
          onClick={() => onOpenSettings?.()}
        >
          <span className="cm-name">{modelName || '标准'} · 只读</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10l5 5 5-5" />
          </svg>
        </button>
        {busy ? (
          <button className="send" onClick={() => void stop()} title="停止（正在进行的检索/等待也会一起取消）">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="#fff">
              <rect x="4" y="4" width="8" height="8" rx="1.4" />
            </svg>
          </button>
        ) : (
          <button className="send" disabled={!input.trim()} onClick={() => void send()} title="发送">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.7">
              <path d="M8 13V3.4M3.8 7.6L8 3.4l4.2 4.2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )

  // 中栏（320px）：新对话 + 项目 + 最近会话清单（localStorage，仅本机）
  const recent = sessions.filter((s) => (midQuery.trim() ? s.title.toLowerCase().includes(midQuery.trim().toLowerCase()) : true))
  const midEl = (
    <aside className="mid">
      <div className="mid-h">
        <h2>长庚</h2>
        <span
          className="icobtn"
          role="button"
          title="搜索会话"
          style={showSearch ? { background: 'var(--sel)', color: 'var(--sel-ink)' } : undefined}
          onClick={() => setShowSearch((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.2" />
            <path d="M15.4 15.4 20 20" />
          </svg>
        </span>
      </div>
      <button className="newchat" onClick={newChat} disabled={busy} title="开始一段新对话（当前对话已在「最近」里）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        新对话
      </button>

      {showSearch && (
        <div className="searchbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.2" />
            <path d="M15.4 15.4 20 20" />
          </svg>
          <input autoFocus value={midQuery} onChange={(e) => setMidQuery(e.target.value)} placeholder="搜索会话" />
        </div>
      )}

      {projects.length > 0 && (
        <>
          <div className="seclabel">
            项目<span className="cnt">{projects.length}</span>
          </div>
          {projects.map((p) => (
            <button className="item" key={p.id} onClick={() => onOpenProjects?.()} title="去项目页管理">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.8 8.1V6.9c0-1 .8-1.8 1.8-1.8h3.2l1.7 2h7.7c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8Z" />
              </svg>
              <span className="t">{p.name}</span>
            </button>
          ))}
        </>
      )}

      <div className="seclabel">
        最近<span className="cnt">{sessions.length}</span>
      </div>
      {recent.length === 0 ? (
        <div className="empty-mid">
          <b>{sessions.length === 0 ? '还没有对话' : '没有匹配的会话'}</b>
          {sessions.length === 0 ? '问一句，这里会出现记录' : '换个词再搜一次'}
        </div>
      ) : (
        recent.map((s) => (
          <div key={s.id} className={`item item-act${activeSession === s.id ? ' sel' : ''}`}>
            <button className="item-main" onClick={() => openSession(s)} title={s.title}>
              <span className="t">{s.title}</span>
              <span className="tm">{dayLabel(s.ts)}</span>
            </button>
            <button className="item-del" title="删除这条会话" onClick={() => void removeSession(s.id)}>
              ×
            </button>
          </div>
        ))
      )}
    </aside>
  )

  // 空状态 = 概念图 01 的首页：云朵 + 居中输入框 + 快捷 chips
  if (messages.length === 0) {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        {midEl}
        <main className="content chat" style={{ padding: 0 }}>
          <div className="home-wrap">
          <div className="home">
            <svg className="cloud" width="80" height="60" viewBox="0 0 64 48" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 40h26a10 10 0 0 0 .8-19.9A13.2 13.2 0 0 0 21.6 17 9.4 9.4 0 0 0 20 40Z" />
              <path d="M32 22.4 Q32.9 27 37.5 27.9 Q32.9 28.8 32 33.4 Q31.1 28.8 26.5 27.9 Q31.1 27 32 22.4Z" fill="#C7DBEC" stroke="none" />
            </svg>
            <div className="ask">今天要做什么？</div>
            {composerEl}
            <div className="home-hint">
              只读查看本机<span className="dot" />写操作会先征求你的同意<span className="dot" />
              <button className="hint-link" onClick={() => onOpenSettings?.('security')}>
                权限设置
              </button>
            </div>
            <div className="chips">
              {SUGGESTS.map((s) => (
                <button className="chip" key={s.text} onClick={() => void send(s.text)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d={s.icon} />
                  </svg>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        </div>
        </main>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      {midEl}
      <main className="content chat" style={{ padding: 0 }}>
      <div className="thread" ref={threadRef}>
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="row-r" key={m.id} id={`msg-${m.id}`}>
              <div className="bubble-user">{m.text}</div>
            </div>
          ) : (
            <div className="row-l" key={m.id} id={`msg-${m.id}`}>
              <div className="avatar">
                <i />
              </div>
              <div className="bubble-bot">
                <div className="msg-from">
                  长庚 · {timeLabel(m.ts)}
                  {!m.streaming && m.text && !m.error && (
                    <button
                      className="say-btn"
                      onClick={() => {
                        if (window.speechSynthesis?.speaking) stopSpeaking()
                        else speak(conclusionOf(m.text))
                      }}
                      title="只朗读结论句，不读正文"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M3 6.2v3.6h2.6L9 12.6V3.4L5.6 6.2H3z" fill="currentColor" stroke="none" />
                        <path d="M11 5.4a3.6 3.6 0 010 5.2" />
                      </svg>
                      播结论
                    </button>
                  )}
                </div>
                {m.text ? (
                  <div className={`msg-body${m.streaming ? ' cursor-blink' : ''}`}>
                    <MarkdownText text={m.text} />
                  </div>
                ) : m.error ? null : (
                  <div className="tool-line">
                    <span className="spinner" />
                    {m.status ?? '思考中…'}
                  </div>
                )}

                {m.auth && (
                  <AuthCard request={m.auth} answer={m.authAnswer} onAnswer={(a) => void answerAuth(m.auth!, a)} />
                )}

                {m.error && <div className="msg-body err">出错了：{m.error}</div>}

                {m.tools.length > 0 && !m.streaming && (
                  <div className="bot-foot">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M6.6 9.4a3 3 0 004.2 0l1.8-1.8a3 3 0 00-4.2-4.2l-1 1" />
                      <path d="M9.4 6.6a3 3 0 00-4.2 0L3.4 8.4a3 3 0 004.2 4.2l1-1" />
                    </svg>
                    本轮动作：{m.tools.map((t) => t.label).join(' → ')}
                  </div>
                )}

                {!m.streaming && !m.error && m.evidence.length > 0 && (
                  <>
                    <div className="trust">
                      <span className={`badge-trust${trustOf(m.evidence).level === 'mid' ? ' mid' : trustOf(m.evidence).level === 'low' ? ' low' : ''}`}>
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M3 8.4l3.2 3.1L13 4.6" />
                        </svg>
                        {trustOf(m.evidence).text}
                      </span>
                      <span className="t2">{trustOf(m.evidence).hint}</span>
                    </div>
                    <SourceBox evidence={m.evidence} />
                  </>
                )}

                {!m.streaming && !m.error && m.unsourced && (
                  <div className="trust">
                    <span className="badge-trust low">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <circle cx="8" cy="8" r="6" />
                        <path d="M8 5.2v.2M8 7.6v3.4" />
                      </svg>
                      {m.tools.length > 0 ? '本轮动作没有产生可引用来源' : '本轮没有调用工具，回答不含出处'}
                    </span>
                  </div>
                )}

                {!m.streaming && !m.error && m.text && (
                  <SaveToProject
                    text={m.text}
                    projects={projects}
                    sessionId={activeSession ?? undefined}
                    messageId={m.id}
                    onOpenProjects={onOpenProjects}
                  />
                )}
              </div>
            </div>
          )
        )}
      </div>

      {composerEl}
      </main>
    </div>
  )
}
