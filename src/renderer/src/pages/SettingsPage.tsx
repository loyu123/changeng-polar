import { useEffect, useState, type ReactNode } from 'react'
import type {
  AlwaysAllowedEntry,
  ButlerConfig,
  DesktopPrefs,
  MailAccount,
  MemoryEntry,
  OrbPrefs,
  ProjectEntry
} from '../../../shared/types'
import type { DesktopState } from '../../../shared/desktop'
import {
  MEMORY_KIND_LABEL,
  MEMORY_MAX_TEXT,
  PROJECT_NAME_MAX,
  PROJECT_NOTE_MAX
} from '../../../shared/types'
import { deriveImapHost } from '../../../shared/mail-hosts'
import RecordsPage from './RecordsPage'
import { FieldHelp } from '../components/FieldHelp'

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
  | 'remote'
  | 'records'
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
  const [storageStats, setStorageStats] = useState<{
    dir: string
    configDir: string
    portable: boolean
    files: Array<{ file: string; bytes: number; dir: string }>
  } | null>(null)
  /** 便携模式下密钥解不开的那几个（换机器后 DPAPI 解不了密文） */
  const [secretIssues, setSecretIssues] = useState<string[]>([])
  /** 远程入口：总闸状态、配对码、忙碌标记 */
  const [remoteState, setRemoteState] = useState<{
    enabled: boolean
    address: string
    port: number
    devices: Array<{ id: string; label: string; createdAt: number; lastSeenAt: number | null }>
    pairing: { code: string; expiresAt: number; remainingMs: number } | null
    listeners: number
    lanAccess: boolean
    urls: string[]
    addresses: Array<{ ip: string; kind: 'lan' | 'tailnet' }>
    error?: string
  } | null>(null)
  /**
   * 「手机连不上」自检结果。
   *
   * null = 还没点过。**不自动跑**：一次自检要起两个 PowerShell 读防火墙和
   * Tailscale，约 1 秒；每开一次设置页就跑一遍是白花用户的时间。
   */
  const [remoteDiag, setRemoteDiag] = useState<Array<{
    level: 'ok' | 'warn' | 'fail' | 'unknown'
    title: string
    detail: string
    action?: string
    command?: string
  }> | null>(null)
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  /** 局域网测试模式：开启后监听 0.0.0.0，手机同一 WiFi 才能访问 */
  const [lanAccess, setLanAccess] = useState(false)
  /** 模拟键鼠白名单的输入草稿（保存才写配置，避免打一个字就落盘） */
  const [inputAllowDraft, setInputAllowDraft] = useState('')
  const [importing, setImporting] = useState(false)
  /** 操作记录条数（权限与安全里的「查看记录 N」） */
  const [recordCount, setRecordCount] = useState(0)
  /**
   * 能力概况（设置 › 插件与能力）。
   *
   * byEffect 是「权限与安全 › 技术说明」里那几个数字的来源。**不写死**：
   * 之前那段文案写着「主进程注册 10 个工具」，实际已经 23 个，还写着
   * 「写入真实文件没有任何通路」——而 write_document 正是在往真实文档目录写。
   * 讲边界的那段话写错了，比不写更糟，所以数字一律从这份清单算出来。
   */
  const [toolsStat, setToolsStat] = useState<{
    total: number
    on: number
    names: string[]
    byEffect: Record<string, number>
  }>({ total: 0, on: 0, names: [], byEffect: {} })
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
    void window.butler.config.secretIssues().then(setSecretIssues)
    void window.butler.remote.state().then((s) => {
      setRemoteState(s)
      // 界面上的开关要跟着实际监听模式走，不能自己猜
      setLanAccess(s.lanAccess === true)
    })
    // 白名单草稿要从配置回填：不回填的话用户以为列表空了，其实是没加载
    void window.butler.config.get().then((c) => {
      setInputAllowDraft((c.remote?.inputAllow ?? []).join(', '))
    })
    void window.butler.records.list(500).then((list) => setRecordCount(list.length))
    void window.butler.tools.list().then((list) =>
      setToolsStat({
        total: list.length,
        on: list.filter((t) => t.enabled).length,
        names: list.filter((t) => t.enabled).map((t) => t.label),
        byEffect: list.reduce<Record<string, number>>((acc, t) => {
          acc[t.effect] = (acc[t.effect] ?? 0) + 1
          return acc
        }, {})
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
  /** 手动加一条记忆：输入框内容、提交中、以及加不进去时的原因 */
  const [newMemory, setNewMemory] = useState('')
  const [addingMemory, setAddingMemory] = useState(false)
  const [memoryError, setMemoryError] = useState('')
  /**
   * 项目档案：名字 + 根目录 + 日志位置 + 说明。
   *
   * 和上面的「记住的事」不是一回事：记忆是一句话线索，这里是模型要真的去读的坐标。
   * probes 是"这些路径现在还在不在"——分开存是因为它每次刷新都会变（插拔移动硬盘），
   * 而档案本身只在用户编辑时变。
   */
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [projectProbes, setProjectProbes] = useState<
    Record<string, { rootExists: boolean; logExists: boolean | null }>
  >({})
  const [projectDraft, setProjectDraft] = useState<{ name: string; root: string; logPath: string; note: string }>({
    name: '',
    root: '',
    logPath: '',
    note: ''
  })
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState('')
  /** 填表时点「查一下」的即时结果；null = 还没查过 */
  const [draftProbe, setDraftProbe] = useState<{ rootExists: boolean; logExists: boolean | null } | null>(null)

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
    void loadProjects()
  }, [])

  const loadProjects = async (): Promise<void> => {
    const result = await window.butler.projects.list()
    setProjects(result.list)
    setProjectProbes(Object.fromEntries(result.probes.map((p) => [p.id, p])))
  }

  /**
   * 保存一条档案。
   *
   * 不做"保存前必须路径存在"的拦截：项目可能在没插的移动硬盘上，用户想先登记下来。
   * 存在与否只用来显示红绿标记，不用来阻止保存——阻止了他会以为程序坏了。
   */
  const saveProject = async (): Promise<void> => {
    if (projectBusy) return
    setProjectBusy(true)
    setProjectError('')
    try {
      const result = await window.butler.projects.save({
        name: projectDraft.name,
        root: projectDraft.root,
        logPath: projectDraft.logPath || undefined,
        note: projectDraft.note || undefined
      })
      setProjects(result.list)
      setProjectProbes(Object.fromEntries(result.probes.map((p) => [p.id, p])))
      if (result.ok) {
        setProjectDraft({ name: '', root: '', logPath: '', note: '' })
        setDraftProbe(null)
      } else {
        setProjectError(result.reason ?? '没保存成功')
      }
    } catch (err) {
      setProjectError(`没写成：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setProjectBusy(false)
    }
  }

  const deleteProject = async (id: string): Promise<void> => {
    const result = await window.butler.projects.delete(id)
    setProjects(result.list)
    setProjectProbes(Object.fromEntries(result.probes.map((p) => [p.id, p])))
  }

  const deleteMemory = async (id: string): Promise<void> => {
    setMemories(await window.butler.memory.delete(id))
  }
  const clearMemory = async (): Promise<void> => {
    if (!window.confirm('清除全部记忆？这不会删除对话记录，只是让长庚忘掉这些事。')) return
    setMemories(await window.butler.memory.clear())
  }
  /**
   * 自己加一条记忆。
   *
   * 这里不走授权卡，和对话里 `save_memory` 不一样——那张卡是给"模型想记什么"用的，
   * 而这一条是你自己打的字，你已经在看着它落进去了。判据（长度上限、去重）
   * 仍然走同一个 mergeMemory，不在这里另写一份。
   */
  const addMemory = async (): Promise<void> => {
    if (!newMemory.trim() || addingMemory) return
    setAddingMemory(true)
    try {
      const result = await window.butler.memory.save({ text: newMemory })
      setMemories(result.list)
      if (result.ok) setNewMemory('')
      else setMemoryError(result.reason)
    } catch (err) {
      setMemoryError(`没写成：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAddingMemory(false)
    }
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
          }${result.note ? ` · ${result.note}` : ''}`
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
      <div className="ch">
        邮箱账号（只读接入）
        <FieldHelp label="邮箱怎么填">
          只需填地址和授权码：常见邮箱按地址识别服务器，企业邮箱会自动探测
          （腾讯 / 网易 / 阿里企业邮都试一遍，连不上再展开「高级」手填）。
          <br />
          排在第一的是默认账号；对话里说「看 XX 邮箱」按地址匹配。
          <br />
          <b>QQ 邮箱</b>：网页版「设置 → 账户 → POP3/IMAP/SMTP 服务」开启并生成授权码。
          <br />
          只读接入：不标记已读、不删信、不发信。
        </FieldHelp>
      </div>
      <div className="form" style={{ padding: '12px 15px 14px' }}>
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
                    placeholder="you@example.com"
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
              {/* 这行是**实时结论**不是说明：填了地址马上告诉你连哪台服务器。
                  所以留在界面上，但压成一句。 */}
              <div className="hint">
                {acc.host?.trim() && derivedHost && acc.host.trim().toLowerCase() !== derivedHost.toLowerCase()
                  ? `手动指定：${acc.host.trim()}`
                  : derivedHost
                    ? `自动探测：优先 ${derivedHost}（连不上再试腾讯/网易/阿里企业邮）`
                    : '填好地址后自动推导服务器'}
              </div>
              {advanced && (
                <div className="grid2" style={{ marginTop: 6 }}>
                  <div className="form-row">
                    <label>
                      IMAP 服务器（高级）
                      <FieldHelp label="IMAP 服务器怎么填">
                        留空 = 自动探测（含腾讯 / 网易 / 阿里企业邮）；填了就强制用这个服务器。
                      </FieldHelp>
                    </label>
                    <input
                      className="input"
                      value={acc.host}
                      placeholder={derivedHost || 'imap.qq.com'}
                      onChange={(e) => updateAccount(acc.id, { host: e.target.value })}
                    />
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
      lead: storageStats?.portable
        ? '模型与 Key 都存在便携配置里（跟着程序走的 config.json）；Key 不进日志、不进对话历史。'
        : '模型与 Key 都只存在本机 config.json；Key 不进日志、不进对话历史。',
      body: (
        <div className="cardbox">
          {secretIssues.some((n) => n.includes('模型')) && (
            <div className="form" style={{ padding: '12px 15px 0' }}>
              <div className="hint" style={{ color: '#B4552D', lineHeight: 1.7 }}>
                这份配置是从另一台电脑（或另一个 Windows 账户）带过来的，其中的 API Key 在本机解不开，
                输入框里现在是空的。重新填一次并保存即可，其它配置不受影响。
              </div>
            </div>
          )}
          <div className="ch">模型</div>
          <div className="form" style={{ padding: '12px 15px 14px' }}>
            <div className="form-row">
              <label>
                模型地址（OpenAI 兼容）
                <FieldHelp label="模型地址填法">
                  填 <code>/v1</code> 或完整的 <code>/v1/chat/completions</code> 都可以。
                  本机 Ollama 可填 <code>http://127.0.0.1:11434/v1</code>。
                </FieldHelp>
              </label>
              <input
                className="input"
                value={config.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
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

            <div className="form-row" style={{ marginTop: 18 }}>
              <label>
                判分模型（评测用，可选）
                <FieldHelp label="为什么要单独的判分模型">
                  评测脚本用它给回答打分。<b>必须与上面的模型不同</b>——同一个模型给自己打分，
                  高分只能说明它自我感觉良好。
                  <br />
                  没配时，需要模型判分的用例会退化成正则断言，报告里会标明。
                </FieldHelp>
              </label>
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

            <div className="form-row" style={{ marginTop: 18 }}>
              <label>
                工作体（派活给谁）
                <FieldHelp label="各后端的差异">
                  能不能用，取决于装没装、登没登录：
                  <dl style={{ marginTop: 6 }}>
                    <dt>pi</dt>
                    <dd>
                      常驻 RPC，走局域网网关，不花钱。<b>必须填 provider 和 model</b>。
                    </dd>
                    <dt>codex</dt>
                    <dd>OpenAI 的命令行入口（ChatGPT 桌面版没有 CLI）。沙箱只到 workspace-write。</dd>
                    <dt>codebuddy</dt>
                    <dd>
                      WorkBuddy 内置 CLI，<b>要先在那个 CLI 里登录一次</b>。
                    </dd>
                    <dt>claude</dt>
                    <dd>
                      Claude Code，<b>按订阅计费</b>（一次极短问答约 $0.07），默认不选。
                    </dd>
                  </dl>
                </FieldHelp>
              </label>
              <div className="grid2">
                <div>
                  <select
                    className="input"
                    aria-label="工作体后端"
                    value={config.worker?.backend ?? 'pi'}
                    onChange={(e) =>
                      update({
                        worker: {
                          ...config.worker,
                          backend: e.target.value as NonNullable<ButlerConfig['worker']>['backend']
                        }
                      })
                    }
                  >
                    <option value="pi">pi（默认，免费）</option>
                    <option value="codex">codex</option>
                    <option value="codebuddy">codebuddy（需登录）</option>
                    <option value="claude">claude（按订阅计费）</option>
                  </select>
                </div>
                <div>
                  <input
                    className="input"
                    aria-label="工作体模型"
                    placeholder={
                      (config.worker?.backend ?? 'pi') === 'pi'
                        ? '模型，如 deepseek-v4-flash'
                        : '模型（留空用该后端默认）'
                    }
                    value={config.worker?.model ?? ''}
                    onChange={(e) => update({ worker: { ...config.worker, model: e.target.value } })}
                  />
                </div>
              </div>
              {(config.worker?.backend ?? 'pi') === 'pi' && (
                <input
                  className="input"
                  aria-label="工作体 provider"
                  placeholder="provider（pi 必填）：eepseek，注意少一个 d"
                  style={{ marginTop: 8 }}
                  value={config.worker?.provider ?? ''}
                  onChange={(e) => update({ worker: { ...config.worker, provider: e.target.value } })}
                />
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
              <label>
                来源
                <FieldHelp label="各来源的差别">
                  带 Key 的来源失败时会<b>自动回落到免费源</b>。
                  <br />
                  选「关闭联网」后，长庚对任何外部问题都必须回答“查不到”——
                  这是 H2 的自检方式。
                </FieldHelp>
              </label>
              <select
                className="input"
                value={config.searchProvider}
                onChange={(e) => update({ searchProvider: e.target.value as ButlerConfig['searchProvider'] })}
              >
                <option value="serper">Serper（Google 结果，需 Key，中文最准）</option>
                <option value="tavily">Tavily（需 Key，正文摘要较全）</option>
                <option value="bingapi">Bing 官方 API v7（需 Azure Key）</option>
                <option value="bing">Bing 网页抓取（免费，国内可用，默认）</option>
                <option value="duckduckgo">DuckDuckGo（免费，国内常被人机验证拦下）</option>
                <option value="none">关闭联网（用来验证“查不到”降级）</option>
              </select>
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
                <FieldHelp label="只读模式">
                打开后，安装、卸载、删除、写文件、写记忆这类会改动机器的工具<b>不会出现在工具清单里</b>——
                  模型连申请的机会都没有，定时任务也一样。关掉即恢复，仍然逐次弹授权卡。
                </FieldHelp>
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
                <span>
                  执行任意命令、写任意路径。这一版没有这条通路——写只能进产出目录，删只能在沙箱。
                </span>
              </div>
              <span className="sw fixed" title="未实现：没有执行任意命令、写任意路径的工具">
                <i />
              </span>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">写操作</div>
            <div className="row">
              <div className="rl">
                <b>写操作逐次确认</b>
                <FieldHelp label="写操作逐次确认">
                {readOnly
                    ? '当前是只读模式：所有会改动机器的工具都没有注册，不存在「确认后执行」这一步。'
                    : '装软件、卸载、删沙箱文件之前，都要先弹授权卡。'}
                </FieldHelp>
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
                <b>装软件时弹出它自己的安装界面</b>
                <FieldHelp label="装软件时弹出它自己的安装界面">
                装软件一律走软件自己的安装向导：<b>安装位置、桌面快捷方式、开机自启都在那里由你选</b>，
                  长庚不替你勾，也不做静默安装——那样等于替你接受了所有默认选项。<br />
                  这一轮对话会等你在向导里点完；点「取消」就等于什么都没装。
                </FieldHelp>
              </div>
              <span className="sw on fixed" title="固定行为：始终拉起软件自己的安装器，不做静默安装">
                <i />
              </span>
            </div>
            <div className="row">
              <div className="rl">
                <b>可写范围</b>
                <FieldHelp label="可写范围到底有多大">
                  两条，都不由模型定：<br />
                  · <b>删</b>：只有演示沙箱（<code>%TEMP%\butler-sandbox</code>）里的文件，走回收站可还原<br />
                  · <b>写</b>：只有 <code>write_document</code> 往桌面上的「长庚产出」新建文件——落点写死在代码里，
                  同名不覆盖，也<b>不能改或删已有文件</b>
                </FieldHelp>
              </div>
              <span className="cval">{readOnly ? '无（只读模式）' : '沙箱删除 + 产出目录新建'}</span>
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
              {toolsStat.total > 0 ? (
                <li>
                  主进程按效果分档注册 {toolsStat.total} 个工具：只读 {toolsStat.byEffect.read ?? 0}、纯界面{' '}
                  {toolsStat.byEffect.ui ?? 0}、写 {toolsStat.byEffect.write ?? 0}、安装{' '}
                  {toolsStat.byEffect.install ?? 0}、销毁 {toolsStat.byEffect.destroy ?? 0}。
                  数字取自当前注册的清单，不写死。
                </li>
              ) : (
                <li>正在读取工具清单…</li>
              )}
              <li>
                只读 / 纯界面自动放行并留痕；写类里声明了备份的先备份再执行，备份失败就不执行；安装与销毁每次都弹卡，
                「始终允许」只对安装开放。
              </li>
              <li>
                <b>能写进真实文件夹的只有一条路</b>：<code>write_document</code> 只能落在<b>桌面上的「长庚产出」</b>，
                落点由代码写死、模型指定不了；只写文本类后缀，同名文件不覆盖（换个名字）。
                能读的是你在对话里点名的任意路径文件（只读）；执行任意命令、写任意路径仍然没有通路。
              </li>
              <li>删除只作用于演示沙箱 <code>%TEMP%\butler-sandbox</code>，走系统回收站可还原；沙箱之外的删除没有任何通路。</li>
              <li>卸载只启动程序自己的卸载程序，不静默、不删安装目录</li>
              <li>邮箱以 IMAP 只读打开：不标记已读、不删信、不发信</li>
              <li>渲染层只能通过白名单通道调用，无 node 能力</li>
            </ul>
          </details>
          <div className="cardbox">
            <div className="ch">
              记忆（跨会话）
                <FieldHelp label="记忆是什么">
                长庚记下的、下次对话还能想起来的事（偏好、正在做的项目、约定的规则）。
                <br />
                它会出现在每次对话的系统提示里，但<b>只是线索</b>——涉及本机事实仍然要现查。
                <br />
                对话里让长庚记，写入会弹授权卡（它改的是“长庚以后怎么看你”）。
                在下面自己写一条则不用弹卡——字是你打的，你正看着它落进去。
                </FieldHelp>
            </div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              {memories.length === 0 ? (
                <div style={{ color: '#8E8E86', fontSize: 12 }}>还没有记下任何东西。对话里说「记住…」，或者在下面自己写一条。</div>
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
              {/* 自己写一条：和对话里「记住…」写进同一份 memory.json，去重与长度上限也是同一套 */}
              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={newMemory}
                  maxLength={MEMORY_MAX_TEXT}
                  placeholder="自己写一条，一句话就够"
                  onChange={(e) => {
                    setNewMemory(e.target.value)
                    if (memoryError) setMemoryError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addMemory()
                  }}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={!newMemory.trim() || addingMemory}
                  onClick={() => void addMemory()}
                >
                  {addingMemory ? '记…' : '记住'}
                </button>
              </div>
              {memoryError && (
                <div style={{ fontSize: 11, color: '#C42B1C', marginTop: 6 }}>{memoryError}</div>
              )}
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">
              项目档案
              <FieldHelp label="项目档案是干什么的">
                长庚不会自己去硬盘里猜你的项目在哪——猜错了会去读一个不相干的目录，而你看不出它为什么读那里。
                这里是你亲手填的坐标：填完之后你说「报告进展到哪了」，它就知道该去哪个目录、
                该读哪个日志，不用你每次从头讲一遍。
                <br />
                只接受本机绝对路径（像 <code>D:\工作\我的项目</code>）；网络共享路径不收——连共享目录会向对方提交本机登录凭据。
                <br />
                路径现在在不在只用来显示红绿标记，<b>不会阻止保存</b>：项目可能在没插的移动硬盘上，你想先登记下来是合理的。
              </FieldHelp>
            </div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              {projects.length === 0 ? (
                <div style={{ color: '#8E8E86', fontSize: 12 }}>
                  还没有登记任何项目。下面填一个，之后「报告进展到哪了」这类问题才有地方可去。
                </div>
              ) : (
                projects.map((p) => {
                  const probe = projectProbes[p.id]
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '10px 0',
                        borderTop: '1px solid #F1F1ED'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                        <div style={{ fontSize: 12, color: '#5A5A54', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>
                          {p.root}
                          {probe && !probe.rootExists && (
                            <span style={{ color: '#C42B1C', marginLeft: 6 }}>（现在找不到这个目录）</span>
                          )}
                        </div>
                        {p.logPath && (
                          <div style={{ fontSize: 12, color: '#5A5A54', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>
                            日志：{p.logPath}
                            {probe && probe.logExists === false && (
                              <span style={{ color: '#C42B1C', marginLeft: 6 }}>（现在找不到）</span>
                            )}
                          </div>
                        )}
                        {p.note && (
                          <div style={{ fontSize: 12, color: '#5A5A54', marginTop: 4, whiteSpace: 'pre-wrap' }}>{p.note}</div>
                        )}
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => void deleteProject(p.id)}>
                        删除
                      </button>
                    </div>
                  )
                })
              )}

              {/* 新增：四个字段一次填完。改已有的那条也是在这里重填（根目录相同即覆盖） */}
              <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
                <input
                  className="input"
                  value={projectDraft.name}
                  maxLength={PROJECT_NAME_MAX}
                  placeholder="项目名（之后就用这个名字叫它），例如：开题报告"
                  onChange={(e) => setProjectDraft({ ...projectDraft, name: e.target.value })}
                />
                <input
                  className="input"
                  value={projectDraft.root}
                  placeholder="根目录，例如 D:\工作\我的项目"
                  onChange={(e) => {
                    setProjectDraft({ ...projectDraft, root: e.target.value })
                    setDraftProbe(null)
                  }}
                />
                <input
                  className="input"
                  value={projectDraft.logPath}
                  placeholder="进度日志的位置（可选）——可以是文件，也可以是目录"
                  onChange={(e) => {
                    setProjectDraft({ ...projectDraft, logPath: e.target.value })
                    setDraftProbe(null)
                  }}
                />
                <input
                  className="input"
                  value={projectDraft.note}
                  maxLength={PROJECT_NOTE_MAX}
                  placeholder="这个项目在做什么、还差什么（可选）"
                  onChange={(e) => setProjectDraft({ ...projectDraft, note: e.target.value })}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={projectBusy || !projectDraft.name.trim() || !projectDraft.root.trim()}
                    onClick={() => void saveProject()}
                  >
                    {projectBusy ? '保存中…' : '保存'}
                  </button>
                  {/* 用户可能刚插上移动硬盘、刚改完目录名——需要一个"现在再查一下" */}
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!projectDraft.root.trim()}
                    onClick={async () => {
                      setDraftProbe(
                        await window.butler.projects.probe({
                          root: projectDraft.root,
                          logPath: projectDraft.logPath || undefined
                        })
                      )
                    }}
                  >
                    查一下路径
                  </button>
                  {draftProbe && (
                    <span style={{ fontSize: 11, color: draftProbe.rootExists ? '#3F7A52' : '#C42B1C' }}>
                      根目录{draftProbe.rootExists ? '在' : '找不到'}
                      {draftProbe.logExists === null ? '' : draftProbe.logExists ? '，日志在' : '，日志找不到'}
                    </span>
                  )}
                </div>
                {projectError && <div style={{ fontSize: 11, color: '#C42B1C' }}>{projectError}</div>}
              </div>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">
              授权记忆（「始终允许」）
              <FieldHelp label="什么会留在这里">
                只有明确点过「始终允许」的工具才会留在这里（当前仅<b>安装</b>，按包名 + 版本记忆）。
                <br />
                撤销立即生效。记忆、委派、上传这类工具永远不进这里——它们每次都要你确认。
                </FieldHelp>
            </div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
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
                <FieldHelp label="关闭窗口时收进托盘">
                关窗只是把窗口收起，进程继续跑，定时任务照常执行。从托盘图标点回来，或右键「退出长庚」才真正结束。
                  关掉这一项，关窗就退出，定时任务也会一起停。
                </FieldHelp>
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
                <FieldHelp label="定时任务完成时通知">
                任务跑完或失败时弹一条系统通知，点它能回到窗口。对话里的回答不弹——那时你就在窗口前。
                </FieldHelp>
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
                <FieldHelp label="待命动效">
                关掉后球保持静止。呼吸只动缩放与透明度，走合成层，不触发重绘；思考与等确认时的动画不受这项影响。
                </FieldHelp>
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
                <FieldHelp label="呼出快捷键">
                {orb && !orb.hotkeyOk
                    ? '当前没能注册上——多半被别的程序占用了，换一个组合试试。'
                    : '任何时候把对话面板叫到前台。留空 = 不注册全局快捷键。'}
                </FieldHelp>
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
                <FieldHelp label="桌面会话">
                与主窗口分开存（orb-sessions.json），保留最近 20 条。面板里删掉的不影响主窗口；
                  想长期留着，用面板标题栏的「移到主窗口」搬过去。
                </FieldHelp>
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
      lead: storageStats?.portable
        ? '便携版：config.json 跟着程序走（存在 U 盘上），会话、记录、记忆仍留在本机。'
        : '所有数据都在本机。对话会话存在渲染层的浏览器存储里，其余是 userData 下的 JSON / 日志文件。',
      body: (
        <>
          {storageStats?.portable && (
            <div className="cardbox">
              <div className="ch">便携模式</div>
              <div className="form" style={{ padding: '12px 15px 14px' }}>
                <div className="hint" style={{ marginBottom: 8 }}>
                  配置跟着程序走：<code style={{ wordBreak: 'break-all' }}>{storageStats.configDir}</code>
                </div>
                <div className="hint" style={{ marginBottom: 10, color: '#8E8E86' }}>
                  密钥仍用 Windows 系统加密（绑当前用户）。换一台电脑打开时密钥解不开，需要在「模型」里重新填一次——
                  其余配置会照常带过去。
                </div>
                <div className="hint" style={{ marginBottom: 10, color: '#8E8E86' }}>
                  同一台电脑上如果已经开着装好的长庚，便携版不会再启动一份（两个进程写同一份会话与记录会互相覆盖）——
                  它只会把已有的窗口叫到前面来。
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => void window.butler.shell.openPath(storageStats.configDir)}
                  >
                    打开配置目录
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={importing}
                    onClick={async () => {
                      if (importing) return
                      setImporting(true)
                      try {
                        let r = await window.butler.config.importLocal(false)
                        if (r.needConfirm) {
                          if (!window.confirm('便携配置已经存在，用本机 %APPDATA% 的那份覆盖它？')) return
                          r = await window.butler.config.importLocal(true)
                        }
                        window.alert(r.detail)
                        if (r.ok) {
                          setConfig(await window.butler.config.get())
                          setSecretIssues(await window.butler.config.secretIssues())
                        }
                      } finally {
                        setImporting(false)
                      }
                    }}
                  >
                    {importing ? '导入中…' : '从本机导入配置'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {secretIssues.length > 0 && (
            <div className="cardbox">
              <div className="ch">密钥在本机解不开</div>
              <div className="form" style={{ padding: '12px 15px 14px' }}>
                <div className="hint" style={{ lineHeight: 1.7 }}>
                  这几个密钥是用另一台电脑（或另一个 Windows 账户）的系统加密存进去的，本机解不开，
                  所以现在等同于没填：<b>{secretIssues.join('、')}</b>。
                  <br />
                  在对应分区重新填一次即可，不需要重新配置其它项。
                </div>
              </div>
            </div>
          )}
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
                      {/* 便携模式下 config.json 不在数据目录里，标出来免得对不上 */}
                      {storageStats && f.dir !== storageStats.dir && (
                        <span style={{ fontSize: 11, color: '#8E8E86' }}>在便携目录</span>
                      )}
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
    // 远程访问：手机 App 的总闸、配对、设备白名单
    // 2026-11-13 归档：这条线不做了，整块留在这里只为留档。见 docs/zh/remote.md 顶部横幅
    remote: {
      title: '远程访问',
      lead: '手机 App 通过这台电脑上的一个本地端口连进来；默认关闭，关掉时端口一起释放。',
      body: (
        <>
          {/*
            归档说明必须放在这一块最上面，而且不能只写在文档里：
            文档读者是"翻代码的人"，而这段文案的读者是"真的会点这个开关的人"。
            开关还留着（代码没删、自检还能跑），所以更要说清楚别开。
          */}
          <div
            style={{
              border: '1px solid var(--line)',
              borderLeft: '3px solid #B4552D',
              borderRadius: 9,
              background: '#FBFAF7',
              padding: '11px 14px',
              marginBottom: 14
            }}
          >
            <b style={{ color: '#B4552D' }}>这一块已归档（2026-11-13），不要再开</b>
            <div className="hint" style={{ marginTop: 5, lineHeight: 1.75 }}>
              远程接入这条线不做了。作废的包括这里的局域网模式与
              Tailscale 转发、后来试过又放弃的 QQ 桥接，以及微信界面的文字读取。开关和自检代码都还在、也能跑，
              但不再维护——留着只为记下当时怎么做的。长庚现在只做四件事：读项目、看目录、汇报进展、写材料。
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">总闸</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="setrow" style={{ paddingLeft: 0 }}>
                <div className="rl">
                  <b>允许远程连接</b>
                  <span>
                    默认只监听 <code>127.0.0.1</code>——长庚自己永远不直接面对公网。
                    手机要连进来，要么开下面的局域网模式，要么用 Tailscale 转发。
                  </span>
                </div>
                <button
                  className={`btn ${remoteState?.enabled ? 'btn-ghost' : 'btn-primary'}`}
                  disabled={remoteBusy}
                  onClick={async () => {
                    setRemoteBusy(true)
                    try {
                      // 关闭时一并清掉局域网模式；开启时沿用当前选择
                      setRemoteState(
                        await window.butler.remote.enable(!remoteState?.enabled, lanAccess)
                      )
                    } finally {
                      setRemoteBusy(false)
                    }
                  }}
                >
                  {remoteState?.enabled ? '关闭远程入口' : '开启远程入口'}
                </button>
              </div>
              {remoteState?.error && (
                <div className="hint" style={{ color: '#B4552D', marginTop: 8 }}>启动失败：{remoteState.error}</div>
              )}
              {remoteState?.enabled && (
                <div className="hint" style={{ marginTop: 8 }}>
                  正在监听 <code>{remoteState.address}</code>；当前有 {remoteState.listeners} 个事件流连接。
                  {(remoteState.urls ?? []).length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      手机打开：
                      {(remoteState.urls ?? []).map((u) => {
                        // 100.64/10 是 Tailscale 的网段。标出来是因为这两类地址
                        // 的"什么时候能用"完全不同：局域网的要同一个 WiFi，
                        // Tailscale 的在任何有网的地方都行——混在一起看不出区别
                        const ip = u.replace(/^https?:\/\//, '').replace(/[:/].*$/, '')
                        const isTailnet = (remoteState.addresses ?? []).some((a) => a.ip === ip && a.kind === 'tailnet')
                        return (
                          <div key={u}>
                            <code style={{ wordBreak: 'break-all' }}>{u}</code>
                            {isTailnet && (
                              <span className="sub" style={{ marginLeft: 6 }}>
                                Tailscale（外面也能连）
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">连不上？点这里自检</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10, lineHeight: 1.7 }}>
                手机打不开、或者配对时一直失败，原因分散在四处（总闸、绑定地址、网络、
                防火墙），界面上原来一个都不显示。自检把这些逐条查一遍：
                <b>能确定的说确定，查不到的直说查不到</b>——防火墙有没有放行本程序这条，
                Windows 不让非管理员读，所以会显示「无法确认」并给出放行命令。
              </div>
              <div className="row" style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-ghost"
                  disabled={remoteBusy}
                  onClick={async () => {
                    setRemoteBusy(true)
                    try {
                      setRemoteDiag(await window.butler.remote.diagnose())
                      setRemoteState(await window.butler.remote.state())
                    } finally {
                      setRemoteBusy(false)
                    }
                  }}
                >
                  {remoteDiag ? '重新自检' : '开始自检'}
                </button>
              </div>
              {remoteDiag && (
                <div style={{ marginTop: 12 }}>
                  {remoteDiag.map((item) => (
                    <div key={item.title} style={{ marginBottom: 10, lineHeight: 1.65 }}>
                      <b
                        style={{
                          color:
                            item.level === 'fail'
                              ? '#B4552D'
                              : item.level === 'warn'
                                ? '#8A6A1F'
                                : item.level === 'unknown'
                                  ? '#6B6B63'
                                  : '#3F7A52'
                        }}
                      >
                        {item.level === 'fail'
                          ? '✕ '
                          : item.level === 'warn'
                            ? '! '
                            : item.level === 'unknown'
                              ? '? '
                              : '✓ '}
                        {item.title}
                      </b>
                      <div className="hint" style={{ marginTop: 2 }}>{item.detail}</div>
                      {item.action && (
                        <div className="hint" style={{ marginTop: 2 }}>
                          → {item.action}
                          {item.command && (
                            <code style={{ display: 'block', marginTop: 4, wordBreak: 'break-all' }}>
                              {item.command}
                            </code>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">局域网测试</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10, lineHeight: 1.7 }}>
                出门在外也要连，用 <b>Tailscale</b>（手机装一个 App、登录同一账号就行，
                不需要公网 IP、不用备案、不用开任何端口）。装了之后这里会多出一行
                100.x 开头的地址，手机用它就能连——但远程入口仍然要开着。
                <br />
                frp 隧道是另一条路，代价是要有一台公网 VPS。
                <br />
                <b style={{ color: '#B4552D' }}>
                  打开局域网模式后，同一网络里的任何设备都能连到这个端口
                </b>
                （仍然需要配对码换 token 才能用）。只是家里用的话一直开着也无妨。
              </div>
              <div className="setrow" style={{ paddingLeft: 0 }}>
                <div className="rl">
                  <b>监听所有网卡（0.0.0.0）</b>
                  <span>{remoteState?.lanAccess ? '已开启——同一 WiFi 的设备可以访问' : '未开启（只监听本机回环）'}</span>
                </div>
                <button
                  className="btn btn-ghost"
                  disabled={remoteBusy}
                  onClick={async () => {
                    setRemoteBusy(true)
                    try {
                      const next = !lanAccess
                      setLanAccess(next)
                      // 服务已经在跑：要用新模式重启一次才生效
                      if (remoteState?.enabled) {
                        setRemoteState(await window.butler.remote.enable(true, next))
                      }
                    } finally {
                      setRemoteBusy(false)
                    }
                  }}
                >
                  {lanAccess ? '改回只监听本机' : '开启局域网访问'}
                </button>
              </div>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">模拟键盘鼠标（需授权）</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10, lineHeight: 1.7 }}>
                让长庚能点按钮、输入文字。**每次使用前都要你在手机或桌面上批准**，
                一次批准管 60 秒 / 最多 10 个动作；授权卡上会带当前屏幕的截图，
                并算出点击位置会落到哪个窗口。
                <br />
                <b>下面这几个程序之外的地方，代码层直接拒绝</b>
                ——不靠模型自觉。留空 = 一个都不允许。
              </div>
              <div className="setrow" style={{ paddingLeft: 0, alignItems: 'flex-start' }}>
                <div className="rl" style={{ flex: 1 }}>
                  <b>允许操作的程序（进程名）</b>
                  <span>不带 .exe，逗号分隔。例如：chrome, notepad, Code</span>
                </div>
              </div>
              <div className="row" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={inputAllowDraft}
                  placeholder="chrome, notepad"
                  onChange={(e) => setInputAllowDraft(e.target.value)}
                />
                <button
                  className="btn btn-ghost"
                  disabled={remoteBusy}
                  onClick={async () => {
                    setRemoteBusy(true)
                    try {
                      const list = inputAllowDraft
                        .split(/[,，\s]+/)
                        .map((x) => x.trim().replace(/\.exe$/i, ''))
                        .filter(Boolean)
                      await window.butler.config.save({ remote: { ...(config?.remote ?? { enabled: false }), inputAllow: list } })
                      setConfig(await window.butler.config.get())
                      setStatus({ ok: true, text: `已保存允许名单：${list.length ? list.join('、') : '（空，等于一个都不允许）'}` })
                    } finally {
                      setRemoteBusy(false)
                    }
                  }}
                >
                  保存
                </button>
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                判断用的是<b>进程名</b>而不是窗口标题：标题可以被网页改写
                （恶意页面能把自己叫成「微信」），进程名是操作系统给的、改不了。
              </div>
            </div>
          </div>
          <div className="cardbox">
            <div className="ch">配对新手机</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              <div className="hint" style={{ marginBottom: 10, lineHeight: 1.7 }}>
                配对码 2 分钟内有效、用一次即作废，试错 5 次会自动作废。手机 App 输入它换一个长期 token，
                之后不用再输。
              </div>
              {pairCode ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 30, letterSpacing: 6, fontVariantNumeric: 'tabular-nums' }}>
                    {pairCode.code}
                  </div>
                  <div className="hint">还剩约 {Math.max(0, Math.round((pairCode.expiresAt - Date.now()) / 1000))} 秒</div>
                </div>
              ) : null}
              <button
                className="btn btn-ghost"
                disabled={remoteBusy}
                onClick={async () => {
                  setRemoteBusy(true)
                  try {
                    const r = await window.butler.remote.issuePairingCode()
                    if (r.ok && r.code && r.expiresAt) setPairCode({ code: r.code, expiresAt: r.expiresAt })
                    else setPairCode(null)
                    setRemoteState(await window.butler.remote.state())
                  } finally {
                    setRemoteBusy(false)
                  }
                }}
              >
                {pairCode ? '重新生成配对码' : '生成配对码'}
              </button>
            </div>
          </div>

          <div className="cardbox">
            <div className="ch">已配对设备</div>
            <div className="form" style={{ padding: '12px 15px 14px' }}>
              {(remoteState?.devices ?? []).length === 0 ? (
                <div style={{ fontSize: 12, color: '#8E8E86' }}>还没有设备配对。</div>
              ) : (
                (remoteState?.devices ?? []).map((d) => (
                  <div className="setrow" key={d.id} style={{ paddingLeft: 0 }}>
                    <div className="rl">
                      <b>{d.label}</b>
                      <span>
                        配对于 {new Date(d.createdAt).toLocaleString('zh-CN')}
                        {d.lastSeenAt ? ` · 上次连接 ${new Date(d.lastSeenAt).toLocaleString('zh-CN')}` : ' · 还没连过'}
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        await window.butler.remote.revoke(d.id)
                        setRemoteState(await window.butler.remote.state())
                      }}
                    >
                      踢掉
                    </button>
                  </div>
                ))
              )}
              {(remoteState?.devices ?? []).length > 0 && (
                <button
                  className="btn btn-ghost"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    if (!window.confirm('踢掉全部已配对设备？它们需要重新配对才能再用。')) return
                    await window.butler.remote.revokeAll()
                    setRemoteState(await window.butler.remote.state())
                  }}
                >
                  全部踢掉
                </button>
              )}
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
        {('远程访问'.includes(navQuery.trim()) || navQuery.trim() === '') && (
          <button className={`sitem${section === 'remote' ? ' sel' : ''}`} onClick={() => setSection('remote')}>
            远程访问
            <span className="kbd" title="该方向已归档（2026-11-13），代码留着但不再维护">
              历史
            </span>
          </button>
        )}
        {navQuery.trim() === '' && <div className="sgrp">本机</div>}
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
