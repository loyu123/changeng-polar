import { useEffect, useState, type ReactNode } from 'react'
import ChatPage from './pages/ChatPage'
import SettingsPage, { type SettingsSection } from './pages/SettingsPage'
import AccountsPage from './pages/AccountsPage'
import TasksPage from './pages/TasksPage'
import PluginsPage from './pages/PluginsPage'
import ProjectsPage from './pages/ProjectsPage'
import OrchestrationPage from './pages/OrchestrationPage'
import OverviewPage from './pages/OverviewPage'
import { GlobalSearch } from './components/GlobalSearch'

export type Route = 'chat' | 'tasks' | 'overview' | 'plugins' | 'accounts' | 'projects' | 'orchestration' | 'settings'

interface AppInfo {
  machineName: string
  userName: string
  osVersion: string
  today: string
  appVersion: string
  userData: string
}

/** 长庚图标：缺口环 + 四角星（A 案） */
function Logo({ size = 21 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        stroke="#A8C8E8"
        strokeWidth="1.7"
        pathLength={100}
        strokeDasharray="78 22"
        strokeLinecap="round"
      />
      <path d="M12 6.6 Q12.72 11.28 17.4 12 Q12.72 12.72 12 17.4 Q11.28 12.72 6.6 12 Q11.28 11.28 12 6.6Z" fill="#8CB6E0" />
      <path d="M17.7 4.5 Q17.99 6.16 19.65 6.45 Q17.99 6.74 17.7 8.4 Q17.41 6.74 15.75 6.45 Q17.41 6.16 17.7 4.5Z" fill="#D8B87A" />
    </svg>
  )
}

/* 图标条：线性 1.6 描边，20px */
const IC = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
const ICONS: Record<Route, ReactNode> = {
  chat: (
    <svg viewBox="0 0 24 24">
      <path {...IC} d="M20.2 11.6c0 3.5-3.6 6.4-8.1 6.4-1 0-1.9-.14-2.8-.4L4.4 19l1.2-3.2c-1.2-1.1-1.9-2.5-1.9-4.1 0-3.5 3.7-6.4 8.2-6.4s8.3 2.9 8.3 6.3Z" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24">
      <circle {...IC} cx="12" cy="12" r="8.3" />
      <path {...IC} d="M12 7.4v4.9l3.2 2" />
    </svg>
  ),
  plugins: (
    <svg viewBox="0 0 24 24">
      <rect {...IC} x="3.8" y="3.8" width="7" height="7" rx="2" />
      <rect {...IC} x="13.2" y="3.8" width="7" height="7" rx="2" />
      <rect {...IC} x="3.8" y="13.2" width="7" height="7" rx="2" />
      <path {...IC} d="M16.7 13.4v6.8M13.4 16.7h6.8" />
    </svg>
  ),
  projects: (
    <svg viewBox="0 0 24 24">
      <path
        {...IC}
        d="M3.8 8.1V6.9c0-1 .8-1.8 1.8-1.8h3.2l1.7 2h7.7c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8Z"
      />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24">
      <rect {...IC} x="3.8" y="4.6" width="7.4" height="6.4" rx="1.6" />
      <rect {...IC} x="12.8" y="4.6" width="7.4" height="6.4" rx="1.6" />
      <rect {...IC} x="3.8" y="12.6" width="7.4" height="6.4" rx="1.6" />
      <rect {...IC} x="12.8" y="12.6" width="7.4" height="6.4" rx="1.6" />
    </svg>
  ),
  accounts: (
    <svg viewBox="0 0 24 24">
      <circle {...IC} cx="12" cy="8.6" r="3.6" />
      <path {...IC} d="M4.8 19.4c.6-3.4 3.6-5.4 7.2-5.4s6.6 2 7.2 5.4" />
    </svg>
  ),
  orchestration: (
    <svg viewBox="0 0 24 24">
      {/* 一根主干分三支：长庚做总线派活 */}
      <circle {...IC} cx="5.6" cy="12" r="2.1" />
      <circle {...IC} cx="18.4" cy="6.4" r="2.1" />
      <circle {...IC} cx="18.4" cy="17.6" r="2.1" />
      <path {...IC} d="M7.7 12h2.6c1.1 0 1.6-.6 1.6-1.6V8.4c0-1.1.6-1.6 1.6-1.6h2.8M7.7 12h2.6c1.1 0 1.6.6 1.6 1.6v2c0 1.1.6 1.6 1.6 1.6h2.8" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24">
      <path
        {...IC}
        d="M19.3 13.6a7.6 7.6 0 0 0 0-3.2l1.8-1.3-1.5-2.7-2.1.9a7.4 7.4 0 0 0-2.7-1.6L14.4 3.2H9.6l-.4 2.5a7.4 7.4 0 0 0-2.7 1.6l-2.1-.9-1.5 2.7 1.8 1.3a7.6 7.6 0 0 0 0 3.2l-1.8 1.3 1.5 2.7 2.1-.9a7.4 7.4 0 0 0 2.7 1.6l.4 2.5h4.8l.4-2.5a7.4 7.4 0 0 0 2.7-1.6l2.1.9 1.5-2.7-1.8-1.3Z"
      />
      <circle {...IC} cx="12" cy="12" r="2.7" />
    </svg>
  )
}

/** 图标条：所有目的地平铺，不再收进「更多」 */
const RAIL: Array<{ key: Route; label: string }> = [
  { key: 'chat', label: '对话' },
  { key: 'overview', label: '总览' },
  { key: 'projects', label: '项目' },
  { key: 'orchestration', label: '编排' },
  { key: 'tasks', label: '定时任务' },
  { key: 'plugins', label: '能力与插件' },
  { key: 'accounts', label: '账号管理' }
]

const SECTION_LABEL: Record<SettingsSection, string> = {
  model: '模型',
  search: '检索来源',
  mail: '账号管理',
  accountsLogin: '账号与登录',
  pluginsCap: '插件与能力',
  security: '权限与安全',
  records: '操作记录',
  apps: '应用台账',
  installed: '已安装程序',
  general: '常规',
  orb: '桌面助手',
  shortcuts: '快捷键',
  storage: '存储与缓存',
  about: '关于'
}

export default function App() {
  const [route, setRoute] = useState<Route>('chat')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [prefill, setPrefill] = useState({ text: '', nonce: 0 })
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model')
  /** 从总览点任务/项目/简报：带着 id（可选简报 id）跳到项目页 */
  const [focusProject, setFocusProject] = useState<{
    id: string
    nonce: number
    briefId?: string
    planId?: string
  } | null>(null)
  /** 从项目页点「出自对话」：跳回对话页定位那条回答 */
  const [focusChat, setFocusChat] = useState<{
    sessionId: string
    messageId?: string
    nonce: number
  } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  /** 标题栏副标题用的真实计数 */
  const [stats, setStats] = useState({ mail: 0, mailReady: 0, tasksOn: 0, tools: 0, toolsOn: 0, projects: 0 })

  useEffect(() => {
    void window.butler.info().then(setInfo)
  }, [])

  const loadStats = (): void => {
    void window.butler.config.get().then((cfg) => {
      const accounts = cfg.mailAccounts ?? []
      // 只填了地址、没有授权码的账号接不通，不能算进"已配置"
      const ready = accounts.filter((a) => Boolean(a.address?.trim() && a.authCode?.trim())).length
      setStats((prev) => ({ ...prev, mail: accounts.length, mailReady: ready }))
    })
    void window.butler.tasks.list().then((list) => {
      setStats((prev) => ({ ...prev, tasksOn: list.filter((t) => t.enabled).length }))
    })
    void window.butler.tools.list().then((list) => {
      setStats((prev) => ({ ...prev, tools: list.length, toolsOn: list.filter((t) => t.enabled).length }))
    })
    void window.butler.projects.list().then((list) => {
      setStats((prev) => ({ ...prev, projects: list.length }))
    })
  }

  useEffect(() => {
    loadStats()
    const off = window.butler.tasks.onChanged(loadStats)
    window.addEventListener('polar:projects-changed', loadStats)
    return () => {
      off()
      window.removeEventListener('polar:projects-changed', loadStats)
    }
  }, [])

  // 托盘或悬浮球右键菜单给的路由：主进程只说是哪一页，换页由这里决定
  useEffect(() => {
    const off = window.butler.desktop.onRoute((route) => {
      if (route === 'tasks' || route === 'chat' || route === 'settings') setRoute(route)
    })
    return off
  }, [])

  // 桌面助手把一段对话「移到主窗口」：跳去对话页并定位到这条会话
  useEffect(() => {
    return window.butler.orb.onOpenSession((sessionId) => {
      setFocusChat({ sessionId, nonce: Date.now() })
      setRoute('chat')
    })
  }, [])

  // Ctrl+K / Cmd+K 呼出全局搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const askInChat = (text: string): void => {
    setPrefill({ text, nonce: Date.now() })
    setRoute('chat')
  }

  const openAccounts = (): void => setRoute('accounts')

  const go = (target: Route): void => {
    setRoute(target)
  }

  const subtitle = ((): string => {
    if (route === 'chat') return `本机 · 已授权 ${stats.mail} 个账号`
    if (route === 'tasks') return `定时任务 · ${stats.tasksOn} 个已启用`
    if (route === 'plugins') return `自定义 · ${stats.tools} 个能力 · ${stats.toolsOn} 个已启用`
    if (route === 'accounts') return `${stats.mail} 个账号 · ${stats.mailReady} 个已配置`
    if (route === 'overview') return `总览 · 项目 ${stats.projects} 个`
    if (route === 'projects') return `项目 · ${stats.projects} 个`
    return `设置 · ${SECTION_LABEL[settingsSection]}`
  })()

  return (
    <div className="win">
      <div className="titlebar">
        <div className="tb-left">
          <span className="appico">
            <Logo />
          </span>
          <span className="appname-wrap">
            <span className="appname">长庚</span>
            <span className="appname-en">POLAR</span>
          </span>
          <span className="tb-div" />
          <span className="tb-sub">{subtitle}</span>
          <span style={{ flex: 1 }} />
          <span className="pill-ro">
            {route === 'accounts' ? (
              <>
                <svg viewBox="0 0 24 24">
                  <rect {...IC} x="5" y="10.4" width="14" height="9.4" rx="2.2" />
                  <path {...IC} d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
                </svg>
                凭据存在本机
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24">
                  <path {...IC} d="M12 3.6 19 6v5.4c0 4.2-2.9 7.5-7 8.8-4.1-1.3-7-4.6-7-8.8V6Z" />
                  <path {...IC} d="M9.2 11.8l2 2 3.7-3.7" />
                </svg>
                只读模式
              </>
            )}
          </span>
        </div>
        <div className="tb-btns">
          <button title="最小化" onClick={() => void window.butler.win.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
          <button title="最大化" onClick={() => void window.butler.win.toggleMaximize()}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
          <button className="close" title="关闭" onClick={() => void window.butler.win.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
        </div>
      </div>

      <div className="win-body">
        <nav className="rail">
          {RAIL.map((item) => (
            <button
              key={item.key}
              className={`rbtn${route === item.key ? ' on' : ''}`}
              title={item.label}
              aria-label={item.label}
              onClick={() => go(item.key)}
            >
              {ICONS[item.key]}
            </button>
          ))}
          <div className="rsp" />
          <div className="rsep" />
          <button className="rbtn" title="搜索全部（Ctrl K）" aria-label="搜索全部" onClick={() => setSearchOpen(true)}>
            <svg viewBox="0 0 24 24">
              <circle {...IC} cx="10.8" cy="10.8" r="6.2" />
              <path {...IC} d="M15.4 15.4 20 20" />
            </svg>
          </button>
          <button
            className={`rbtn${route === 'settings' ? ' on' : ''}`}
            title="设置"
            aria-label="设置"
            onClick={() => go('settings')}
          >
            {ICONS.settings}
          </button>
        </nav>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'chat' ? 'flex' : 'none' }}>
            <ChatPage
              prefill={prefill}
              info={info}
              focusChat={focusChat}
              onOpenSettings={(section) => {
                setSettingsSection(section ?? 'model')
                setRoute('settings')
              }}
              onOpenProjects={() => setRoute('projects')}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'tasks' ? 'flex' : 'none' }}>
            <TasksPage />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'plugins' ? 'flex' : 'none' }}>
            <PluginsPage />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'accounts' ? 'flex' : 'none' }}>
            <AccountsPage onManage={(section) => { setSettingsSection(section ?? 'mail'); setRoute('settings') }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'overview' ? 'flex' : 'none' }}>
            <OverviewPage
              onOpenProject={(id, briefId) => {
                if (id) setFocusProject({ id, nonce: Date.now(), briefId })
                setRoute('projects')
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'projects' ? 'flex' : 'none' }}>
            <ProjectsPage
              onAsk={askInChat}
              focusProject={focusProject}
              onOpenChat={(sessionId, messageId) => {
                setFocusChat({ sessionId, messageId, nonce: Date.now() })
                setRoute('chat')
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'orchestration' ? 'flex' : 'none' }}>
            <OrchestrationPage />
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: route === 'settings' ? 'flex' : 'none' }}>
            <SettingsPage
              info={info}
              initialSection={settingsSection}
              onAsk={askInChat}
              onSectionChange={setSettingsSection}
              onOpenPage={(target) => setRoute(target)}
            />
          </div>
        </div>
      </div>

      <GlobalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenProject={(projectId, planId) => {
          setFocusProject({ id: projectId, nonce: Date.now(), planId })
          setRoute('projects')
        }}
        onOpenChat={(sessionId, messageId) => {
          setFocusChat({ sessionId, messageId, nonce: Date.now() })
          setRoute('chat')
        }}
      />
    </div>
  )
}
