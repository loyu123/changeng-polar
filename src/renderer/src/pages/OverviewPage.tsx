import { useEffect, useState } from 'react'
import type { BriefDef, ProjectDef, TodoDef, TodoStatus } from '../../../shared/types'

interface Props {
  /** 点任务或项目，跳到项目页并选中它；带了 briefId 就直接展开那份简报 */
  onOpenProject: (id: string, briefId?: string) => void
}

interface Stats {
  apps: number
  startup: number
  mail: number
  tools: number
  toolsOn: number
}

/** 本地日期 YYYY-MM-DD（用于判断逾期） */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PRI_RANK = { high: 0, normal: 1, low: 2 } as const
const PRI_TEXT = { high: '高', normal: '中', low: '低' } as const
const TODO_TEXT: Record<TodoStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '卡住',
  done: '完成',
  dropped: '已放弃'
}

/** 总览：跨项目的待办、卡点、进度，以及本机资源总账。只读汇总，不做任何操作 */
export default function OverviewPage({ onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [todos, setTodos] = useState<TodoDef[]>([])
  const [stats, setStats] = useState<Stats>({ apps: 0, startup: 0, mail: 0, tools: 0, toolsOn: 0 })
  const [loading, setLoading] = useState(true)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const [list, todoList] = await Promise.all([window.butler.projects.list(), window.butler.todos.list()])
      setProjects(list)
      setTodos(todoList)

      const [appsN, startupN, mailN] = await Promise.all([
        window.butler.apps.list().then((r) => r.apps.length).catch(() => 0),
        window.butler.startup.list().then((r) => r.items.length).catch(() => 0),
        window.butler.config.get().then((c) => (c.mailAccounts ?? []).length).catch(() => 0)
      ])
      let toolsTotal = 0
      let toolsOn = 0
      try {
        const tools = await window.butler.tools.list()
        toolsTotal = tools.length
        toolsOn = tools.filter((t) => t.enabled).length
      } catch {
        // 工具注册表读不到时留 0，不影响看板其余部分
      }
      setStats({ apps: appsN, startup: startupN, mail: mailN, tools: toolsTotal, toolsOn })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const reload = (): void => void load()
    window.addEventListener('polar:projects-changed', reload)
    return () => window.removeEventListener('polar:projects-changed', reload)
  }, [])

  // 已放弃 = 路径收敛时归档的，不算未完成，也不进看板计数
  const openTodos = todos.filter((t) => t.status !== 'done' && t.status !== 'dropped')
  const blocked = openTodos.filter((t) => t.status === 'blocked')
  const doing = openTodos.filter((t) => t.status === 'doing')
  const doneCount = todos.filter((t) => t.status === 'done').length
  const activeProjects = projects.filter((p) => (p.status ?? 'active') === 'active')

  const sorted = [...openTodos].sort(
    (a, b) =>
      PRI_RANK[a.priority] - PRI_RANK[b.priority] ||
      (a.due ?? '~').localeCompare(b.due ?? '~') ||
      a.createdAt.localeCompare(b.createdAt)
  )

  const projectName = (id?: string): string => projects.find((p) => p.id === id)?.name ?? '未归属'
  const visibleProjects = projects.filter((p) => (p.status ?? 'active') !== 'done').slice(0, 8)

  // 各项目最后一份简报，按时间倒序（回看进度用，不需要每天打开）
  const recentBriefs = projects
    .map((p) => ({ project: p, brief: (p.briefs ?? [])[0] }))
    .filter((item): item is { project: ProjectDef; brief: BriefDef } => Boolean(item.brief))
    .sort((a, b) => b.brief.createdAt.localeCompare(a.brief.createdAt))
    .slice(0, 5)

  /** 简报正文压成一行摘要 */
  const plain = (text: string): string =>
    text
      .replace(/[#>*`_\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64)

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <main className="content" style={{ padding: 0 }}>
        <div className="acc-wrap">
          <div className="acc-h">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1>总览</h1>
              <p>
                {openTodos.length} 条待办 · {activeProjects.length} 个项目在推进
                {blocked.length > 0 ? ` · ${blocked.length} 条卡住` : ''}
              </p>
            </div>
            <span className="sp" />
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>
              {loading ? '读取中…' : '刷新'}
            </button>
          </div>

          <div className="ov-grid">
            <div className="ov-card">
              <div className="ov-num">{openTodos.length}</div>
              <div className="ov-lab">未完成待办</div>
            </div>
            <div className={`ov-card${doing.length > 0 ? ' blue' : ''}`}>
              <div className="ov-num">{doing.length}</div>
              <div className="ov-lab">进行中</div>
            </div>
            <div className={`ov-card${blocked.length > 0 ? ' warn' : ''}`}>
              <div className="ov-num">{blocked.length}</div>
              <div className="ov-lab">卡住</div>
            </div>
            <div className="ov-card">
              <div className="ov-num">{doneCount}</div>
              <div className="ov-lab">已完成</div>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">待办 · 按优先级</div>
            {sorted.length === 0 ? (
              <div className="row">
                <div className="rl">
                  <span>没有未完成的待办。在项目里生成方案、拆成任务，这里就会汇总出来。</span>
                </div>
              </div>
            ) : (
              sorted.slice(0, 12).map((todo) => (
                <div className="todo" key={todo.id}>
                  <span className={`tstat ${todo.status}`}>{TODO_TEXT[todo.status]}</span>
                  <span className={`ttext${todo.status === 'done' ? ' done' : ''}`}>{todo.title}</span>
                  {todo.due && (
                    <span className={`ovdue${todo.due < todayStr() ? ' overdue' : ''}`} title={`截止 ${todo.due}`}>
                      {todo.due.slice(5)}
                    </span>
                  )}
                  <button className="ov-tag" onClick={() => onOpenProject(todo.projectId ?? '')} title="去这个项目">
                    {projectName(todo.projectId)}
                  </button>
                  <span className={`tpri ${todo.priority}`} title={`优先级：${PRI_TEXT[todo.priority]}`}>
                    {PRI_TEXT[todo.priority]}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="cardbox">
            <div className="ch">项目进度</div>
            {visibleProjects.length === 0 ? (
              <div className="row">
                <div className="rl">
                  <span>还没有进行中的项目。</span>
                </div>
              </div>
            ) : (
              visibleProjects.map((p) => {
                const list = todos.filter((t) => t.projectId === p.id && t.status !== 'dropped')
                const done = list.filter((t) => t.status === 'done').length
                const pct = list.length === 0 ? 0 : Math.round((done / list.length) * 100)
                return (
                  <div className="row" key={p.id}>
                    <div className="rl" style={{ minWidth: 0 }}>
                      <b style={{ fontSize: 12.6 }}>{p.name}</b>
                      <span>
                        {(p.status ?? 'active') === 'paused' ? '暂停 · ' : ''}
                        {p.goal || '未写目标'}
                      </span>
                    </div>
                    <span className="ov-prog">
                      <span className="ov-bar">
                        <i style={{ width: `${pct}%` }} />
                      </span>
                      <span className="ov-pct">
                        {done}/{list.length}
                      </span>
                    </span>
                    <button className="mngbtn" onClick={() => onOpenProject(p.id)}>
                      打开
                    </button>
                  </div>
                )
              })
            )}
          </div>

          <div className="cardbox">
            <div className="ch">最近简报</div>
            {recentBriefs.length === 0 ? (
              <div className="row">
                <div className="rl">
                  <span>还没有简报。在项目页点「生成简报」，这里就会留下一条进度快照。</span>
                </div>
              </div>
            ) : (
              recentBriefs.map(({ project, brief }) => (
                <div className="row" key={brief.id}>
                  <div className="rl" style={{ minWidth: 0 }}>
                    <b style={{ fontSize: 12.6 }}>{project.name}</b>
                    <span>
                      {new Date(brief.createdAt).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                      {brief.snapshot ? ` · ${brief.snapshot.done}/${brief.snapshot.total} 完成` : ''} · {plain(brief.body)}
                    </span>
                  </div>
                  <button className="mngbtn" onClick={() => onOpenProject(project.id, brief.id)}>
                    看简报
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="cardbox">
            <div className="ch">本机资源总账</div>
            <div className="g2">
              <div className="row">
                <div className="rl">
                  <b>已装应用</b>
                  <span>来自注册表，只读</span>
                </div>
                <span className="ov-kv">{stats.apps}</span>
              </div>
              <div className="row">
                <div className="rl">
                  <b>开机自启</b>
                  <span>当前只能看，不能改</span>
                </div>
                <span className="ov-kv">{stats.startup}</span>
              </div>
              <div className="row">
                <div className="rl">
                  <b>邮箱账号</b>
                  <span>IMAP 只读接入</span>
                </div>
                <span className="ov-kv">{stats.mail}</span>
              </div>
              <div className="row">
                <div className="rl">
                  <b>启用能力</b>
                  <span>模型当前能看到几个工具</span>
                </div>
                <span className="ov-kv">
                  {stats.toolsOn}
                  <em>/{stats.tools}</em>
                </span>
              </div>
            </div>
          </div>

          <div className="setfoot">
            <span>汇总自 projects.json / todos.json 与本机只读清单</span>
            <span>·</span>
            <span>这里不会执行任何操作</span>
          </div>
        </div>
      </main>
    </div>
  )
}
