import { useEffect, useMemo, useRef, useState } from 'react'

interface ToolInfo {
  name: string
  label: string
  description: string
  effect: string
  allowAlways: boolean
  enabled: boolean
}

type Tab = 'plugins' | 'caps'

/** 权限标记：概念图 03 只有 只读 / 需授权 / 可写 三种胶囊 */
function permOf(effect: string): { cls: 'ro' | 'auth' | 'wr'; text: string } {
  if (effect === 'destroy' || effect === 'install') return { cls: 'auth', text: '需授权' }
  if (effect === 'write') return { cls: 'wr', text: '可写' }
  if (effect === 'ui') return { cls: 'ro', text: '纯界面' }
  return { cls: 'ro', text: '只读' }
}

/** 每枚能力一个线性图标（1.6 描边），按工具名归到最接近的一类 */
function iconOf(name: string): string {
  if (name.includes('email')) return 'M3.4 5.6h17.2v12.8H3.4zM4.2 7.2l7.1 5.3c.4.3 1 .3 1.4 0l7.1-5.3'
  if (name.includes('install')) return 'M12 4v9M8.4 9.6 12 13.2l3.6-3.6M5 17.4h14'
  if (name.includes('uninstall')) return 'M5 17.4h14M8 7.4h8M9.4 7.4V5.2h5.2v2.2'
  if (name.includes('delete') || name.includes('sandbox')) return 'M4.6 7.4h14.8M9.4 7.4V5.4h5.2v2M6.4 7.4l.9 12h9.4l.9-12'
  if (name.includes('startup')) return 'M12 3.6v8M8.2 6.6A7 7 0 1 0 15.8 6.6'
  if (name.includes('web_search')) return 'M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4ZM15.4 15.4 20 20M8 10.8h5.6M10.8 8v5.6'
  if (name.includes('web_fetch')) return 'M6.4 3.8h7.2l4.6 4.6v11.8H6.4zM13.4 3.9v4.7h4.7'
  if (name.includes('settings')) return 'M19.3 13.6a7.6 7.6 0 0 0 0-3.2l1.8-1.3-1.5-2.7-2.1.9a7.4 7.4 0 0 0-2.7-1.6L14.4 3.2H9.6l-.4 2.5a7.4 7.4 0 0 0-2.7 1.6l-2.1-.9-1.5 2.7 1.8 1.3a7.6 7.6 0 0 0 0 3.2l-1.8 1.3 1.5 2.7 2.1-.9a7.4 7.4 0 0 0 2.7 1.6l.4 2.5h4.8l.4-2.5a7.4 7.4 0 0 0 2.7-1.6l2.1.9 1.5-2.7-1.8-1.3Z'
  return 'M3.2 4.6h17.6v11.4H3.2zM9 20h6M12 16.2V20'
}

/** 自定义 · 能力（概念图 03）：插件 = 外部扩展（MCP，暂缓）；能力 = 内置工具开关 */
export default function PluginsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('caps')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void window.butler.tools.list().then((list) => {
      setTools(list)
      setLoading(false)
    })
  }, [])

  const toggle = async (tool: ToolInfo): Promise<void> => {
    setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled: !t.enabled } : t)))
    try {
      await window.butler.tools.toggle(tool.name, !tool.enabled)
    } catch {
      setTools((prev) => prev.map((t) => (t.name === tool.name ? { ...t, enabled: tool.enabled } : t)))
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tools
    return tools.filter((t) => t.label.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  }, [tools, query])

  const enabledCount = tools.filter((t) => t.enabled).length

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>自定义</h2>
          <span className="icobtn" role="button" title="搜索能力" onClick={() => { setTab('caps'); searchRef.current?.focus() }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <circle cx="10.8" cy="10.8" r="6.2" />
              <path d="M15.4 15.4 20 20" />
            </svg>
          </span>
        </div>
        <button className={`item${tab === 'plugins' ? ' sel' : ''}`} onClick={() => setTab('plugins')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.8" y="3.8" width="7" height="7" rx="2" />
            <rect x="13.2" y="3.8" width="7" height="7" rx="2" />
            <rect x="3.8" y="13.2" width="7" height="7" rx="2" />
            <path d="M16.7 13.4v6.8M13.4 16.7h6.8" />
          </svg>
          <span className="t">插件</span>
          <span className="tm">MCP</span>
        </button>
        <button className={`item${tab === 'caps' ? ' sel' : ''}`} onClick={() => setTab('caps')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M3.2 4.6h17.6v11.4H3.2zM9 20h6M12 16.2V20" />
          </svg>
          <span className="t">能力</span>
          <span className="tm">{tools.length}</span>
        </button>

        <div className="seclabel">
          已安装<span className="cnt">{tools.length}</span>
        </div>
        {tools.map((tool) => (
          <button
            key={tool.name}
            className="item"
            onClick={() => {
              setTab('caps')
              setQuery(tool.label)
            }}
          >
            <span className="t">{tool.label}</span>
            <span className="tm">{tool.enabled ? '已启用' : '未启用'}</span>
          </button>
        ))}
      </aside>

      <main className="content" style={{ padding: 0 }}>
        <div className="cap-wrap">
          {tab === 'plugins' ? (
            <>
              <div className="cap-h">
                <div>
                  <h1>插件</h1>
                  <p>外部服务器扩展的长庚能力，走 Model Context Protocol 接入。</p>
                </div>
              </div>
              <div className="card" style={{ padding: 34, textAlign: 'center' }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#A8C8E8" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3.8" y="3.8" width="7" height="7" rx="2" />
                  <rect x="13.2" y="3.8" width="7" height="7" rx="2" />
                  <rect x="3.8" y="13.2" width="7" height="7" rx="2" />
                  <path d="M16.7 13.4v6.8M13.4 16.7h6.8" />
                </svg>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#4E4E47', marginTop: 10 }}>还没有接入任何 MCP 服务器</div>
                <div style={{ fontSize: 12, color: '#8E8E86', marginTop: 5, lineHeight: 1.7 }}>
                  MCP 接入还在开发中，这里不做假开关。
                  <br />
                  左边的「能力」开关是第一步，切换立即生效。
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="cap-h">
                <div>
                  <h1>能力</h1>
                  <p>给长庚加一项本领。每项都写清楚它要看什么、能不能改。</p>
                </div>
                <span className="sp" />
                <div className="searchbox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                    <circle cx="10.8" cy="10.8" r="6.2" />
                    <path d="M15.4 15.4 20 20" />
                  </svg>
                  <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索能力" />
                </div>
              </div>

              {loading && <div className="empty">读取工具注册表…</div>}
              {!loading && filtered.length === 0 && <div className="empty">没有匹配的能力</div>}

              {!loading && (
                <div className="grid2">
                  {filtered.map((tool) => {
                    const perm = permOf(tool.effect)
                    return (
                      <div className="ccard" key={tool.name}>
                        <div className="cc-top">
                          <span className="ctile">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                              <path d={iconOf(tool.name)} />
                            </svg>
                          </span>
                          <span className="cc-name" title={tool.description}>
                            {tool.label}
                          </span>
                          <span
                            className={`ck${tool.enabled ? ' on' : ' off'}`}
                            role="switch"
                            aria-checked={tool.enabled}
                            tabIndex={0}
                            onClick={() => void toggle(tool)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                void toggle(tool)
                              }
                            }}
                            title={tool.enabled ? '停用这个能力' : '启用这个能力'}
                          >
                            {tool.enabled && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4.5 12.6l4.6 4.6L19.5 6.8" />
                              </svg>
                            )}
                          </span>
                        </div>
                        <div className="cc-desc">{tool.description}</div>
                        <div className="cc-foot">
                          <span className={`perm ${perm.cls}`}>
                            <i />
                            {perm.text}
                          </span>
                          <span className="meta">{tool.enabled ? '已启用' : '未启用'}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="cap-foot">
                共 {tools.length} 个内置能力 · {enabledCount} 个已启用 · 关掉一个，模型本轮就看不到它
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
