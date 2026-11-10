import { useEffect, useMemo, useState } from 'react'
import type { TaskDef } from '../../../shared/types'
import { FieldHelp } from '../components/FieldHelp'


/** 常用模板：只放当前工具真能跑通的只读动作 */
const TEMPLATES: Array<{ when: string; title: string; time: string; prompt: string; icon: string }> = [
  {
    when: '每天 08:00',
    title: '汇总未读邮件',
    time: '08:00',
    prompt: '看一下默认邮箱最近的未读邮件，有要紧的总结一下',
    icon: 'M3.4 5.6h17.2v12.8H3.4zM4.2 7.2l7.1 5.3c.4.3 1 .3 1.4 0l7.1-5.3'
  },
  {
    when: '每天 18:00',
    title: '检查开机自启项',
    time: '18:00',
    prompt: '列一下本机的开机启动项，有哪些是非微软的、可有可无的',
    icon: 'M12 3.6v8M8.2 6.6A7 7 0 1 0 15.8 6.6'
  },
  {
    when: '每天 21:00',
    title: '清点已安装程序',
    time: '21:00',
    prompt: '列出本机已安装的程序，按发布者归一下类，有不认识的单独提出来',
    icon: 'M3.2 4.6h17.6v11.4H3.2zM9 20h6M12 16.2V20'
  }
]

function scheduleText(task: TaskDef): string {
  return task.schedule.kind === 'daily' ? `每天 ${task.schedule.time}` : `每 ${task.schedule.minutes} 分钟`
}

function timeAgo(iso?: string): string {
  if (!iso) return '还没跑过'
  const diff = Date.now() - Date.parse(iso)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const IC = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

/** 定时任务（图标条 · 时钟）：主进程调度，到点无头跑一轮 */
export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskDef[]>([])
  const [editing, setEditing] = useState<Partial<TaskDef> | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  /** 只看启用中的任务 */
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  /** 中栏搜索 */
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')

  const load = async (): Promise<void> => {
    setTasks(await window.butler.tasks.list())
  }

  useEffect(() => {
    void load()
    const off = window.butler.tasks.onChanged(() => void load())
    return () => {
      off()
    }
  }, [])

  const save = async (): Promise<void> => {
    if (!editing) return
    setBusy(true)
    try {
      await window.butler.tasks.save(editing)
      setEditing(null)
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    await window.butler.tasks.delete(id)
    setEditing(null)
    await load()
  }

  const toggle = async (task: TaskDef): Promise<void> => {
    await window.butler.tasks.save({ ...task, enabled: !task.enabled })
    await load()
  }

  const runNow = async (task: TaskDef): Promise<void> => {
    setStatus(`正在运行「${task.name}」…`)
    const result = await window.butler.tasks.run(task.id)
    setStatus(result.ok ? `「${task.name}」：${result.detail}` : `「${task.name}」失败：${result.detail}`)
    await load()
  }

  const newTask = (): void => setEditing({ schedule: { kind: 'daily', time: '09:00' }, enabled: true })

  const applyTemplate = (tpl: (typeof TEMPLATES)[number]): void =>
    setEditing({ name: tpl.title, prompt: tpl.prompt, schedule: { kind: 'daily', time: tpl.time }, enabled: true })

  const enabledCount = tasks.filter((t) => t.enabled).length
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tasks
      .filter((t) => (onlyEnabled ? t.enabled : true))
      .filter((t) => (q ? t.name.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q) : true))
  }, [tasks, onlyEnabled, query])

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>定时任务</h2>
          <span
            className="icobtn"
            role="button"
            title={onlyEnabled ? '显示全部任务' : '只看启用中'}
            style={onlyEnabled ? { background: 'var(--sel)', color: 'var(--sel-ink)' } : undefined}
            onClick={() => setOnlyEnabled((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M4 6.6h16M7 12h10M10 17.4h4" />
            </svg>
          </span>
          <span
            className="icobtn"
            role="button"
            title="搜索任务"
            style={showSearch ? { background: 'var(--sel)', color: 'var(--sel-ink)' } : undefined}
            onClick={() => setShowSearch((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <circle cx="10.8" cy="10.8" r="6.2" />
              <path d="M15.4 15.4 20 20" />
            </svg>
          </span>
        </div>

        <button className="newchat" onClick={newTask}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建任务
        </button>

        {showSearch && (
          <div className="searchbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <circle cx="10.8" cy="10.8" r="6.2" />
              <path d="M15.4 15.4 20 20" />
            </svg>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务" />
          </div>
        )}

        <div className="seclabel">
          {onlyEnabled ? '启用中' : '全部任务'}
          <span className="cnt">{onlyEnabled ? enabledCount : tasks.length}</span>
        </div>

        {visible.length === 0 ? (
          <div className="empty-mid">
            <b>暂无已安排的任务</b>
            定好时间，长庚会自己去做
          </div>
        ) : (
          visible.map((task) => (
            <button
              key={task.id}
              className={`item two${editing?.id === task.id ? ' sel' : ''}`}
              onClick={() => setEditing(task)}
            >
              <span className="t">
                {task.name}
                <span className={task.enabled ? 'sub' : 'sub warn'}>
                  {scheduleText(task)} · {task.enabled ? timeAgo(task.lastRun) : '已停用'}
                </span>
              </span>
            </button>
          ))
        )}
      </aside>

      <main className="content" style={{ padding: 0 }}>
        <div className="acc-wrap">
          {editing ? (
            <div className="card form" style={{ maxWidth: 680 }}>
              <div className="form-row">
                <label>任务名</label>
                <input
                  className="input"
                  value={editing.name ?? ''}
                  placeholder="比如：每天早上看邮箱"
                  maxLength={40}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>
                  到点后发给长庚的指令
                  <FieldHelp label="定时任务的限制">
                    到点后作为一条<b>用户消息</b>交给长庚跑一轮。
                    <br />
                    只适合只读动作：需要授权的操作会被当场拒绝并留痕
                    （无人在场，fail-closed）。运行前记得开着应用。
                  </FieldHelp>
                </label>
                <textarea
                  className="input"
                  style={{ height: 88, padding: '8px 10px', resize: 'vertical' }}
                  value={editing.prompt ?? ''}
                  placeholder="比如：看一下默认邮箱最近的未读邮件，有要紧的总结一下"
                  maxLength={500}
                  onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                />
              </div>
              <div className="grid2">
                <div className="form-row">
                  <label>计划</label>
                  <select
                    className="input"
                    value={editing.schedule?.kind === 'interval' ? 'interval' : 'daily'}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        schedule:
                          e.target.value === 'interval'
                            ? {
                                kind: 'interval',
                                minutes: Number(editing.schedule?.kind === 'interval' ? editing.schedule.minutes : 30) || 30
                              }
                            : { kind: 'daily', time: editing.schedule?.kind === 'daily' ? editing.schedule.time : '09:00' }
                      })
                    }
                  >
                    <option value="daily">每天固定时间</option>
                    <option value="interval">每隔一段时间</option>
                  </select>
                </div>
                <div className="form-row">
                  <label>{editing.schedule?.kind === 'interval' ? '间隔（分钟）' : '时间'}</label>
                  {editing.schedule?.kind === 'interval' ? (
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={1440}
                      value={editing.schedule.minutes}
                      onChange={(e) =>
                        setEditing({ ...editing, schedule: { kind: 'interval', minutes: Number(e.target.value) || 30 } })
                      }
                    />
                  ) : (
                    <input
                      className="input"
                      type="time"
                      value={editing.schedule?.kind === 'daily' ? editing.schedule.time : '09:00'}
                      onChange={(e) => {
                        const time = e.target.value
                        setEditing((prev) => (prev ? { ...prev, schedule: { kind: 'daily', time } } : prev))
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" disabled={busy || !editing.prompt?.trim()} onClick={() => void save()}>
                  {busy ? '保存中…' : '保存任务'}
                </button>
                <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                  取消
                </button>
                {editing.id && (
                  <button
                    className="btn btn-ghost"
                    style={{ marginLeft: 'auto', color: 'var(--red)' }}
                    onClick={() => void remove(editing.id!)}
                  >
                    删除任务
                  </button>
                )}
              </div>
            </div>
          ) : tasks.length === 0 ? (
            <div className="taskwrap">
              <div className="task">
                <svg className="gauge" width="106" height="94" viewBox="0 0 72 64" fill="none">
                  <circle
                    cx="36"
                    cy="34"
                    r="24"
                    stroke="#CFE0EE"
                    strokeWidth="1.5"
                    strokeDasharray="105 46"
                    strokeLinecap="round"
                    transform="rotate(-90 36 34)"
                  />
                  <path d="M36 34V19" stroke="#B9D0E4" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M36 34l9.5 5.5" stroke="#B9D0E4" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="36" cy="34" r="2.3" fill="#A8C8E8" />
                  <circle cx="57" cy="16" r="2.2" fill="#D8B87A" />
                  <circle cx="36" cy="6.5" r="1" fill="#DCE8F4" />
                  <circle cx="63" cy="34" r="1" fill="#DCE8F4" />
                  <circle cx="36" cy="61" r="1" fill="#DCE8F4" />
                  <circle cx="9" cy="34" r="1" fill="#DCE8F4" />
                </svg>
                <h3>还没有定时任务</h3>
                <p>
                  让长庚在固定时间替你看邮箱、清点程序、检查自启。
                  <br />
                  跑完会留一条记录，随时能撤回。
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="blkbtn" onClick={newTask}>
                    <svg viewBox="0 0 24 24" {...IC}>
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    新建任务
                  </button>
                  <button className="blkbtn2" onClick={() => applyTemplate(TEMPLATES[0])}>
                    从模板开始
                  </button>
                </div>
                <div className="tplab">常用模板</div>
                <div className="tplist">
                  {TEMPLATES.map((tpl) => (
                    <button className="tp" key={tpl.title} onClick={() => applyTemplate(tpl)}>
                      <span className="wd">{tpl.when}</span>
                      <svg viewBox="0 0 24 24" {...IC}>
                        <path d={tpl.icon} />
                      </svg>
                      {tpl.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {visible.map((task) => (
                <div className="acard" key={task.id}>
                  <span className="atile">
                    <svg viewBox="0 0 24 24" {...IC}>
                      <circle cx="12" cy="12" r="8.3" />
                      <path d="M12 7.4v4.9l3.2 2" />
                    </svg>
                  </span>
                  <div className="acc-main">
                    <div className="acc-line">
                      <span className="acc-name">{task.name}</span>
                      <span className="st">
                        <i style={{ background: task.enabled ? 'var(--blue)' : 'var(--gold)' }} />
                        {task.enabled ? `启用 · ${scheduleText(task)}` : '已停用'}
                      </span>
                    </div>
                    <div className="addr" style={{ fontFamily: 'inherit', color: 'var(--ink2)' }}>
                      {task.prompt}
                    </div>
                    <div className="acc-chips">
                      <span className="mini-chip">上次运行：{timeAgo(task.lastRun)}</span>
                      {task.lastResult && <span className="mini-chip">{task.lastResult}</span>}
                    </div>
                  </div>
                  <div className="acc-right">
                    <span className="acc-time">{task.enabled ? '调度中' : '暂停'}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="mngbtn" disabled={!task.enabled} onClick={() => void runNow(task)}>
                        立即运行
                      </button>
                      <button className="mngbtn" onClick={() => setEditing(task)}>
                        编辑
                      </button>
                      <button className="mngbtn" onClick={() => void toggle(task)}>
                        {task.enabled ? '停用' : '启用'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <button className="addcard" onClick={newTask}>
                <svg viewBox="0 0 24 24" {...IC} width="14" height="14">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                新建定时任务
              </button>
              <div className="acc-tip">
                <svg viewBox="0 0 24 24" {...IC}>
                  <circle cx="12" cy="12" r="8.3" />
                  <path d="M12 7.4v4.9l3.2 2" />
                </svg>
                <div>
                  <b>定时任务无人在场，写操作一律拒绝</b>
                  <span>需要授权的操作会被当场拒绝并留痕。运行前记得开着应用。</span>
                </div>
              </div>
            </>
          )}
          {status && <div className="result-line ok">{status}</div>}
        </div>
      </main>
    </div>
  )
}
