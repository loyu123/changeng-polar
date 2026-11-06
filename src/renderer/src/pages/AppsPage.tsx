import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo, AppNote, VerifyResult } from '../../../shared/types'

interface Props {
  active: boolean
  onAsk: (text: string) => void
}

const PALETTE = ['#2D8CFF', '#0D0D0D', '#07C160', '#C62F2F', '#1F7FE0', '#8E8E8E', '#7B61FF', '#E8A33D', '#3AA76D']

function colorOf(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 9973
  return PALETTE[hash % PALETTE.length]
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function AppsPage({ active, onAsk }: Props) {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [verifyMap, setVerifyMap] = useState<Record<string, VerifyResult>>({})
  const [notes, setNotes] = useState<Record<string, AppNote>>({})
  const [loading, setLoading] = useState(true)
  const [durationMs, setDurationMs] = useState(0)
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /** 正在编辑备注的程序名；text 为编辑框内容 */
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null)
  /** 中栏选中的程序（key 与行 key 同一规则）；null = 概览 */
  const [selected, setSelected] = useState<string | null>(null)
  const runningRef = useRef(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.butler.apps.list()
      setApps(data.apps)
      setVerifyMap(data.verifyMap ?? {})
      setDurationMs(data.durationMs)
    } finally {
      setLoading(false)
    }
    try {
      setNotes(await window.butler.apps.notes())
    } catch {
      /* 备注读不到不拦清单 */
    }
  }

  const saveNote = async (): Promise<void> => {
    if (!editing) return
    const saved = await window.butler.apps.saveNote(editing.name, editing.text)
    setNotes((prev) => {
      const next = { ...prev }
      if (saved) next[editing.name] = saved
      else delete next[editing.name]
      return next
    })
    setEditing(null)
  }

  useEffect(() => {
    if (active) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q)
    )
  }, [apps, query])

  const verifiedCount = apps.filter((a) => verifyMap[a.name]?.status === 'verified').length
  const unverifiedChecked = apps.filter((a) => verifyMap[a.name]?.status === 'unverified').length
  const keyOf = (app: AppInfo): string => `${app.name}-${app.scope}-${app.arch}`
  const selectedApp = selected ? apps.find((a) => keyOf(a) === selected) ?? null : null

  const verifyOne = async (app: AppInfo): Promise<void> => {
    // 注册表登记了产品网址就一起传过去，查证会先直连它，绕开检索
    const result = await window.butler.apps.verify(app.name, app.publisher, app.urlInfoAbout)
    setVerifyMap((prev) => ({ ...prev, [app.name]: result }))
  }

  const runBatch = async (limit = 8): Promise<void> => {
    if (runningRef.current) return
    const targets = apps.filter((a) => !verifyMap[a.name]).slice(0, limit)
    if (targets.length === 0) return
    runningRef.current = true
    let done = 0
    setProgress({ done: 0, total: targets.length })
    const queue = [...targets]
    const worker = async (): Promise<void> => {
      for (;;) {
        const app = queue.shift()
        if (!app) return
        try {
          await verifyOne(app)
        } catch {
          /* 单条失败不影响队列 */
        }
        done += 1
        setProgress({ done, total: targets.length })
      }
    }
    await Promise.all([worker(), worker()])
    runningRef.current = false
    setProgress(null)
  }

  const verify = selectedApp ? verifyMap[selectedApp.name] : undefined
  const verified = verify?.status === 'verified'

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>应用台账</h2>
          <button className="icobtn" onClick={() => void load()} title="重新读取注册表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4.6V10h-5.4" />
            </svg>
          </button>
        </div>
        <div className="searchbox">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L13.4 13.4" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索程序或发布者…" />
        </div>
        <div className="seclabel">
          全部程序<span className="cnt">{apps.length}</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && <div className="empty">读取注册表 Uninstall 键…</div>}
          {!loading && filtered.length === 0 && <div className="empty">没有匹配的程序</div>}
          {!loading &&
            filtered.map((app) => {
              const v = verifyMap[app.name]
              const ok = v?.status === 'verified'
              return (
                <button
                  key={keyOf(app)}
                  className={`item two${selected === keyOf(app) ? ' sel' : ''}`}
                  onClick={() => setSelected(keyOf(app))}
                >
                  <span className="appicon" style={{ background: colorOf(app.name) }}>
                    {app.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="t">
                    {app.name}
                    <span className={ok ? 'sub' : 'sub warn'}>
                      {app.version || '版本未知'} · {ok ? '已查证' : v ? '未查证' : '待查证'}
                    </span>
                  </span>
                </button>
              )
            })}
        </div>
      </aside>

      <main className="content">
        <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="card stat">
            <div className="stat-k">
              <span className="sq" style={{ background: '#C9C9C9' }} />
              已安装
            </div>
            <div className="stat-v">{apps.length}</div>
            <div className="stat-s">含系统组件 {apps.filter((a) => a.systemComponent === 1).length} 个</div>
          </div>
          <div className="card stat">
            <div className="stat-k">
              <span className="sq" style={{ background: '#2E9E4F' }} />
              已查证
            </div>
            <div className="stat-v">
              {verifiedCount}
              <small> / {apps.length ? Math.round((verifiedCount / apps.length) * 100) : 0}%</small>
            </div>
            <div className="stat-s">说明来自官网或官方文档</div>
          </div>
          <div className="card stat">
            <div className="stat-k">
              <span className="sq" style={{ background: '#B4B4B4' }} />
              未查证
            </div>
            <div className="stat-v">{apps.length - verifiedCount}</div>
            <div className="stat-s">其中 {unverifiedChecked} 个已尝试但无官方出处</div>
          </div>
          <div className="card stat">
            <div className="stat-k">
              <span className="sq" style={{ background: '#0067C0' }} />
              MCP
            </div>
            <div className="stat-v" style={{ color: '#8A8A8A' }}>
              暂缓
            </div>
            <div className="stat-s">未连接任何 server；入口保留作为接口</div>
          </div>
        </div>

        {!selectedApp ? (
          <div className="card" style={{ padding: 30, textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#4E4E47' }}>
              {loading ? '正在读取注册表…' : '点左侧任一程序查看详情'}
            </div>
            <div style={{ fontSize: 12, color: '#8E8E86', marginTop: 5, lineHeight: 1.6 }}>
              说明来自官网查证或你的手写备注，都没有就如实标未登记；也可以让长庚批量查证。
            </div>
            {!loading && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-primary" disabled={!!progress} onClick={() => void runBatch(8)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M13.2 8a5.2 5.2 0 11-1.6-3.7" />
                    <path d="M13.4 2.2v3.2h-3.2" />
                  </svg>
                  {progress ? `查证中 ${progress.done}/${progress.total}` : '查证未查证的 8 个'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div className="appicon" style={{ width: 44, height: 44, borderRadius: 11, fontSize: 19, flex: '0 0 44px', background: colorOf(selectedApp.name) }}>
                {selectedApp.name.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <div className="appname" style={{ fontSize: 15.5 }}>
                    {selectedApp.name}
                  </div>
                  <span className={`tag ${verified ? 'tag-ok' : 'tag-gray'}`}>
                    {verified ? '已查证' : verify ? '未查证' : '待查证'}
                  </span>
                </div>
                <div className="ver" style={{ marginTop: 4 }}>
                  版本 {selectedApp.version || '未知'}
                  {selectedApp.publisher ? ` · ${selectedApp.publisher}` : ''}
                  {selectedApp.scope ? ` · ${selectedApp.scope}` : ''}
                  {selectedApp.arch ? ` · ${selectedApp.arch}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto' }}>
                {verified ? (
                  <button
                    className="act act-off"
                    onClick={() =>
                      onAsk(
                        `关于「${selectedApp.name}」，如果要接一个现成的开源 MCP server，你会选哪个？先说明为什么，别直接装。`
                      )
                    }
                  >
                    需要时启用
                  </button>
                ) : (
                  <button className="act act-off" onClick={() => void verifyOne(selectedApp)}>
                    查证官网
                  </button>
                )}
                {editing?.name !== selectedApp.name && (
                  <button
                    className="act act-off"
                    onClick={() => setEditing({ name: selectedApp.name, text: notes[selectedApp.name]?.text ?? '' })}
                    title="写一句功能说明；手写备注会覆盖查证生成的句子，对话里也能引用"
                  >
                    {notes[selectedApp.name] ? '改备注' : '补说明'}
                  </button>
                )}
                {/* 卸载走对话、走闸门：这里只是把请求提给管家，不直接调用 IPC，
                    保持「所有破坏性动作只有一个入口」 */}
                {selectedApp.systemComponent !== 1 && (
                  <button className="act act-off" onClick={() => onAsk(`卸载「${selectedApp.name}」`)}>
                    卸载
                  </button>
                )}
              </div>
            </div>

            <div className={`adesc${verified || notes[selectedApp.name] ? '' : ' muted'}`} style={{ marginTop: 13, WebkitLineClamp: 'unset', whiteSpace: 'pre-wrap' }}>
              {editing?.name === selectedApp.name ? (
                <div className="note-edit" style={{ maxWidth: 520 }}>
                  <input
                    autoFocus
                    value={editing.text}
                    maxLength={120}
                    placeholder="一句话：这个程序是干什么的"
                    onChange={(e) => setEditing({ name: selectedApp.name, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveNote()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                  <button className="act act-on" onClick={() => void saveNote()}>
                    存
                  </button>
                  <button className="act act-off" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </div>
              ) : notes[selectedApp.name] ? (
                notes[selectedApp.name].text
              ) : verified ? (
                verify.sentence
              ) : verify ? (
                `未查证：${verify.reason ?? '找不到官方出处'}`
              ) : (
                '尚未查证——点「查证官网」让它去找官方出处；查不到就如实说，不用推测补全。'
              )}
            </div>

            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              {notes[selectedApp.name] ? (
                <div className="src none" title={new Date(notes[selectedApp.name].updatedAt).toLocaleString('zh-CN')}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 13h2.4l7-7-2.4-2.4-7 7z" />
                  </svg>
                  手写备注 · {new Date(notes[selectedApp.name].updatedAt).toLocaleString('zh-CN')}
                </div>
              ) : verified ? (
                <div className="src link" onClick={() => void window.butler.shell.open(verify.sourceUrl)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M6.6 9.4a3 3 0 004.2 0l1.8-1.8a3 3 0 00-4.2-4.2l-1 1" />
                    <path d="M9.4 6.6a3 3 0 00-4.2 0L3.4 8.4a3 3 0 004.2 4.2l1-1" />
                  </svg>
                  官网 · {hostOf(verify.sourceUrl)}
                </div>
              ) : (
                <div className="src none">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 5.2v.2M8 7.6v3.4" />
                  </svg>
                  无官方出处
                </div>
              )}
            </div>
          </div>
        )}

        <div className="note-bar">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#7A7A7A" strokeWidth="1.4">
            <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" />
            <path d="M5.6 7V5.2a2.4 2.4 0 014.8 0V7" />
          </svg>
          <span>
            <b>清单来自注册表只读采集</b>；卸载会先弹出授权卡，通过后启动该程序自己的卸载程序，由你在窗口里确认——不静默卸载、不删安装目录。删文件仍然只能删演示沙箱里的演示文件。未查证的程序只显示“未查证”，不会用推测补全。
            {loading ? '' : ` 本次读取耗时 ${durationMs || '<1'} ms。`}
          </span>
        </div>
      </main>
    </div>
  )
}
