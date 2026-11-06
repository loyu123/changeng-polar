import { useEffect, useRef, useState } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  /** 打开项目；带 planId 时顺手展开那份方案 */
  onOpenProject: (projectId: string, planId?: string) => void
  /** 打开会话；带 messageId 时定位到那条消息 */
  onOpenChat: (sessionId: string, messageId?: string) => void
}

type Kind = 'project' | 'plan' | 'task' | 'session'

interface Hit {
  key: string
  kind: Kind
  title: string
  sub: string
  projectId?: string
  planId?: string
  sessionId?: string
  messageId?: string
}

const KIND_LABEL: Record<Kind, string> = { project: '项目', plan: '方案', task: '任务', session: '会话' }

/**
 * 在原文里找 needle 的位置。needle 必须是已小写的字符串——
 * 之前这里把原文小写、却拿原始输入去比，搜 "WeChat" 能命中却标不出高亮。
 */
function findAt(text: string, needle: string): number {
  if (!needle) return -1
  const lower = text.toLowerCase()
  // 少数 Unicode 字符小写后长度会变，位置就对不上了：那种情况宁可不标
  if (lower.length !== text.length) return -1
  return lower.indexOf(needle)
}

/** 把命中的词标出来 */
function highlight(text: string, needle: string): React.ReactNode {
  const at = findAt(text, needle)
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

/**
 * 全局搜索：项目 / 方案 / 任务 / 会话，Ctrl+K 呼出。
 *
 * 检索本身在主进程做（see main/node/search.ts）：这里只负责输入、键盘和渲染，
 * 不再把全部会话内容拉进窗口，也不再每次按键全量扫一遍。
 */
export function GlobalSearch({ open, onClose, onOpenProject, onOpenChat }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 只认最后一次请求的结果：输入快时旧请求可能后到，会把新结果盖掉 */
  const seqRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  // 搜索放到主进程：防抖 120ms，足够吞掉连续按键，又不至于让人觉得卡
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setHits([])
      setLoading(false)
      return
    }
    setLoading(true)
    const seq = ++seqRef.current
    const timer = window.setTimeout(() => {
      void window.butler.find
        .all(q)
        .then((result) => {
          if (seq !== seqRef.current) return
          setHits(result as Hit[])
          setCursor(0)
        })
        .catch(() => {
          if (seq !== seqRef.current) return
          setHits([])
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [query, open])

  // 用方向键移动光标时跟着滚：结果超过一屏后，选中项会跑到可视区外
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.gs-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  /** 高亮按小写比对：结果命中与否用的是小写，标红必须同一口径 */
  const needle = query.trim().toLowerCase()

  const activate = (hit: Hit): void => {
    onClose()
    if (hit.kind === 'session' && hit.sessionId) {
      onOpenChat(hit.sessionId, hit.messageId)
      return
    }
    if (hit.projectId) onOpenProject(hit.projectId, hit.planId)
  }

  return (
    <div className="gs-mask" onMouseDown={onClose}>
      <div className="gs" onMouseDown={(e) => e.stopPropagation()}>
        <div className="gs-input-row">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8E8E86" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.2" />
            <path d="M15.4 15.4 20 20" />
          </svg>
          <input
            ref={inputRef}
            className="gs-input"
            value={query}
            placeholder="搜项目、方案、任务、会话…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((v) => (hits.length === 0 ? 0 : Math.min(v + 1, hits.length - 1)))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((v) => Math.max(v - 1, 0))
              }
              if (e.key === 'Enter' && hits[cursor]) activate(hits[cursor])
            }}
          />
          <span className="gs-hint">Esc</span>
        </div>

        {hits.length === 0 ? (
          <div className="gs-empty">
            {!query.trim() ? '输入关键词开始搜索' : loading ? '搜索中…' : '没有匹配的结果'}
          </div>
        ) : (
          <div className="gs-list" ref={listRef}>
            {hits.map((hit, index) => {
              const showGroup = index === 0 || hits[index - 1].kind !== hit.kind
              return (
                <div key={hit.key}>
                  {showGroup && <div className="gs-group">{KIND_LABEL[hit.kind]}</div>}
                  <button
                    className={`gs-item${index === cursor ? ' on' : ''}`}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => activate(hit)}
                  >
                    <span className="gs-main">
                      <span className="gs-title">{highlight(hit.title, needle)}</span>
                      <span className="gs-sub">{highlight(hit.sub, needle)}</span>
                    </span>
                    <span className="gs-kind">{KIND_LABEL[hit.kind]}</span>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
