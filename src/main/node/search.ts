import type { ChatSession, ProjectDef, TodoDef } from '../../shared/types'

/**
 * 全局搜索：项目 / 方案 / 任务 / 会话。
 *
 * 原来这套逻辑在渲染层：Ctrl+K 一打开就把 300 条会话的**全部消息**拉进窗口，
 * 之后每敲一个字符对几万条消息做一次 indexOf。会话攒到几百条后，
 * 打开搜索框和每次按键都会有肉眼可见的迟滞。
 *
 * 挪到主进程之后：数据本来就在磁盘上，扫完只把命中的几十条送过去。
 */

export type SearchKind = 'project' | 'plan' | 'task' | 'session'

export interface SearchHit {
  key: string
  kind: SearchKind
  title: string
  sub: string
  projectId?: string
  planId?: string
  sessionId?: string
  messageId?: string
}

const KIND_RANK: Record<SearchKind, number> = { project: 0, plan: 1, task: 2, session: 3 }

/** 会话消息是渲染层结构，主进程只取文本和 id */
function readMessage(raw: unknown): { id: string; text: string } {
  if (!raw || typeof raw !== 'object') return { id: '', text: '' }
  const rec = raw as { id?: unknown; text?: unknown }
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    text: typeof rec.text === 'string' ? rec.text : ''
  }
}

/** 命中的位置切片；needle 必须已是小写，与调用方的比较口径一致 */
function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return flat.slice(0, 70)
  const start = Math.max(0, at - 18)
  return `${start > 0 ? '…' : ''}${flat.slice(start, at + needle.length + 46)}`
}

export interface SearchInput {
  projects: ProjectDef[]
  todos: TodoDef[]
  sessions: ChatSession[]
  query: string
  limit?: number
}

export function searchAll(input: SearchInput): SearchHit[] {
  // 比较一律用小写；渲染层高亮也用小写 needle，两边口径必须一致
  const q = input.query.trim().toLowerCase()
  if (!q) return []
  const { projects, todos, sessions } = input
  const out: SearchHit[] = []
  const projectName = (id?: string): string => projects.find((p) => p.id === id)?.name ?? '未归属'

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

  // 单字符搜会话正文命中率太低且很慢，两个字符起才算
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

  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]).slice(0, input.limit ?? 40)
}
