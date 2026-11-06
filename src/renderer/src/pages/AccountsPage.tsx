import { useEffect, useState } from 'react'
import type { ButlerConfig, MailAccount } from '../../../shared/types'
import type { SettingsSection } from './SettingsPage'

interface Props {
  /** 跳到设置页的指定分区做增删改 */
  onManage: (section?: SettingsSection) => void
}

const SEARCH_LABEL: Record<string, string> = {
  serper: 'Serper（Google）',
  tavily: 'Tavily',
  bingapi: 'Bing 官方 API',
  duckduckgo: 'DuckDuckGo（免费）',
  bing: 'Bing 网页抓取（免费）',
  none: '已关闭联网'
}

/** 账号管理（概念图 04）：邮箱账号 + 各类服务账号，改动统一去设置页做 */
export default function AccountsPage({ onManage }: Props) {
  const [config, setConfig] = useState<ButlerConfig | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({})
  /** 中栏账号搜索 */
  const [query, setQuery] = useState('')

  const load = async (): Promise<void> => {
    setConfig(await window.butler.config.get())
  }

  useEffect(() => {
    void load()
  }, [])

  const test = async (acc: MailAccount): Promise<void> => {
    if (!config) return
    setTestingId(acc.id)
    try {
      const result = await window.butler.mail.test({ mail: config.mail, mailAccounts: config.mailAccounts }, acc.id)
      setStatus((prev) => ({ ...prev, [acc.id]: { ok: result.ok, text: result.detail } }))
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        [acc.id]: { ok: false, text: err instanceof Error ? err.message : String(err) }
      }))
    } finally {
      setTestingId(null)
    }
  }

  if (!config) {
    return (
      <main className="content">
        <div className="empty">正在读取账号配置…</div>
      </main>
    )
  }

  const accounts = config.mailAccounts ?? []
  const mailFilled = Boolean(config.mail?.address?.trim() && config.mail?.authCode?.trim())
  const modelKeyed = Boolean(config.apiKey?.trim())
  const searchKeyed = Boolean(config.searchKey?.trim())

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>账号管理</h2>
          <span className="icobtn" role="button" title="添加账号" onClick={() => onManage('mail')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </div>
        <div className="searchbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="10.8" cy="10.8" r="6.2" />
            <path d="M15.4 15.4 20 20" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索账号" />
        </div>
        <div className="seclabel">
          全部账号<span className="cnt">{accounts.length}</span>
        </div>
        {accounts.length === 0 ? (
          <div className="empty-mid">
            <b>还没有账号</b>
            去添加一个邮箱，长庚才能替你看信
          </div>
        ) : (
          accounts
            .filter((acc) => {
              const q = query.trim().toLowerCase()
              if (!q) return true
              return (acc.label ?? '').toLowerCase().includes(q) || acc.address.toLowerCase().includes(q)
            })
            .map((acc, index) => {
            const filled = Boolean(acc.address.trim() && acc.authCode.trim())
            return (
              <div className={`item two${index === 0 ? ' sel' : ''}`} key={acc.id} style={{ cursor: 'default' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3.4" y="5.6" width="17.2" height="12.8" rx="2.2" />
                  <path d="M4.2 7.2l7.1 5.3c.4.3 1 .3 1.4 0l7.1-5.3" />
                </svg>
                <span className="t">
                  {acc.label?.trim() || acc.address || '（未填地址）'}
                  <span className={filled ? 'sub' : 'sub warn'}>{filled ? '已配置' : '缺授权码'}</span>
                </span>
              </div>
            )
          })
        )}
        <div className="seclabel">服务</div>
        <div className="item" style={{ cursor: 'default' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M13.4 3.6 5.8 13h5l-1.2 7.4L17.2 11h-5z" strokeLinejoin="round" />
          </svg>
          <span className="t">模型服务</span>
          <span className="tm">{modelKeyed ? '已配置' : '本机可免'}</span>
        </div>
        <div className="item" style={{ cursor: 'default' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <circle cx="11" cy="11" r="6.2" />
            <path d="M15.6 15.6L20 20" />
          </svg>
          <span className="t">{SEARCH_LABEL[config.searchProvider] ?? '检索'}</span>
          <span className="tm">{searchKeyed ? '有 Key' : config.searchProvider === 'none' ? '关闭' : '无 Key'}</span>
        </div>
        <div className="item" style={{ cursor: 'default' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.8 8.1V6.9c0-1 .8-1.8 1.8-1.8h3.2l1.7 2h7.7c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8Z" />
          </svg>
          <span className="t">本机文件</span>
          <span className="tm">只读</span>
        </div>
      </aside>

      <main className="content" style={{ padding: 0 }}>
        <div className="acc-wrap">
          <div className="acc-h">
            <div>
              <h1>账号管理</h1>
              <p>邮箱账号替你读邮件（每个都只读）；服务账号决定长庚用哪个模型、去哪里检索。</p>
            </div>
            <span className="sp" />
            <button className="btn btn-primary" onClick={() => onManage('mail')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              添加账号
            </button>
          </div>

          {accounts.length === 0 && (
            <div className="empty-mid" style={{ margin: '0 0 10px' }}>
              <b>还没有任何账号</b>
              点「添加账号」去设置里填地址和授权码
            </div>
          )}

          {accounts.map((acc, index) => {
            const filled = Boolean(acc.address.trim() && acc.authCode.trim())
            const st = status[acc.id]
            return (
              <div className="acard" key={acc.id}>
                <span className={`atile${index === 0 ? '' : ' q'}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3.4" y="5.6" width="17.2" height="12.8" rx="2.2" />
                    <path d="M4.2 7.2l7.1 5.3c.4.3 1 .3 1.4 0l7.1-5.3" />
                  </svg>
                </span>
                <div className="acc-main">
                  <div className="acc-line">
                    <span className="acc-name">{acc.label?.trim() || acc.address || '（未填地址）'}</span>
                    <span className={filled ? 'st' : 'st warn'}>
                      <i />
                      {filled ? (index === 0 ? '默认账号 · 已配置' : '已配置') : '缺授权码'}
                    </span>
                  </div>
                  <div className="addr">{acc.address || '—'}</div>
                  <div className="acc-chips">
                    <span className="mini-chip">读取邮件</span>
                    <span className="mini-chip">IMAP 只读</span>
                    <span className="mini-chip">授权码登录</span>
                    <span className="mini-chip gold">不标记已读 · 不删信 · 不发信</span>
                  </div>
                  {st && <div className={`result-line ${st.ok ? 'ok' : 'bad'}`}>{st.text}</div>}
                </div>
                <div className="acc-right">
                  <span className="acc-time">{filled ? 'IMAP 只读接入' : '待补全凭据'}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="mngbtn" disabled={testingId !== null} onClick={() => void test(acc)}>
                      {testingId === acc.id ? '连接中…' : '测试连接'}
                    </button>
                    <button className="mngbtn" onClick={() => onManage('mail')}>
                      管理
                    </button>
                  </div>
                </div>
              </div>
            )
          })}

          <button className="addcard" onClick={() => onManage('mail')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" width="14" height="14">
              <path d="M12 5v14M5 12h14" />
            </svg>
            添加邮件账号（地址 + 授权码，服务器自动探测）
          </button>

          <div className="seclabel2">连接的服务</div>
          <div className="svc-grid">
            <div className="svc">
              <span className="atile">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                  <path d="M13.4 3.6 5.8 13h5l-1.2 7.4L17.2 11h-5z" strokeLinejoin="round" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>模型服务</b>
                <span className="s2">
                  {config.model || '未填模型名'} · {new URL(config.baseUrl, 'https://x').host}
                </span>
              </div>
              <button className="mngbtn" onClick={() => onManage('model')}>
                管理
              </button>
            </div>
            <div className="svc">
              <span className="atile">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                  <circle cx="11" cy="11" r="6.2" />
                  <path d="M15.6 15.6L20 20" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{SEARCH_LABEL[config.searchProvider] ?? '检索服务'}</b>
                <span className="s2">
                  {config.searchProvider === 'none'
                    ? '联网已关闭：外部问题一律如实答「查不到」'
                    : searchKeyed
                      ? '已填 Key · 保存后可在设置里测试检索'
                      : '未填 Key（免费源可用，常被反爬）'}
                </span>
              </div>
              <button className="mngbtn" onClick={() => onManage('search')}>
                管理
              </button>
            </div>
            <div className="svc">
              <span className="atile q">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.8 8.1V6.9c0-1 .8-1.8 1.8-1.8h3.2l1.7 2h7.7c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8Z" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>本机文件</b>
                <span className="s2">注册表与应用台账 · 只读 · 无需账号</span>
              </div>
              <span className="mini-chip">系统级</span>
            </div>
          </div>

          <div className="acc-tip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3.6 19 6v5.4c0 4.2-2.9 7.5-7 8.8-4.1-1.3-7-4.6-7-8.8V6Z" />
              <path d="M9.2 11.8l2 2 3.7-3.7" />
            </svg>
            <div>
              <b>邮箱只有一条通路：IMAP 只读</b>
              <span>没有发信、删信、移动邮件的工具；对话里的所有邮件动作都会记进操作记录。</span>
            </div>
          </div>

          <div className="acc-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="10.4" width="14" height="9.4" rx="2.2" />
              <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
            </svg>
            授权码和 Key 只存在本机 config.json，不进对话、不上传。
            {mailFilled ? '' : ''}
          </div>
        </div>
      </main>
    </div>
  )
}
