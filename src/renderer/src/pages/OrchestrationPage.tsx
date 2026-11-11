import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OrchestrationProjectView } from '../../../shared/orchestration'

/**
 * 编排项目进度页。
 *
 * 只读：这一页回答"现在到哪了、过没过"，不提供改状态的按钮。
 * 想改就回对话里重新派一次——那样每次改动都有授权卡和一条审计记录。
 *
 * 「重新核对」按钮也不改状态：它只是把磁盘上的验收再查一遍给你看，
 * 免得"上次通过了"变成一句无从复核的自述。
 *
 * 项目默认落在应用自己的编排目录，但脚本派发的会落在别处（桌面等）。
 * 那些目录要点「打开项目目录…」由用户自己挑进来——挑这个动作本身就是授权，
 * 页面不会因为某个路径字符串长得像就去看它。
 */

type ProjectView = OrchestrationProjectView

/** 状态的中文与人话说明。unknown 单独标出来——它既不是成功也不是失败 */
const STATUS: Record<string, { text: string; cls: string; why: string }> = {
  pending: { text: '待派发', cls: 'tag-gray', why: '还没开始' },
  running: { text: '进行中', cls: 'tag-blue', why: '工作体正在做' },
  done: { text: '已完成', cls: 'tag-ok', why: '验收全部通过' },
  failed: { text: '未通过', cls: 'tag-red', why: '验收没过，或工作体出错' },
  blocked: { text: '被卡住', cls: 'tag-amber', why: '上游没产出，不硬跑' },
  unknown: { text: '结果未知', cls: 'tag-amber', why: '派发被中断，做没做完不知道' }
}

function statusOf(s: string): { text: string; cls: string; why: string } {
  return STATUS[s] ?? { text: s, cls: 'tag-gray', why: '' }
}

function timeText(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function OrchestrationPage(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [appRoot, setAppRoot] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [recheck, setRecheck] = useState<{ taskId: string; passed: boolean; detail: string }[] | null>(null)
  const [openTask, setOpenTask] = useState<string | null>(null)
  /** 挑目录 / 移除目录时的提示：挑错了要当场说，不能只是"什么都没发生" */
  const [rootNote, setRootNote] = useState<string | null>(null)
  const [rootBusy, setRootBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await window.butler.orchestration.list()
      setProjects(r.projects)
      setRoots(r.roots)
      setAppRoot(r.appRoot)
      setError(null)
      // 用 projectDir 当身份：选中的项目可能在别处的根里，不能退回"列表第一个"
      setSelected((cur) => (cur && r.projects.some((p) => p.projectDir === cur) ? cur : (r.projects[0]?.projectDir ?? null)))
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
    // 派发是在对话里发生的，回来时这一页要能看到新的
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const current = useMemo(
    () => projects.find((p) => p.projectDir === selected) ?? projects[0] ?? null,
    [projects, selected]
  )

  const pickRoot = async (): Promise<void> => {
    setRootBusy(true)
    setRootNote(null)
    try {
      const r = await window.butler.orchestration.pickRoot()
      if (r.canceled) return
      if (!r.ok) {
        setRootNote(r.reason)
        return
      }
      setProjects(r.projects)
      setRoots(r.roots)
      setAppRoot(r.appRoot)
      setSelected(r.projects[0]?.projectDir ?? null)
      setRootNote(`已打开 ${r.root}，在里面找到 ${r.projectCount} 个项目`)
    } catch (err) {
      setRootNote(errorText(err))
    } finally {
      setRootBusy(false)
    }
  }

  const removeRoot = async (dir: string): Promise<void> => {
    setRootBusy(true)
    setRootNote(null)
    try {
      const r = await window.butler.orchestration.removeRoot(dir)
      setProjects(r.projects)
      setRoots(r.roots)
      setAppRoot(r.appRoot)
      // 移除的是正看着的那个目录时，选中的项目要跟着失效
      setSelected((cur) => (cur && r.projects.some((p) => p.projectDir === cur) ? cur : (r.projects[0]?.projectDir ?? null)))
      setRootNote(r.ok ? `不再扫描 ${dir}（磁盘上的文件一个字节都没动）` : (r.reason ?? '没能移除'))
    } catch (err) {
      setRootNote(errorText(err))
    } finally {
      setRootBusy(false)
    }
  }

  const doRecheck = async (): Promise<void> => {
    if (!current) return
    setRechecking(true)
    try {
      const r = (await window.butler.orchestration.recheck(current.projectDir)) as typeof recheck
      setRecheck(r)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRechecking(false)
    }
  }

  const recheckOf = (taskId: string): { passed: boolean; detail: string } | undefined =>
    recheck?.find((r) => r.taskId === taskId)

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>编排</h2>
          <span
            className="icobtn"
            role="button"
            title="打开项目目录…"
            aria-disabled={rootBusy}
            onClick={() => {
              if (!rootBusy) void pickRoot()
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" />
              <path d="M12 12.5v4M10 14.5h4" />
            </svg>
          </span>
          <span className="icobtn" role="button" title="刷新" onClick={() => void load()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" />
            </svg>
          </span>
        </div>

        <div className="seclabel">
          已派发的项目<span className="cnt">{projects.length}</span>
        </div>

        {rootNote && (
          <div className="sub" style={{ padding: '0 14px 8px', lineHeight: 1.5 }}>
            {rootNote}
          </div>
        )}

        {projects.length === 0 ? (
          <div className="empty-mid">
            <b>还没有派发过项目</b>
            在对话里说「把这个拆成几步派出去」，长庚会先让你选派发方式。
            <br />
            项目不在应用目录里的话，点右上角文件夹图标，自己把那个目录挑进来。
          </div>
        ) : (
          projects.map((p) => (
            <button
              key={p.projectDir}
              className={`item two${current?.projectDir === p.projectDir ? ' sel' : ''}`}
              title={p.projectDir}
              onClick={() => {
                setSelected(p.projectDir)
                setRecheck(null)
                setOpenTask(null)
              }}
            >
              <span className="t">
                {p.name}
                <span className={`sub${p.progress.failed > 0 || p.progress.unknown > 0 ? ' warn' : ''}`}>
                  {p.progress.done}/{p.progress.total} 完成 · {timeText(p.updatedAt)}
                </span>
              </span>
            </button>
          ))
        )}

        {/* 正在扫描的目录：用户能看见"页面到底在看哪几处"，也能撤掉自己加的那个 */}
        {roots.length > 0 && (
          <>
            <div className="seclabel" style={{ marginTop: 12 }}>
              扫描的目录<span className="cnt">{roots.length}</span>
            </div>
            <div style={{ padding: '0 14px 14px', display: 'grid', gap: 6 }}>
              {roots.map((r) => {
                const isApp = r === appRoot
                return (
                  <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      className="sub"
                      title={r}
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {r}
                    </span>
                    {isApp ? (
                      <span className="sub" style={{ flexShrink: 0 }}>
                        应用目录
                      </span>
                    ) : (
                      <span
                        className="icobtn"
                        role="button"
                        title="不再扫描这个目录（磁盘上的文件不动）"
                        onClick={() => {
                          if (!rootBusy) void removeRoot(r)
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </aside>

      <main className="content" style={{ padding: 0 }}>
        <div className="cap-wrap">
          {error && (
            <div className="card" style={{ maxWidth: 760 }}>
              <b>读不到编排记录</b>
              <div className="sub">{error}</div>
            </div>
          )}

          {!current ? (
            <div className="empty">
              <b>选一个项目看进度</b>
            </div>
          ) : (
            <div className="card orch-card">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h3 className="orch-title">{current.name}</h3>
                <span className={`tag ${statusOf(current.status).cls}`}>{current.status}</span>
                <span className="sub" style={{ marginLeft: 'auto' }}>
                  派发 {current.runCount} 次 · 最后 {timeText(current.lastRunAt)}
                </span>
              </div>

              {/* 进度条：只有全部通过才是满的，有失败/未知不冒充 100% */}
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: 'var(--line, #e5e5e5)',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(current.progress.ratio * 100)}%`,
                      height: '100%',
                      background: 'var(--accent, #2f6f4f)',
                      transition: 'width .3s'
                    }}
                  />
                </div>
                <div className="sub" style={{ marginTop: 6 }}>
                  {current.progress.total} 个任务 · 完成 {current.progress.done}
                  {current.progress.failed > 0 && ` · 失败 ${current.progress.failed}`}
                  {current.progress.unknown > 0 && ` · 结果未知 ${current.progress.unknown}`}
                  {current.progress.blocked > 0 && ` · 被上游卡住 ${current.progress.blocked}`}
                  {current.progress.pending > 0 && ` · 待派发 ${current.progress.pending}`}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn" disabled={rechecking} onClick={() => void doRecheck()}>
                  {rechecking ? '核对中…' : '重新核对验收'}
                </button>
                <button className="btn" onClick={() => void load()}>
                  刷新
                </button>
              </div>

              {recheck && (
                <div className="sub" style={{ marginTop: 8 }}>
                  已按磁盘现状核对一遍；<b>没有改任务状态</b>，只是把事实再查一遍。
                </div>
              )}

              <div className="seclabel" style={{ marginTop: 18 }}>
                任务<span className="cnt">{current.tasks.length}</span>
              </div>

              {current.tasks.map((t) => {
                const s = statusOf(t.status)
                const rc = recheckOf(t.id)
                const expanded = openTask === t.id
                return (
                  <div key={t.id} className="card orch-task">
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flexWrap: 'wrap' }}
                      onClick={() => setOpenTask(expanded ? null : t.id)}
                    >
                      <span className={`tag ${s.cls}`}>{s.text}</span>
                      <b className="orch-task-t">{t.title}</b>
                      <span className="sub">{t.id}</span>
                      {t.dependsOn.length > 0 && <span className="sub">依赖 {t.dependsOn.join('、')}</span>}
                      {t.attempts > 1 && <span className="sub warn">已重跑 {t.attempts} 次</span>}
                      <span className="sub" style={{ marginLeft: 'auto' }}>
                        {timeText(t.endedAt ?? t.startedAt)}
                      </span>
                    </div>

                    {t.failureReason && (
                      <div className="sub warn" style={{ marginTop: 6 }}>
                        {t.failureReason}
                      </div>
                    )}

                    {expanded && (
                      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                        <div>
                          <div className="sub">验收项（跑完按这些逐条查，全过才算完成）</div>
                          {t.acceptance.length === 0 ? (
                            <div className="sub">没有验收项：只能按状态判断，等于它说做完就算完</div>
                          ) : (
                            <ul className="orch-list">
                              {t.acceptance.map((a, i) => (
                                <li key={i}>{a}</li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div>
                          <div className="sub">产出</div>
                          {t.artifacts.length === 0 ? (
                            <div className="sub">没有产出文件</div>
                          ) : (
                            <ul className="orch-list">
                              {t.artifacts.map((p) => (
                                <li key={p}>
                                  <a
                                    href="#"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      void window.butler.orchestration.reveal(p)
                                    }}
                                    title={p}
                                  >
                                    {p.split(/[\\/]/).pop()}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        {rc && (
                          <div>
                            <div className="sub">刚刚核对的结果</div>
                            <div className="orch-detail">{rc.detail}</div>
                          </div>
                        )}

                        <div className="sub" title={current.rootDir}>
                          目录：{current.rootDir}
                        </div>
                        {/* 项目是从哪个根里找到的：不在应用目录时，用户需要知道"这是我自己打开的那个目录里的" */}
                        {appRoot && current.scanRoot !== appRoot && (
                          <div className="sub" title={current.scanRoot}>
                            来自你打开的目录：{current.scanRoot}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
