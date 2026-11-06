import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatSession, ProjectDef, TodoDef } from '../../../shared/types'

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
const KIND_RANK: Record<Kind, number> = { project: 0, plan: 1, task: 2, session: 3 }

/** 会话消息是渲染层结构，这里只取文本和 id */
function readMessage(raw: unknown): { id: string; text: string } {
  if (!raw || typeof raw !== 'object') return { id: '', text: '' }
  const rec = raw as { id?: unknown; text?: unknown }
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    text: typeof rec.text === 'string' ? rec.text : ''
  }
}

/**
 * 在原文里找 needle 的位置。needle 必须已经是小写——之前这里把原文小写、
 * 却拿原始输入去比，搜 "WeChat" 能命中结果却标不出高亮、摘要也从开头截。
 */
function findAt(text: string, needle: string): number {
  if (!needle) return -1
  const lower = text.toLowerCase()
  // 少数 Unicode 字符小写后长度会变，位置就对不上了：那种情况宁可不标
  if (lower.length !== text.length) return -1
  return lower.indexOf(needle)
}

function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = findAt(flat, needle)
  if (at < 0) return flat.slice(0, 70)
  const start = Math.max(0, at - 18)
  return `${start > 0 ? '…' : ''}${flat.slice(start, at + needle.length + 46)}`
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

/** 全局搜索：项目 / 方案 / 任务 / 会话，Ctrl+K 呼出 */
export function GlobalSearch({ open, onClose, onOpenProject, onOpenChat }: Props) {
  const [query, setQuery] = useState('')
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [todos, setTodos] = useState<TodoDef[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
    void (async () => {
      const [p, t, s] = await Promise.all([
        window.butler.projects.list(),
        window.butler.todos.list(),
        window.butler.sessions.list()
      ])
      setProjects(p)
      setTodos(t)
      setSessions(s)
    })()
  }, [open])

  const projectName = (id?: string): string => projects.find((p) => p.id === id)?.name ?? '未归属'

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: Hit[] = []

    for (const project of projects) {
      const hay = [project.name, project.goal, project.context, project.constraints].filter(Boolean).join(' ')
      if (hay.toLowerCase().includes(q)) {
        out.push({
          key: `p-${project.id}`,
          kind: 'project',
          title: project.name,
          sub: project.goal || '项目',
          projectId: project.id
        })
      }
    }

    for (const project of projects) {
      for (const plan of project.plans ?? []) {
        const hay = [plan.title, plan.body, plan.decision, plan.recommended].filter(Boolean).join(' ')
        if (hay.toLowerCase().includes(q)) {
          out.push({
            key: `pl-${plan.id}`,
            kind: 'plan',
            title: plan.title,
            sub: `${project.name} · ${snippet(plan.body, q)}`,
            projectId: project.id,
            planId: plan.id
          })
        }
      }
    }

    for (const todo of todos) {
      const hay = [todo.title, todo.detail, todo.option].filter(Boolean).join(' ')
      if (hay.toLowerCase().includes(q)) {
        out.push({
          key: `t-${todo.id}`,
          kind: 'task',
          title: todo.title,
          sub: `${projectName(todo.projectId)}${todo.option ? ` · ${todo.option}` : ''}`,
          projectId: todo.projectId
        })
      }
    }

    if (q.length >= 2) {
      for (const session of sessions.slice(0, 120)) {
        let messageId = ''
        let sub = ''
        if (session.title.toLowerCase().includes(q)) {
          sub = '标题命中'
        } else {
          for (const raw of session.messages) {
            const msg = readMessage(raw)
            if (msg.text.toLowerCase().includes(q)) {
              messageId = msg.id
              sub = snippet(msg.text, q)
              break
            }
          }
        }
        if (sub) {
          out.push({
            key: `s-${session.id}-${messageId || 'title'}`,
            kind: 'session',
            title: session.title,
            sub,
            sessionId: session.id,
            messageId: messageId || undefined
          })
        }
      }
    }

    return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]).slice(0, 40)
  }, [query, projects, todos, sessions])

  useEffect(() => {
    setCursor(0)
  }, [query])

  // 用方向键移动光标时跟着滚：结果超过一屏后，选中项会跑到可视区外
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.gs-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  /** 高亮与摘要都按小写比对：结果命中与否用的是小写，标红必须同一口径 */
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
          <div className="gs-empty">{query.trim() ? '没有匹配的结果' : '输入关键词开始搜索'}</div>
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
