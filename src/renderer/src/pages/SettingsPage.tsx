import { useEffect, useState, type ReactNode } from 'react'
import type { AlwaysAllowedEntry, ButlerConfig, DesktopPrefs, MailAccount, MemoryEntry, OrbPrefs } from '../../../shared/types'
import type { DesktopState } from '../../../shared/desktop'
import { MEMORY_KIND_LABEL } from '../../../shared/types'
import { deriveImapHost } from '../../../shared/mail-hosts'
import RecordsPage from './RecordsPage'
import AppsPage from './AppsPage'

/**
 * 可点的开关。
 *
 * `.sw` 这套样式原本只用于展示（设置页里全是 fixed 的静态开关），所以这里补齐
 * 键盘可达与 aria 语义；外观仍走同一套类名，不另造一种开关。
 */
function Switch({
  on,
  disabled,
  title,
  onToggle
}: {
  on: boolean
  disabled?: boolean
  title?: string
  onToggle: () => void
}) {
  const act = (): void => {
    if (!disabled) onToggle()
  }
  return (
    <span
      className={`sw${on ? ' on' : ''}${disabled ? ' fixed' : ''}`}
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={title}
      style={disabled ? undefined : { cursor: 'pointer' }}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          act()
        }
      }}
    >
      <i />
    </span>
  )
}

export type SettingsSection =
  | 'model'
  | 'search'
  | 'mail'
  | 'accountsLogin'
  | 'pluginsCap'
  | 'security'
  | 'records'
  | 'apps'
  | 'general'
  | 'orb'
  | 'shortcuts'
  | 'storage'
  | 'about'

interface Props {
  info: {
    machineName: string
    userName: string
    osVersion: string
    today: string
    appVersion: string
    userData: string
  } | null
  /** 外部入口（如账号管理页「管理」）直接落到的分区 */
  initialSection?: SettingsSection
  /** 应用台账页里「需要时启用/卸载」要转发到对话 */
  onAsk?: (text: string) => void
  /** 跳到独立页（账号管理 / 插件与能力） */
  onOpenPage?: (route: 'accounts' | 'plugins') => void
  /** 分区变化时回报，供标题栏副标题同步 */
  onSectionChange?: (section: SettingsSection) => void
}

export default function SettingsPage({ info, initialSection, onAsk, onOpenPage, onSectionChange }: Props) {
  const [config, setConfig] = useState<ButlerConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [searchTesting, setSearchTesting] = useState(false)
  const [mailTestingId, setMailTestingId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [mailStatus, setMailStatus] = useState<Record<string, { ok: boolean; text: string }>>({})
  /** 每个账号的「高级」折叠开关：展示手动指定 IMAP 服务器 */
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({})
  /** 左侧分区导航当前项 */
  const [section, setSection] = useState<SettingsSection>('model')
  /** 分区搜索词 */
  const [navQuery, setNavQuery] = useState('')
  /** 存储占用（存储与缓存分区） */
  const [storageStats, setStorageStats] = useState<{ dir: string; files: Array<{ file: string; bytes: number }> } | null>(null)
  /** 操作记录条数（权限与安全里的「查看记录 N」） */
  const [recordCount, setRecordCount] = useState(0)
  /** 能力概况（设置 › 插件与能力） */
  const [toolsStat, setToolsStat] = useState<{ total: number; on: number; names: string[] }>({ total: 0, on: 0, names: [] })
  /** 密钥是否加密落盘：保存后的提示文案要跟事实一致 */
  const [secretsEncrypted, setSecretsEncrypted] = useState(false)
  /** 只读模式：立即生效，不走「保存」按钮（它不属于可保存分区） */
  const [readOnly, setReadOnly] = useState(false)
  const [togglingReadOnly, setTogglingReadOnly] = useState(false)
  /** 桌面常驻：偏好 + 系统登录项现状（两者可能不一致） */
  const [desktop, setDesktop] = useState<DesktopState | null>(null)
  const [desktopBusy, setDesktopBusy] = useState(false)
  /** 悬浮助手：偏好 + 快捷键是否真的注册上了（可能被别的程序占用） */
  const [orb, setOrb] = useState<{ prefs: OrbPrefs; hotkeyOk: boolean } | null>(null)
  const [orbBusy, setOrbBusy] = useState(false)
  /** 快捷键输入框的草稿：失焦/回车才提交，逐字注册会中途抢键 */
  const [hotkeyDraft, setHotkeyDraft] = useState('')

  useEffect(() => {
    void window.butler.storage.stats().then(setStorageStats)
    void window.butler.config.secretsEncrypted().then(setSecretsEncrypted)
    void window.butler.records.list(500).then((list) => setRecordCount(list.length))
    void window.butler.tools.list().then((list) =>
      setToolsStat({
        total: list.length,
        on: list.filter((t) => t.enabled).length,
        names: list.filter((t) => t.enabled).map((t) => t.label)
      })
    )
    void window.butler.desktop.state().then(setDesktop)
    void window.butler.orb.state().then((s) => {
      setOrb(s)
      setHotkeyDraft(s.prefs.hotkey)
    })
  }, [])

  /** 悬浮助手偏好同样即时生效：改完立刻建/藏球、注册快捷键 */
  const setOrbPref = async (patch: Partial<OrbPrefs>): Promise<void> => {
    if (orbBusy) return
    setOrbBusy(true)
    try {
      const next = await window.butler.orb.set(patch)
      setOrb(next)
      setHotkeyDraft(next.prefs.hotkey)
    } finally {
      setOrbBusy(false)
    }
  }

  /** 桌面偏好是即时生效的，不走「保存」按钮：改完立刻落到窗口和系统登录项 */
  const setDesktopPref = async (patch: Partial<DesktopPrefs>): Promise<void> => {
    if (desktopBusy) return
    setDesktopBusy(true)
    try {
      setDesktop(await window.butler.desktop.set(patch))
    } finally {
      setDesktopBusy(false)
    }
  }

  // 外部入口指定分区时跟随（如账号管理页点「管理」直接到邮箱账号）
  useEffect(() => {
    if (initialSection) setSection(initialSection)
  }, [initialSection])

  // 分区变化回报给外层：标题栏副标题「设置 · XXX」要跟着走
  useEffect(() => {
    onSectionChange?.(section)
  }, [section, onSectionChange])

  const [memory, setMemory] = useState<AlwaysAllowedEntry[]>([])
  /** 跨会话记忆（与上面的授权记忆不是一回事：那是"始终允许"，这是"记住的事"） */
  const [memories, setMemories] = useState<MemoryEntry[]>([])

  useEffect(() => {
    void window.butler.config.get().then((loaded) => {
      // 旧版单账号（config.mail）迁移成列表的第一项：只迁移编辑器状态，保存后 mailAccounts 生效
      if (!loaded.mailAccounts?.length && loaded.mail?.address) {
        loaded.mailAccounts = [
          { id: 'default', label: loaded.mail.address, address: loaded.mail.address, authCode: loaded.mail.authCode, host: loaded.mail.host, port: loaded.mail.port }
        ]
      }
      setConfig(loaded)
      setReadOnly(loaded.readOnly === true)
    })
    void window.butler.auth.list().then(setMemory)
    void window.butler.memory.list().then(setMemories)
  }, [])

  const deleteMemory = async (id: string): Promise<void> => {
    setMemories(await window.butler.memory.delete(id))
  }
  const clearMemory = async (): Promise<void> => {
    if (!window.confirm('清除全部记忆？这不会删除对话记录，只是让长庚忘掉这些事。')) return
    setMemories(await window.butler.memory.clear())
  }

  /** 只读模式：写进配置并立即生效，下一轮对话就会按新状态装配工具 */
  const toggleReadOnly = async (): Promise<void> => {
    if (togglingReadOnly) return
    setTogglingReadOnly(true)
    const next = !readOnly
    try {
      const saved = await window.butler.config.save({ readOnly: next })
      setReadOnly(saved.readOnly === true)
    } catch (err) {
      setStatus({ ok: false, text: `切换只读模式失败：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTogglingReadOnly(false)
    }
  }

  const revoke = async (key: string): Promise<void> => {
    setMemory(await window.butler.auth.revoke(key))
  }

  const clearAll = async (): Promise<void> => {
    setMemory(await window.butler.auth.clear())
  }

  const update = (patch: Partial<ButlerConfig>): void => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const save = async (): Promise<void> => {
    if (!config) return
    setSaving(true)
    try {
      const saved = await window.butler.config.save(config)
      setConfig(saved)
      setStatus({ ok: true, text: `已保存到本机（${secretsEncrypted ? '密钥经系统加密后落盘' : '明文 JSON，仅本机可读'}）` })
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!config) return
    setTesting(true)
    setStatus(null)
    try {
      const result = await window.butler.config.test(config)
      setStatus({
        ok: result.ok,
        text: `${result.ok ? '连通' : '失败'} · ${result.latencyMs} ms · ${result.detail}`
      })
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  // 检索自检：只发一次检索、不进模型，用来确认 Key 或代理是否可用
  const testSearch = async (): Promise<void> => {
    if (!config) return
    setSearchTesting(true)
    setStatus(null)
    try {
      const result = await window.butler.search.test({
        searchProvider: config.searchProvider,
        searchKey: config.searchKey
      })
      if (result.ok) {
        const first = result.sample[0]
        setStatus({
          ok: true,
          text: `检索可用 · ${result.provider} · ${result.count} 条 · ${result.latencyMs} ms${
            first ? ` · 首条：${first.title}` : ''
          }`
        })
      } else {
        setStatus({ ok: false, text: `检索失败 · ${result.provider} · ${result.error ?? '原因未知'}` })
      }
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSearchTesting(false)
    }
  }

  // 邮箱自检：只连一次 IMAP 只读打开收件箱，不拉正文；按账号测，互不影响
  const testMailNow = async (acc: MailAccount): Promise<void> => {
    if (!config) return
    setMailTestingId(acc.id)
    try {
      const result = await window.butler.mail.test(
        { mail: config.mail, mailAccounts: config.mailAccounts },
        acc.id
      )
      setMailStatus((prev) => ({ ...prev, [acc.id]: { ok: result.ok, text: result.detail } }))
    } catch (err) {
      setMailStatus((prev) => ({
        ...prev,
        [acc.id]: { ok: false, text: err instanceof Error ? err.message : String(err) }
      }))
    } finally {
      setMailTestingId(null)
    }
  }

  // 账号列表编辑：新增/改/删都在本地 state，点「保存」才落盘
  const updateAccount = (id: string, patch: Partial<MailAccount>): void => {
    if (!config) return
    update({
      mailAccounts: (config.mailAccounts ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a))
    })
  }
  const addAccount = (): void => {
    if (!config) return
    update({
      mailAccounts: [
        ...(config.mailAccounts ?? []),
        { id: `acc_${Date.now().toString(36)}`, address: '', authCode: '', host: '', port: 993 }
      ]
    })
  }
  const removeAccount = (id: string): void => {
    if (!config) return
    update({ mailAccounts: (config.mailAccounts ?? []).filter((a) => a.id !== id) })
  }

  if (!config) return <main className="content">正在读取配置…</main>

  const mailCount = (config.mailAccounts ?? []).length
  const mailCard = (
    <div className="cardbox">
      <div className="ch">邮箱账号（只读接入）</div>
      <div className="form" style={{ padding: '12px 15px 14px' }}>
        <div className="hint" style={{ marginBottom: 8 }}>
          只需填地址和授权码：常见邮箱按地址识别服务器，企业邮箱会自动探测（腾讯/网易/阿里企业邮都试一遍，连不上再展开「高级」手填）。
          排在第一的是默认账号；对话里说「看 XX 邮箱」按地址匹配。QQ 邮箱：网页版「设置 → 账户 →
          POP3/IMAP/SMTP 服务」开启并生成授权码。只读接入：不标记已读、不删信、不发信。
        </div>
        {(config.mailAccounts ?? []).map((acc, index) => {
          const st = mailStatus[acc.id]
          const derivedHost = deriveImapHost(acc.address)
          const advanced = showAdvanced[acc.id] ?? false
          return (
            <div
              key={acc.id}
              style={{ borderTop: index === 0 ? 'none' : '1px solid #F1F1ED', paddingTop: index === 0 ? 0 : 12, marginTop: index === 0 ? 0 : 12 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: index === 0 ? '#2C7A4F' : '#8E8E86' }}>
                  {index === 0 ? '默认账号' : `账号 ${index + 1}`}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={mailTestingId !== null}
                  onClick={() => void testMailNow(acc)}
                >
                  {mailTestingId === acc.id ? '连接中…' : '测试'}
                </button>
                <button className="btn btn-ghost btn-sm deny" onClick={() => removeAccount(acc.id)}>
                  删除
                </button>
              </div>
              <div className="grid2">
                <div className="form-row">
                  <label>邮箱地址</label>
                  <input
                    className="input"
                    value={acc.address}
                    placeholder="test@example.com"
                    onChange={(e) => updateAccount(acc.id, { address: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>IMAP 授权码</label>
                  <input
                    className="input"
                    type="password"
                    value={acc.authCode}
                    placeholder="授权码，不是登录密码"
                    onChange={(e) => updateAccount(acc.id, { authCode: e.target.value })}
                  />
                </div>
              </div>
              <div className="hint">
                {acc.host?.trim() && derivedHost && acc.host.trim().toLowerCase() !== derivedHost.toLowerCase()
                  ? `将使用 ${acc.host.trim()}（手动指定）`
                  : `服务器自动探测：优先 ${derivedHost || '（填好地址后推导）'}，连不上会依次尝试常见企业邮服务器（腾讯/网易/阿里）`}
              </div>
              {advanced && (
                <div className="grid2" style={{ marginTop: 6 }}>
                  <div className="form-row">
                    <label>IMAP 服务器（高级）</label>
                    <input
                      className="input"
                      value={acc.host}
                      placeholder={derivedHost || 'imap.qq.com'}
                      onChange={(e) => updateAccount(acc.id, { host: e.target.value })}
                    />
                    <div className="hint">留空 = 自动探测（含腾讯/网易/阿里企业邮）；填了就强制用这个服务器。</div>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowAdvanced((p) => ({ ...p, [acc.id]: !advanced }))}>
                  {advanced ? '收起高级' : '高级'}
                </button>
              </div>
              {st && <div className={`result-line ${st.ok ? 'ok' : 'bad'}`}>{st.text}</div>}
            </div>
          )
        })}
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={addAccount}>
            ＋ 添加账号
          </button>
        </div>
      </div>
    </div>
  )

  const sections: Record<SettingsSection, { title: string; lead: string; body: ReactNode; raw?: boolean }> = {
    model: {
      title: '模型',
      lead: '模型与 Key 都只存在本机 config.json；Key 不进日志、不进对话历史。',
      body: (
        <div className="cardbox">
          <div className="ch">模型</div>
          <div className="form" style={{ padding: '12px 15px 14px' }}>
            <div className="form-row">
              <label>模型地址（OpenAI 兼容）</label>
              <input
                className="input"
                value={config.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
              <div className="hint">
                填 <code>/v1</code> 或完整的 <code>/v1/chat/completions</code> 都可以；本机 Ollama 可填{' '}
                <code>http://127.0.0.1:11434/v1</code>
              </div>
            </div>
            <div className="grid2">
              <div className="form-row">
                <label>模型名</label>
                <input
                  className="input"
                  value={config.model}
                  placeholder="gpt-4o-mini"
                  onChange={(e) => update({ model: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>API Key</label>
                <input
                  className="input"
                  type="password"
                  value={config.apiKey}
                  placeholder="sk-…（本机端点可留空）"
                  onChange={(e) => update({ apiKey: e.target.value })}
                />
              </div>
            </div>
            <div className="grid2">
              <div className="form-row">
                <label>输出方式</label>
                <select
                  className="input"
                  value={config.stream ? 'stream' : 'plain'}
                  onChange={(e) => update({ stream: e.target.value === 'stream' })}
                >
                  <option value="stream">流式（推荐）</option>
                  <option value="plain">整段返回（网关不支持流式时用）</option>
                </select>
              </div>
              <div className="form-row">
                <label>温度</label>
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={config.temperature}
                  onChange={(e) => update({ temperature: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="form-row" style={{ marginTop: 14 }}>
              <label>判分模型（评测用，可选）</label>
              <div className="hint" style={{ marginBottom: 8 }}>
                评测脚本用它给回答打分。<b>必须与上面的模型不同</b>——同一个模型给自己打分，高分只能说明它自我感觉良好。
                没配时，需要模型判分的用例会退化成正则断言，报告里会标明。
              </div>
              {config.judge ? (
                <>
                  <div className="grid2">
                    <div className="form-row">
                      <label>模型名</label>
                      <input
                        className="input"
                        value={config.judge.model}
                        placeholder="例如 deepseek-chat"
                        onChange={(e) => update({ judge: { ...config.judge!, model: e.target.value } })}
                      />
                    </div>
                    <div className="form-row">
                      <label>API Key</label>
                      <input
                        className="input"
                        type="password"
                        value={config.judge.apiKey}
                        placeholder="sk-…"
                        onChange={(e) => update({ judge: { ...config.judge!, apiKey: e.target.value } })}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label>接口地址</label>
                    <input
                      className="input"
                      value={config.judge.baseUrl}
                      placeholder="https://api.deepseek.com/v1"
                      onChange={(e) => update({ judge: { ...config.judge!, baseUrl: e.target.value } })}
                    />
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => update({ judge: undefined })}
                  >
                    清除判分模型
                  </button>
                </>
              ) : (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    update({
                      judge: {
                        baseUrl: 'https://api.deepseek.com/v1',
                        apiKey: '',
                        model: '',
                        stream: false,
                        temperature: 0
                      }
                    })
                  }
                >
                  配置判分模型
                </button>
              )}
            </div>
          </div>
        </div>
      )
    },
    search: {
      title: '检索来源',
      lead: '联网检索的来源与 Key；关闭联网后，长庚对外部问题一律如实回答「查不到」。',
      body: (
        <div className="cardbox">
          <div className="ch">检索来源</div>
          <div className="form" style={{ padding: '12px 15px 14px' }}>
            <div className="form-row">
              <label>来源</label>
              <select
                className="input"
                value={config.searchProvider}
                onChange={(e) => update({ searchProvider: e.target.value as ButlerConfig['searchProvider'] })}
              >
                <option value="serper">Serper（Google 结果，需 Key，中文最准）</option>
                <option value="tavily">Tavily（需 Key，正文摘要较全）</option>
                <option value="bingapi">Bing 官方 API v7（需 Azure Key）</option>
                <option value="duckduckgo">DuckDuckGo（免费抓取，常被反爬）</option>
                <option value="bing">Bing 网页抓取（免费，噪声大）</option>
                <option value="none">关闭联网（用来验证“查不到”降级）</option>
              </select>
              <div className="hint">
                带 Key 的来源失败时会自动回落到免费源；关闭联网后，长庚对任何外部问题都必须回答“查不到”，这是 H2 的自检方式。
              </div>
            </div>
            {(config.searchProvider === 'tavily' ||
              config.searchProvider === 'serper' ||
              config.searchProvider === 'bingapi') && (
              <div className="form-row">
                <label>
                  {config.searchProvider === 'tavily'
                    ? 'Tavily API Key'
                    : config.searchProvider === 'serper'
                      ? 'Serper API Key'
                      : 'Bing 订阅 Key'}
                </label>
                <input
                  className="input"
                  type="password"
                  value={config.searchKey}
                  placeholder={
                    config.searchProvider === 'tavily'
                      ? 'tvly-…'
                      : config.searchProvider === 'serper'
                        ? 'serper.dev 的 Key'
                        : 'Azure Ocp-Apim-Subscription-Key'
                  }
                  onChange={(e) => update({ searchKey: e.target.value })}
                />
                <div className="hint">Key 只存在本机 config.json；保存后点「测试检索」验证。</div>
              </div>
            )}
          </div>
        </div>
      )
    },
    mail: {
      title: '邮箱账号',
      lead: '多个邮箱各自授权；只读接入，任何邮件动作都不会改动邮箱本身。',
      body: mailCard
    },
    // 账号与登录：给自己一块独立版面，不再一点就跳走
    accountsLogin: {
      title: '账号与登录',
      lead: '长庚没有云端账号。身份、Key、邮箱授权码都只放在这台机器上，不需要注册。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">本机身份</div>
            <div className="row">
              <div className="rl">
                <b>{info?.userName ?? '本机用户'}</b>
                <span>
                  {info?.machineName ?? '—'} · {info?.osVersion ?? '—'}
                </span>
              </div>
              <span className="cval">无需登录</span>
            </div>
            <div className="row">
              <div className="rl">
                <b>凭据存放</b>
                <span>Key 与授权码写在 config.json，不进日志、不进对话历史</span>
              </div>
              <span className="pathbox">
                <code style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {info?.userData ?? '—'}
                </code>
              </span>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">
              邮箱账号<span style={{ marginLeft: 6, color: 'var(--ink4)', fontWeight: 400 }}>{mailCount} 个</span>
            </div>
            {(config.mailAccounts ?? []).length === 0 ? (
              <div className="row">
                <div className="rl">
                  <b>还没有接入邮箱</b>
                  <span>接入后只能读：列邮件、读正文，不标记已读、不删信、不发信。</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => onOpenPage?.('accounts')}>
                  去添加
                </button>
              </div>
            ) : (
              (config.mailAccounts ?? []).map((acc, index) => (
                <div className="row" key={acc.id}>
                  <div className="rl">
                    <b>{acc.address || '（未填地址）'}</b>
                    <span>{index === 0 ? '默认账号 · 只读' : '只读'}</span>
                  </div>
                  <span className="cval">{acc.host?.trim() || '自动探测服务器'}</span>
                </div>
              ))
            )}
            {(config.mailAccounts ?? []).length > 0 && (
              <div className="form" style={{ padding: '0 15px 14px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => onOpenPage?.('accounts')}>
                  打开账号管理
                </button>
              </div>
            )}
          </div>
        </>
      )
    },
    // 插件与能力：设置里给概览，明细去独立页改
    pluginsCap: {
      title: '插件与能力',
      lead: '能力 = 长庚自己会做的事；插件 = 外部 MCP 扩展（暂缓）。开关都在独立页里，改完立即生效。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">
              内置能力<span style={{ marginLeft: 6, color: 'var(--ink4)', fontWeight: 400 }}>
                {toolsStat.on}/{toolsStat.total} 已启用
              </span>
            </div>
            <div className="row">
              <div className="rl">
                <b>{toolsStat.on === toolsStat.total ? '全部已启用' : `已停用 ${toolsStat.total - toolsStat.on} 项`}</b>
                <span>{toolsStat.names.slice(0, 6).join('、')}{toolsStat.names.length > 6 ? ' 等' : ''}</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => onOpenPage?.('plugins')}>
                打开能力页
              </button>
            </div>
            <div className="row">
              <div className="rl">
                <b>停用会怎样</b>
                <span>关掉一项，模型这一轮就看不到它，也无法调用；重新打开即可恢复。</span>
              </div>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">外部插件（MCP）</div>
            <div className="row">
              <div className="rl">
                <b>还没有接入任何插件</b>
                <span>外部插件的连接与鉴权还在开发中；就绪前不做假开关。</span>
              </div>
              <span className="cval">暂缓</span>
            </div>
          </div>
        </>
      )
    },
    security: {
      title: '权限与安全',
      lead: '决定长庚能看到什么、能改什么。默认从最小权限开始，写操作逐次确认。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">默认权限</div>
            <div className="row">
              <div className="rl">
                <b>只读模式</b>
                <span>
                  打开后，安装、卸载、删除、写入记忆这类会改动机器的工具<b>不会出现在工具清单里</b>——
                  模型连申请的机会都没有，定时任务也一样。关掉即恢复，仍然逐次弹授权卡。
                </span>
              </div>
              <button
                role="switch"
                aria-checked={readOnly}
                aria-label="只读模式"
                className={`sw${readOnly ? ' on' : ''}`}
                title={readOnly ? '只读模式已开：改动机器的工具全部不可用' : '只读模式已关：写操作仍需要逐次授权'}
                disabled={togglingReadOnly}
                onClick={() => void toggleReadOnly()}
              >
                <i />
              </button>
            </div>
            <div className="row">
              <div className="rl">
                <b>
                  完整访问<em className="tag-gold">未实现</em>
                </b>
                <span>允许读写任意文件、执行命令。这一版没有这条通路，开关不假装能打开。</span>
              </div>
              <span className="sw fixed" title="未实现：本版没有读写任意文件的工具">
                <i />
              </span>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">写操作</div>
            <div className="row">
              <div className="rl">
                <b>写操作逐次确认</b>
                <span>
                  {readOnly
                    ? '当前是只读模式：所有会改动机器的工具都没有注册，不存在「确认后执行」这一步。'
                    : '装软件、卸载、删沙箱文件之前，都要先弹授权卡。'}
                </span>
              </div>
              <span
                className={`sw${readOnly ? '' : ' on'} fixed`}
                title={readOnly ? '只读模式下没有可执行的写操作' : '本版固定开启：销毁类与安装类每次都弹卡'}
              >
                <i />
              </span>
            </div>
            <div className="row">
              <div className="rl">
                <b>可写范围</b>
                <span>只有演示沙箱里的文件能删；真实文件没有任何写入通路。</span>
              </div>
              <span className="cval">{readOnly ? '无（只读模式）' : '仅演示沙箱'}</span>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">操作记录</div>
            <div className="row">
              <div className="rl">
                <b>保留操作记录</b>
                <span>每一步都记下时间、动作、动了哪个文件。</span>
              </div>
              <span className="cval">不限条数</span>
              <button className="linkbtn" onClick={() => setSection('records')}>
                查看记录<span className="num">{recordCount}</span>
              </button>
            </div>
            <div className="row">
              <div className="rl">
                <b>支持撤回</b>
                <span>删除只进回收站，可还原；撤回本身也会被记下来。</span>
              </div>
              <span className="sw on fixed" title="本版固定开启：删除走回收站，可从记录里撤回">
                <i />
              </span>
            </div>
          </div>

          <details className="techfold">
            <summary>技术说明（代码层边界）</summary>
            <ul style={{ paddingLeft: 16, fontSize: 12, color: '#5A5A54', lineHeight: 1.8, paddingBottom: 12 }}>
              <li>主进程注册 10 个工具：6 个只读/纯 UI（含邮箱只读）、2 个仅作用于演示沙箱、2 个真实系统操作（安装/卸载，均需授权卡）</li>
              <li>删除/写入真实文件没有任何通路；安装/卸载是仅有的真实系统写入，每次都要授权</li>
              <li>卸载只启动程序自己的卸载程序，不静默、不删安装目录</li>
              <li>邮箱以 IMAP 只读打开：不标记已读、不删信、不发信</li>
              <li>渲染层只能通过白名单通道调用，无 node 能力</li>
            </ul>
          </details>
          <div className="cardbox">
            <div className="ch">记忆（跨会话）</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10 }}>
                长庚记下的、下次对话还能想起来的事（偏好、正在做的项目、约定的规则）。
                它会出现在每次对话的系统提示里，但<b>只是线索</b>——涉及本机事实仍然要现查。
              </div>
              {memories.length === 0 ? (
                <div style={{ color: '#8E8E86', fontSize: 12 }}>还没有记下任何东西。对话里说「记住…」即可。</div>
              ) : (
                <>
                  {memories.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderTop: '1px solid #F1F1ED'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12 }}>
                          <span style={{ color: '#0067C0' }}>{MEMORY_KIND_LABEL[item.kind] ?? '记录'}</span>
                          <span style={{ color: '#5A5A54', marginLeft: 8 }}>{item.text}</span>
                        </div>
                        <div style={{ fontSize: 11, color: '#8E8E86' }}>
                          {new Date(item.updatedAt).toLocaleString('zh-CN')}
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => void deleteMemory(item.id)}>
                        删除
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => void clearMemory()}>
                    全部清除
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">授权记忆（「始终允许」）</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10 }}>
                只有明确点过「始终允许」的工具才会留在这里（当前仅<b>安装</b>，按包名 + 版本记忆）。撤销立即生效。
              </div>
              {memory.length === 0 ? (
                <div style={{ color: '#8E8E86', fontSize: 12 }}>还没有任何「始终允许」。授权卡上点「始终允许」才会出现在这里。</div>
              ) : (
                <>
                  {memory.map((item) => (
                    <div
                      key={item.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderTop: '1px solid #F1F1ED'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{item.tool}</div>
                        <div style={{ fontSize: 12, color: '#5A5A54', wordBreak: 'break-all' }}>{item.target}</div>
                        <div style={{ fontSize: 11, color: '#8E8E86' }}>
                          {new Date(item.createdAt).toLocaleString('zh-CN')}
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => void revoke(item.key)}>
                        撤销
                      </button>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => void clearAll()}>
                      全部撤销
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )
    },
    // 常规（概念图 · 个人组）：外观与语言，没做的如实标注，不用灰掉的下拉假装能选
    general: {
      title: '常规',
      lead: '常驻与开机行为。这三项改完立刻生效，不用点保存——它们落的是窗口和系统登录项，不是配置文件里的一行字。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">常驻</div>
            <div className="row">
              <div className="rl">
                <b>关闭窗口时收进托盘</b>
                <span>
                  关窗只是把窗口收起，进程继续跑，定时任务照常执行。从托盘图标点回来，或右键「退出长庚」才真正结束。
                  关掉这一项，关窗就退出，定时任务也会一起停。
                </span>
              </div>
              <Switch
                on={desktop?.prefs.closeToTray ?? true}
                disabled={desktopBusy}
                title={desktop?.prefs.closeToTray ? '关窗收进托盘' : '关窗即退出'}
                onToggle={() => void setDesktopPref({ closeToTray: !(desktop?.prefs.closeToTray ?? true) })}
              />
            </div>
            <div className="row">
              <div className="rl">
                <b>定时任务完成时通知</b>
                <span>任务跑完或失败时弹一条系统通知，点它能回到窗口。对话里的回答不弹——那时你就在窗口前。</span>
              </div>
              <Switch
                on={desktop?.prefs.notifyOnTask ?? true}
                disabled={desktopBusy}
                title={desktop?.prefs.notifyOnTask ? '完成时通知' : '不通知'}
                onToggle={() => void setDesktopPref({ notifyOnTask: !(desktop?.prefs.notifyOnTask ?? true) })}
              />
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">开机</div>
            <div className="row">
              <div className="rl">
                <b>
                  开机自动启动
                  {desktop && !desktop.canAutoLaunch && <em className="tag-gold">仅打包版</em>}
                </b>
                <span>
                  {desktop && !desktop.canAutoLaunch
                    ? '开发态不写系统登录项——登记成 electron.exe 会丢掉应用路径，开机只会起一个空窗口。打包安装后这一项才生效。'
                    : '登录 Windows 后自动在托盘待命，不弹窗口。定时任务因此不会因为「电脑重启过」而整天不跑。'}
                </span>
              </div>
              <Switch
                on={desktop?.atLogin ?? false}
                disabled={desktopBusy || !(desktop?.canAutoLaunch ?? false)}
                title={desktop?.atLogin ? '已设为开机启动' : '未设为开机启动'}
                onToggle={() => void setDesktopPref({ launchAtLogin: !(desktop?.atLogin ?? false) })}
              />
            </div>
            {desktop && desktop.canAutoLaunch && desktop.prefs.launchAtLogin !== desktop.atLogin && (
              <div className="row">
                <div className="rl">
                  <span>设置里想开机启动，但系统登录项里查不到——可能被系统的「启动应用」管理关掉了。</span>
                </div>
              </div>
            )}
          </div>

          <div className="cardbox">
            <div className="ch">外观</div>
            <div className="row">
              <div className="rl">
                <b>主题</b>
                <span>深色主题开发中，就绪后在这里切换</span>
              </div>
              <span className="cval">浅色（唯一）</span>
            </div>
            <div className="row">
              <div className="rl">
                <b>界面语言</b>
                <span>界面文案目前只有简体中文，日期时间跟随系统区域设置</span>
              </div>
              <span className="cval">简体中文</span>
            </div>
          </div>
        </>
      )
    },
    // 桌面助手（悬浮球与面板）
    orb: {
      title: '桌面助手',
      lead: '桌面上常驻一个球，点开是一条窄对话面板。它有自己的一套短会话，不写进主窗口的「最近」——桌面随口问的那句，不该把归档的对话挤下去。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">显示</div>
            <div className="row">
              <div className="rl">
                <b>在桌面上显示助手</b>
                <span>关掉后球从桌面消失，但仍可从托盘或全局快捷键把面板叫出来。</span>
              </div>
              <Switch
                on={orb?.prefs.enabled ?? true}
                disabled={orbBusy}
                title={orb?.prefs.enabled ? '显示中' : '已隐藏'}
                onToggle={() => void setOrbPref({ enabled: !(orb?.prefs.enabled ?? true) })}
              />
            </div>
            <div className="row">
              <div className="rl">
                <b>待命动效</b>
                <span>
                  关掉后球保持静止。呼吸只动缩放与透明度，走合成层，不触发重绘；思考与等确认时的动画不受这项影响。
                </span>
              </div>
              <Switch
                on={orb?.prefs.idleAnimation ?? true}
                disabled={orbBusy}
                title={orb?.prefs.idleAnimation ? '有动效' : '静止'}
                onToggle={() => void setOrbPref({ idleAnimation: !(orb?.prefs.idleAnimation ?? true) })}
              />
            </div>
            <div className="row">
              <div className="rl">
                <b>呼出快捷键</b>
                <span>
                  {orb && !orb.hotkeyOk
                    ? '当前没能注册上——多半被别的程序占用了，换一个组合试试。'
                    : '任何时候把对话面板叫到前台。留空 = 不注册全局快捷键。'}
                </span>
              </div>
              <input
                className="input"
                style={{ width: 190, height: 28, fontSize: 12 }}
                value={hotkeyDraft}
                placeholder="CommandOrControl+Shift+K"
                disabled={orbBusy}
                onChange={(e) => setHotkeyDraft(e.target.value)}
                onBlur={() => {
                  if (hotkeyDraft !== (orb?.prefs.hotkey ?? '')) void setOrbPref({ hotkey: hotkeyDraft })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">位置与历史</div>
            <div className="row">
              <div className="rl">
                <b>回到默认位置</b>
                <span>球被拖到看不见的地方时用这个：右下角、避开任务栏。</span>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                disabled={orbBusy}
                onClick={() => void setOrbPref({ x: null, y: null })}
              >
                归位
              </button>
            </div>
            <div className="row">
              <div className="rl">
                <b>桌面会话</b>
                <span>
                  与主窗口分开存（orb-sessions.json），保留最近 20 条。面板里删掉的不影响主窗口；
                  想长期留着，用面板标题栏的「移到主窗口」搬过去。
                </span>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (!window.confirm('清空桌面侧的会话？主窗口的对话不受影响。')) return
                  void window.butler.orb.sessions.clear()
                }}
              >
                清空
              </button>
            </div>
          </div>

          <div className="setfoot">
            <span>球本质是一个 72×72 的透明置顶窗口，不进任务栏也不进 Alt+Tab</span>
          </div>
        </>
      )
    },
    // 快捷键（概念图 · 编码组）：只列真实存在的
    shortcuts: {
      title: '快捷键',
      lead: '当前可用的快捷键。全局唤起窗口这类系统级快捷键要等托盘常驻一起做。',
      body: (
        <div className="cardbox">
          <div className="ch">对话与输入</div>
          <div className="form" style={{ padding: '12px 15px 14px' }}>
            {[
              ['Enter', '发送消息'],
              ['Shift + Enter', '输入框内换行'],
              ['Esc', '取消正在编辑的应用备注']
            ].map(([key, desc]) => (
              <div className="setrow" key={key}>
                <div className="rl">
                  <b>
                    <code style={{ background: '#F4F4F1', borderRadius: 4, padding: '1px 6px', fontSize: 11.5 }}>{key}</code>
                  </b>
                  <span>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    },
    // 存储与缓存（概念图 · 编码组）：真实占用 + 打开数据目录 + 清会话
    storage: {
      title: '存储与缓存',
      lead: '所有数据都在本机。对话会话存在渲染层的浏览器存储里，其余是 userData 下的 JSON / 日志文件。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">数据目录</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ wordBreak: 'break-all', marginBottom: 8 }}>
                <code>{storageStats?.dir ?? info?.userData ?? '—'}</code>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => void window.butler.shell.openPath(storageStats?.dir ?? info?.userData ?? '')}
              >
                打开数据目录
              </button>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">文件占用</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              {(storageStats?.files ?? []).length === 0 ? (
                <div style={{ fontSize: 12, color: '#8E8E86' }}>还没有数据文件。</div>
              ) : (
                (storageStats?.files ?? []).map((f) => (
                  <div className="setrow" key={f.file} style={{ paddingLeft: 0 }}>
                    <div className="rl">
                      <b style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{f.file}</b>
                    </div>
                    <span style={{ fontSize: 12, color: '#5A5A54', fontVariantNumeric: 'tabular-nums' }}>
                      {f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">缓存</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="setrow" style={{ paddingLeft: 0 }}>
                <div className="rl">
                  <b>最近会话（对话页中栏）</b>
                  <span>存在浏览器存储，最多 20 条；清空后不可恢复。</span>
                </div>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    if (window.confirm('清空对话页的全部历史会话？这会删除 sessions.json 里的记录，不能恢复。')) {
                      void window.butler.sessions.clear().then(() => {
                        localStorage.removeItem('polar-chat-sessions')
                        window.alert('已清空。回到对话页即可看到效果。')
                      })
                    }
                  }}
                >
                  清空
                </button>
              </div>
            </div>
          </div>
        </>
      )
    },
    // 原独立页迁入设置：整页原样嵌入（含各自的中栏），占满分区内容区
    records: {
      title: '操作记录',
      lead: '所有动作全部留痕，销毁类没有你点通过就不执行。',
      raw: true,
      body: <RecordsPage active />
    },
    apps: {
      title: '应用台账',
      lead: '注册表只读采集；说明来自官网查证或手写备注，都没有就如实标未登记。',
      raw: true,
      body: <AppsPage active onAsk={(text) => onAsk?.(text)} />
    },
    about: {
      title: '关于',
      lead: '这台机器的信息与未竟事项。',
      body: (
        <>
          <div className="cardbox">
            <div className="ch">这台机器</div>
            <div className="form" style={{ padding: '12px 15px 14px', fontSize: 12.3, color: '#5A5A54', lineHeight: 1.8 }}>
              <div>名称：{info?.machineName ?? '—'}</div>
              <div>用户：{info?.userName ?? '—'}</div>
              <div>系统：{info?.osVersion ?? '—'}</div>
              <div>版本：长庚 demo {info?.appVersion ?? '—'}</div>
              <div style={{ wordBreak: 'break-all' }}>
                数据目录：<code>{info?.userData ?? '—'}</code>
              </div>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">还没做</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <ul style={{ paddingLeft: 16, fontSize: 12, color: '#5A5A54', lineHeight: 1.8 }}>
                <li>定时任务后台常驻（托盘/服务化：当前应用开着才跑）</li>
                <li>MCP 真实连接（外部插件协议：暂缓，保留台账与对话入口作为接口）</li>
                <li>全文索引（P2）</li>
              </ul>
            </div>
          </div>
        </>
      )
    }
  }

  const sec = sections[section]
  /** 只有真正要落盘 config 的分区才显示「保存」，其余分区不摆没作用的按钮 */
  const savable = section === 'model' || section === 'search' || section === 'mail'

  return (
    <main className="content" style={{ padding: 0, flexDirection: 'row' }}>
      <nav className="setnav">
        <div className="searchbox" style={{ margin: '2px 0 4px' }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L13.4 13.4" />
          </svg>
          <input value={navQuery} onChange={(e) => setNavQuery(e.target.value)} placeholder="搜索设置…" />
        </div>
        {navQuery.trim() === '' && <div className="sgrp">个人</div>}
        {('账号与登录'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button
            className={`sitem${section === 'accountsLogin' ? ' sel' : ''}`}
            onClick={() => setSection('accountsLogin')}
          >
            账号与登录
          </button>
        )}
        {('常规'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'general' ? ' sel' : ''}`} onClick={() => setSection('general')}>
            常规
          </button>
        )}
        {('桌面助手'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'orb' ? ' sel' : ''}`} onClick={() => setSection('orb')}>
            桌面助手
          </button>
        )}
        {navQuery.trim() === '' && <div className="sgrp">集成</div>}
        {('账号管理'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'mail' ? ' sel' : ''}`} onClick={() => setSection('mail')}>
            账号管理
            <span className="kbd">{mailCount}</span>
          </button>
        )}
        {('插件与能力'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'pluginsCap' ? ' sel' : ''}`} onClick={() => setSection('pluginsCap')}>
            插件与能力
          </button>
        )}
        {('权限与安全'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'security' ? ' sel' : ''}`} onClick={() => setSection('security')}>
            权限与安全
          </button>
        )}
        {navQuery.trim() === '' && <div className="sgrp">本机</div>}
        {('应用台账'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'apps' ? ' sel' : ''}`} onClick={() => setSection('apps')}>
            应用台账
          </button>
        )}
        {('操作记录'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'records' ? ' sel' : ''}`} onClick={() => setSection('records')}>
            操作记录
          </button>
        )}
        {navQuery.trim() === '' && <div className="sgrp">编码</div>}
        {('模型'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'model' ? ' sel' : ''}`} onClick={() => setSection('model')}>
            模型
          </button>
        )}
        {('检索来源'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'search' ? ' sel' : ''}`} onClick={() => setSection('search')}>
            检索来源
          </button>
        )}
        {('快捷键'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'shortcuts' ? ' sel' : ''}`} onClick={() => setSection('shortcuts')}>
            快捷键
          </button>
        )}
        {('存储与缓存'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'storage' ? ' sel' : ''}`} onClick={() => setSection('storage')}>
            存储与缓存
          </button>
        )}
        {('关于'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'about' ? ' sel' : ''}`} onClick={() => setSection('about')}>
            关于
          </button>
        )}
      </nav>

      <div className="setmain">
        {sec.raw ? (
          // 整页分区（操作记录/应用台账）：直接占满内容区
          sec.body
        ) : (
        <div className="setwrap">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1>{sec.title}</h1>
              <p className="lead">{sec.lead}</p>
            </div>
            <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
              {section === 'search' && (
                <button className="btn btn-ghost" disabled={testing || searchTesting} onClick={() => void testSearch()}>
                  {searchTesting ? '检索中…' : '测试检索'}
                </button>
              )}
              {section === 'model' && (
                <button className="btn btn-ghost" disabled={testing || searchTesting} onClick={() => void test()}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
              )}
              {savable && (
                <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </button>
              )}
            </div>
          </div>

          {sec.body}
          {status && <div className={`result-line ${status.ok ? 'ok' : 'bad'}`}>{status.text}</div>}

          <div className="setfoot">
            <span>长庚 demo {info?.appVersion ?? '—'}</span>
            <span>·</span>
            <span>本机优先，不外传</span>
          </div>
        </div>
        )}
      </div>
    </main>
  )
}
