import { useEffect, useMemo, useState } from 'react'

/**
 * 桌面应用（设置 › 应用台账 的主界面）。
 *
 * 数据源是**桌面快捷方式**，不是注册表里的全部已安装程序：
 * 那 129 条里绝大多数是运行库和系统组件，用户根本不认识。
 * 桌面是用户自己摆过的地方，那里有什么就是什么。
 *
 * 三条必须做到的：
 * 1. 图标用**应用自己的**（系统给 .lnk 解析出的真实图标），拿不到就灰底占位，不编。
 * 2. **随桌面变化**：主进程 watch 两个桌面目录，这里收到事件就刷新。
 * 3. 注册表那份台账没被删掉——它挪到「已安装程序」页，服务"这个程序是什么"的查证场景。
 */

interface DesktopApp {
  key: string
  name: string
  lnkPath: string
  target?: string
  icon?: string
  from: 'user' | 'public'
  mtime: number
}

interface Props {
  onAsk: (text: string) => void
  /** 切到注册表那份清单 */
  onOpenInstalled?: () => void
}

export default function DesktopAppsPage({ onAsk, onOpenInstalled }: Props): React.JSX.Element {
  const [apps, setApps] = useState<DesktopApp[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<DesktopApp | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = (await window.butler.desktopApps.list()) as DesktopApp[]
      setApps(list)
      setError(null)
      // 选中的那个如果被删了，跟着清掉
      setSelected((cur) => (cur && !list.some((a) => a.key === cur.key) ? null : cur))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 盯桌面：拖进来、删掉、改名都会推一条事件
    void window.butler.desktopApps.watch()
    const off = window.butler.desktopApps.onChanged(() => {
      setLoading(true)
      void load()
    })
    return () => {
      off()
      void window.butler.desktopApps.unwatch()
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter((a) => a.name.toLowerCase().includes(q) || (a.target ?? '').toLowerCase().includes(q))
  }, [apps, query])

  const openTarget = async (app: DesktopApp): Promise<void> => {
    // 让长庚打开它：走 launch_app 那条路（有"已经开着就调到前面"的处理）
    onAsk(`打开「${app.name}」`)
  }

  return (
    <div className="appgrid-wrap">
      <div className="cap-h">
        <div>
          <h1>桌面应用</h1>
          <p>
            桌面上摆着的 {apps.length} 个应用 · 随桌面自动更新
            {onOpenInstalled && (
              <>
                {' · '}
                <button className="hint-link" onClick={onOpenInstalled}>
                  看全部已安装程序（含系统组件）
                </button>
              </>
            )}
          </p>
        </div>
        <span className="sp" />
        <div className="searchbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.2" />
            <path d="M15.4 15.4 20 20" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜桌面应用" />
        </div>
        <button className="icobtn" title="重新读取桌面" onClick={() => { setLoading(true); void load() }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" />
          </svg>
        </button>
      </div>

      {error && <div className="empty">读不到桌面：{error}</div>}
      {loading && apps.length === 0 && <div className="empty">正在读桌面…</div>}
      {!loading && filtered.length === 0 && (
        <div className="empty">{query ? '桌面上没有匹配的应用' : '桌面上没有应用快捷方式'}</div>
      )}

      <div className="appgrid">
        {filtered.map((app) => (
          <button
            key={app.key}
            className={`appcell${selected?.key === app.key ? ' sel' : ''}`}
            onClick={() => setSelected(selected?.key === app.key ? null : app)}
            onDoubleClick={() => void openTarget(app)}
            title={app.target ?? app.lnkPath}
          >
            <span className="appicon-lg">
              {app.icon ? (
                <img src={app.icon} alt="" draggable={false} />
              ) : (
                // 拿不到图标就灰底首字母——不编一个假图标
                <span className="appicon-fb">{app.name.slice(0, 1)}</span>
              )}
            </span>
            <span className="appname">{app.name}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="card appdetail">
          <div className="appdetail-h">
            <span className="appicon-lg sm">
              {selected.icon ? <img src={selected.icon} alt="" /> : <span className="appicon-fb">{selected.name.slice(0, 1)}</span>}
            </span>
            <div style={{ minWidth: 0 }}>
              <b className="appdetail-t">{selected.name}</b>
              <div className="sub">{selected.from === 'public' ? '公共桌面（所有用户）' : '我的桌面'}</div>
            </div>
            <span className="sp" />
            <button className="btn btn-primary btn-sm" onClick={() => void openTarget(selected)}>
              打开
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => onAsk(`桌面上的「${selected.name}」装在哪个目录、是什么程序`)}
            >
              问长庚这是什么
            </button>
          </div>
          <dl className="appdetail-dl">
            <dt>快捷方式</dt>
            <dd>{selected.lnkPath}</dd>
            <dt>目标</dt>
            <dd>{selected.target ?? '（未解析；双击即可打开）'}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}
