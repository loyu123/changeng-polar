import { useState } from 'react'
import type { ProjectDef, TodoPriority } from '../../../shared/types'

interface Props {
  /** 这条回答的全文（存成方案正文） */
  text: string
  projects: ProjectDef[]
  /** 出处：当前会话 id */
  sessionId?: string
  /** 出处：这条回答的 id */
  messageId?: string
  /** 没有项目时的出口 */
  onOpenProjects?: () => void
}

/** 从回答里取一个像标题的首行 */
function titleFrom(text: string, fallback: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[#>*\-+\s]+/, '').trim())
    .find((l) => l.length > 0)
  return (line ?? '').slice(0, 40) || fallback
}

/** 把一条对话回答落成项目里的实体：方案（整段正文）或任务（标题） */
export function SaveToProject({ text, projects, sessionId, messageId, onOpenProjects }: Props) {
  const [open, setOpen] = useState<'plan' | 'todo' | null>(null)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const start = (kind: 'plan' | 'todo'): void => {
    setOpen(kind)
    setError(null)
    setTitle(titleFrom(text, kind === 'plan' ? '未命名方案' : '未命名任务'))
    if (!projectId && projects[0]) setProjectId(projects[0].id)
  }

  const submit = async (): Promise<void> => {
    const project = projects.find((p) => p.id === projectId)
    if (!project || !title.trim()) return
    setBusy(true)
    setError(null)
    const source = sessionId && messageId ? { sessionId, messageId } : undefined
    try {
      if (open === 'plan') {
        await window.butler.projects.save({
          ...project,
          plans: [
            {
              id: crypto.randomUUID(),
              title: title.trim().slice(0, 60),
              body: text,
              createdAt: new Date().toISOString(),
              source
            },
            ...(project.plans ?? [])
          ]
        })
      } else {
        await window.butler.todos.save({
          projectId: project.id,
          title: title.trim().slice(0, 140),
          status: 'todo',
          priority,
          source
        })
      }
      window.dispatchEvent(new Event('polar:projects-changed'))
      setSaved(`已存入「${project.name}」`)
      setOpen(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <div className="save-bar">
        <span className="save-ok">{saved}</span>
      </div>
    )
  }

  return (
    <div className="save-bar">
      {open === null ? (
        <>
          <button className="say-btn" onClick={() => start('plan')} title="把这条回答整段存成项目里的一份方案">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 2.6h5.4L12.4 5.6v7.8H4z" />
              <path d="M9.2 2.8v3h3" />
            </svg>
            存为方案
          </button>
          <button className="say-btn" onClick={() => start('todo')} title="把这条回答变成一个待办，派发到项目">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 8.4l3 3 7-7" />
            </svg>
            存为任务
          </button>
        </>
      ) : (
        <div className="save-form">
          <select
            className="input"
            style={{ width: 170 }}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.length === 0 && <option value="">还没有项目</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ flex: 1, minWidth: 150 }}
            value={title}
            maxLength={60}
            autoFocus
            placeholder={open === 'plan' ? '方案标题' : '任务标题'}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') setOpen(null)
            }}
          />
          {open === 'todo' && (
            <select
              className="input"
              style={{ width: 74 }}
              value={priority}
              onChange={(e) => setPriority(e.target.value as TodoPriority)}
            >
              <option value="high">高</option>
              <option value="normal">中</option>
              <option value="low">低</option>
            </select>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !projectId || !title.trim()}
            onClick={() => void submit()}
          >
            {busy ? '保存中…' : open === 'plan' ? '存入方案' : '派发任务'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
            取消
          </button>
          {projects.length === 0 && (
            <button className="linkbtn" onClick={() => onOpenProjects?.()}>
              去新建项目
            </button>
          )}
          {error && <span className="save-err">{error}</span>}
        </div>
      )}
    </div>
  )
}
