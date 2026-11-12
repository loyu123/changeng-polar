import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AlwaysAllowedEntry,
  AuthAnswer,
  ButlerConfig,
  ChatEvent,
  ChatMessage,
  ChatSession,
  DesktopPrefs,
  InstallJobView,
  MemoryEntry,
  OrbPrefs,
  RecordEntry,
  SnapshotDiff,
  TaskDef,
  TurnResult
} from '../shared/types'
import type { OrchestrationListView } from '../shared/orchestration'
import type { DesktopState } from '../shared/desktop'

const api = {
  info: () =>
    ipcRenderer.invoke('app:info') as Promise<{
      machineName: string
      userName: string
      osVersion: string
      today: string
      appVersion: string
      userData: string
      /** 便携模式：配置跟着 exe 走时 active=true，configDir 是 U 盘上的配置目录 */
      portable: { active: boolean; configDir: string; exeDir?: string; reason?: string }
    }>,

  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<ButlerConfig>,
    save: (patch: Partial<ButlerConfig>) =>
      ipcRenderer.invoke('config:save', patch) as Promise<ButlerConfig>,
    /** 密钥是否加密落盘（决定设置页提示文案） */
    secretsEncrypted: () => ipcRenderer.invoke('config:secretsEncrypted') as Promise<boolean>,
    /** 有哪几个密钥在本机解不开（便携配置换机后会出现） */
    secretIssues: () => ipcRenderer.invoke('config:secretIssues') as Promise<string[]>,
    /** 便携模式：把本机 %APPDATA% 的配置复制过来 */
    importLocal: (overwrite: boolean) =>
      ipcRenderer.invoke('config:importLocal', overwrite) as Promise<{
        ok: boolean
        detail: string
        needConfirm?: boolean
      }>,
    test: (patch: Partial<ButlerConfig>) =>
      ipcRenderer.invoke('config:test', patch) as Promise<{
        ok: boolean
        detail: string
        latencyMs: number
      }>
  },


  /** 设置页的检索自检：只发一次检索请求，不进模型 */
  search: {
    test: (patch: Partial<ButlerConfig>) =>
      ipcRenderer.invoke('search:test', patch) as Promise<{
        ok: boolean
        provider: string
        count: number
        latencyMs: number
        error?: string
        note?: string
        sample: Array<{ title: string; url: string }>
      }>
  },

  /** 邮箱连接自检：IMAP 只读打开收件箱，不拉正文；accountId 缺省测默认账号 */
  mail: {
    test: (patch: Partial<ButlerConfig>, accountId?: string) =>
      ipcRenderer.invoke('mail:test', patch, accountId) as Promise<{ ok: boolean; detail: string; total?: number }>
  },

  records: {
    list: (limit?: number) => ipcRenderer.invoke('records:list', limit) as Promise<RecordEntry[]>
  },

  /** 全局搜索：搜会话，在主进程侧扫，只回命中的条目 */
  find: {
    all: (query: string, limit?: number) =>
      ipcRenderer.invoke('search:all', query, limit) as Promise<
        Array<{
          key: string
          kind: 'session'
          title: string
          sub: string
          sessionId?: string
          messageId?: string
        }>
      >
  },

  /** 卸载快照对比：拿当下与卸载前快照比对（没有对应快照时返回 null） */
  snapshot: {
    diff: (id: string) => ipcRenderer.invoke('snapshot:diff', id) as Promise<SnapshotDiff | null>
  },

  chat: {
    send: (requestId: string, messages: ChatMessage[]) =>
      ipcRenderer.invoke('chat:send', { requestId, messages }) as Promise<TurnResult | { error: string }>,
    abort: (requestId: string) => ipcRenderer.invoke('chat:abort', requestId) as Promise<boolean>,
    /** 授权卡作答：once=只这一次 / always=始终允许（仅当卡片允许） / deny=拒绝 */
    answer: (authId: string, answer: AuthAnswer) =>
      ipcRenderer.invoke('chat:answer', { authId, answer }) as Promise<boolean>,
    /**
     * 候选卡作答：value 必须取自卡上给出的 options。
     *
     * 选完不等于装：主进程会拿这个值重新解析一次目标，再弹正常的授权卡。
     */
    choose: (choiceId: string, value: string) =>
      ipcRenderer.invoke('chat:choose', { choiceId, value }) as Promise<boolean>,
    onEvent: (handler: (event: ChatEvent) => void) => {
      const listener = (_e: unknown, payload: ChatEvent) => handler(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },

  /** 「始终允许」的授权记忆：能看、能单条撤销、能清空 */
  auth: {
    list: () => ipcRenderer.invoke('auth:memory:list') as Promise<AlwaysAllowedEntry[]>,
    revoke: (key: string) => ipcRenderer.invoke('auth:memory:revoke', key) as Promise<AlwaysAllowedEntry[]>,
    clear: () => ipcRenderer.invoke('auth:memory:clear') as Promise<AlwaysAllowedEntry[]>
  },

  /** 跨会话记忆：用户能看、能删、能自己加一条 */
  memory: {
    list: () => ipcRenderer.invoke('memory:list') as Promise<MemoryEntry[]>,
    save: (input: { kind?: string; text: string }) =>
      ipcRenderer.invoke('memory:save', input) as Promise<
        { ok: true; list: MemoryEntry[] } | { ok: false; reason: string; list: MemoryEntry[] }
      >,
    delete: (ref: string) => ipcRenderer.invoke('memory:delete', ref) as Promise<MemoryEntry[]>,
    clear: () => ipcRenderer.invoke('memory:clear') as Promise<MemoryEntry[]>
  },

  /** 定时任务（主进程调度；到点无头跑一轮，需要授权的操作会被当场拒绝） */
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list') as Promise<TaskDef[]>,
    save: (task: Partial<TaskDef>) => ipcRenderer.invoke('tasks:save', task) as Promise<TaskDef>,
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id) as Promise<TaskDef[]>,
    /** 立即跑一次 */
    run: (id: string) =>
      ipcRenderer.invoke('tasks:run', id) as Promise<{ ok: boolean; detail: string }>,
    onChanged: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('tasks:changed', listener)
      return () => ipcRenderer.removeListener('tasks:changed', listener)
    }
  },

  /**
   * 后台安装的任务清单。
   *
   * 安装不再占住那一轮对话：工具拉起来就返回，这里列出"还在装什么"。
   * 没有"开始安装"的入口——安装只能由模型提出来、用户过授权卡之后由工具拉起，
   * 渲染层能直接装东西就等于绕开了整条授权链。
   */
  install: {
    list: () => ipcRenderer.invoke('install:list') as Promise<InstallJobView[]>,
    /** 返回 false = 它已经不在跑了（装完了，或 id 不对） */
    cancel: (id: string) => ipcRenderer.invoke('install:cancel', id) as Promise<boolean>,
    /** 清掉已经结束的那些 */
    clear: () => ipcRenderer.invoke('install:clear') as Promise<InstallJobView[]>,
    /**
     * 装完要通知，而通知来的时候那一轮对话早就结束了——
     * `chat.onEvent` 的监听器在 send() 返回时就摘了，所以这条必须常驻订阅。
     */
    onChanged: (handler: (jobs: InstallJobView[]) => void) => {
      const listener = (_e: unknown, jobs: InstallJobView[]): void => handler(jobs)
      ipcRenderer.on('install:changed', listener)
      return () => ipcRenderer.removeListener('install:changed', listener)
    }
  },

  /**
   * 编排项目（派给外部工作体跑的那些）。
   *
   * 只读：这一页回答"现在到哪了、过没过"，不提供改状态的入口。
   * 想改就回对话里重新派一次——那样每次改动都有授权卡和审计记录。
   */
  orchestration: {
    /** 列出所有项目 + 当前允许扫描的根 + 应用自己的那个根 */
    list: () => ipcRenderer.invoke('orchestration:list') as Promise<OrchestrationListView>,
    /** 弹系统目录选择框，让用户自己挑一个项目目录打开 */
    pickRoot: () =>
      ipcRenderer.invoke('orchestration:pickRoot') as Promise<
        | { ok: false; canceled: true }
        | { ok: false; canceled: false; reason: string }
        | ({ ok: true; canceled: false; root: string; projectCount: number } & OrchestrationListView)
      >,
    /** 不再扫描某个目录（磁盘上一个字节都不动） */
    removeRoot: (dir: string) =>
      ipcRenderer.invoke('orchestration:removeRoot', dir) as Promise<
        { ok: boolean; reason?: string } & OrchestrationListView
      >,
    /** 重新核对全部验收（不改状态，只把磁盘上的事实再查一遍） */
    recheck: (projectDir: string) =>
      ipcRenderer.invoke('orchestration:recheck', projectDir) as Promise<
        Array<{ taskId: string; passed: boolean; detail: string }>
      >,
    /** 在资源管理器里定位产出文件 */
    reveal: (filePath: string) => ipcRenderer.invoke('orchestration:reveal', filePath) as Promise<boolean>
  },

  /** 会话：存 userData/sessions.json，可长期回看（之前只在 localStorage 留 20 条） */
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list') as Promise<ChatSession[]>,
    save: (session: Partial<ChatSession>) => ipcRenderer.invoke('sessions:save', session) as Promise<ChatSession>,
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id) as Promise<ChatSession[]>,
    clear: () => ipcRenderer.invoke('sessions:clear') as Promise<ChatSession[]>
  },

  /** 能力开关：主进程注册的工具清单 + 各自启用状态 */
  tools: {
    list: () =>
      ipcRenderer.invoke('tools:list') as Promise<
        Array<{
          name: string
          label: string
          description: string
          effect: string
          allowAlways: boolean
          enabled: boolean
          /** true = 被只读模式挡下（不是用户自己关的） */
          blockedByReadOnly?: boolean
        }>
      >,
    /** 切换单个工具的启用状态：读现有开关合并后保存 */
    toggle: async (name: string, enabled: boolean) => {
      const config = (await ipcRenderer.invoke('config:get')) as ButlerConfig
      const toolToggles = { ...(config.toolToggles ?? {}), [name]: enabled }
      return ipcRenderer.invoke('config:save', { toolToggles }) as Promise<ButlerConfig>
    }
  },

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize') as Promise<boolean>,
    close: () => ipcRenderer.invoke('win:close')
  },

  /**
   * 桌面常驻：关窗行为、开机自启、任务通知。
   * 偏好落在 config.json，`state.atLogin` 是系统登录项的现状，两者可能不一致。
   */
  desktop: {
    state: () => ipcRenderer.invoke('desktop:state') as Promise<DesktopState>,
    set: (patch: Partial<DesktopPrefs>) =>
      ipcRenderer.invoke('desktop:set', patch) as Promise<DesktopState>,
    /** 托盘里点了「打开长庚 / 定时任务」：主进程让渲染层换页 */
    onRoute: (handler: (route: string) => void) => {
      const listener = (_e: IpcRendererEvent, route: string): void => handler(route)
      ipcRenderer.on('app:route', listener)
      return (): void => {
        ipcRenderer.removeListener('app:route', listener)
      }
    }
  },

  shell: {
    open: (url: string) => ipcRenderer.invoke('shell:open', url) as Promise<boolean>,
    /** 打开系统回收站（删除类记录的"怎么撤"） */
    recycleBin: () => ipcRenderer.invoke('shell:recycle') as Promise<boolean>,
    /** 打开本机文件夹（仅限 userData 内的路径） */
    openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p) as Promise<boolean>,
    /**
     * 在资源管理器里指出长庚写出的那个文件（仅限桌面上「长庚产出」文件夹内）。
     * 返回 false = 不在这个目录里，或者文件已经不在了。
     */
    reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p) as Promise<boolean>
  },

  /**
   * 远程入口（手机 App）。
   *
   * 桌面这边能做的只有四件事：看状态、开关总闸、发配对码、踢设备。
   * 配对本身在手机上完成——桌面上没有"替手机登录"的按钮。
   */
  remote: {
    state: () =>
      ipcRenderer.invoke('remote:state') as Promise<{
        enabled: boolean
        address: string
        port: number
        devices: Array<{ id: string; label: string; createdAt: number; lastSeenAt: number | null }>
        pairing: { code: string; expiresAt: number; remainingMs: number } | null
        listeners: number
        lanAccess: boolean
        urls: string[]
        error?: string
      }>,
    enable: (enabled: boolean, lanAccess?: boolean) =>
      ipcRenderer.invoke('remote:enable', enabled, lanAccess) as Promise<{
        enabled: boolean
        address: string
        port: number
        devices: Array<{ id: string; label: string; createdAt: number; lastSeenAt: number | null }>
        pairing: { code: string; expiresAt: number; remainingMs: number } | null
        listeners: number
        lanAccess: boolean
        urls: string[]
        error?: string
      }>,
    issuePairingCode: () =>
      ipcRenderer.invoke('remote:pairing:issue') as Promise<{
        ok: boolean
        code?: string
        expiresAt?: number
        error?: string
      }>,
    revoke: (deviceId: string) => ipcRenderer.invoke('remote:devices:revoke', deviceId) as Promise<{ ok: boolean }>,
    revokeAll: () => ipcRenderer.invoke('remote:devices:revokeAll') as Promise<{ revoked: number }>
  },

  /** 存储占用（存储与缓存分区） */
  storage: {
    stats: () =>
      ipcRenderer.invoke('storage:stats') as Promise<{
        dir: string
        /** 配置目录：便携模式下在 U 盘上，与 dir 不同 */
        configDir: string
        portable: boolean
        files: Array<{ file: string; bytes: number; dir: string }>
      }>
  },

  /**
   * 桌面悬浮助手：球与面板。
   *
   * 桌面侧的会话存在 orb-sessions.json，与主窗口的 sessions.json 分开——
   * 桌面上随口问的那句不该混进主窗口的「最近」。promote 是把一条搬过去。
   */
  orb: {
    state: () =>
      ipcRenderer.invoke('orb:state') as Promise<{ prefs: OrbPrefs; hotkeyOk: boolean }>,
    set: (patch: Partial<OrbPrefs>) =>
      ipcRenderer.invoke('orb:set', patch) as Promise<{ prefs: OrbPrefs; hotkeyOk: boolean }>,
    close: () => ipcRenderer.invoke('orb:close') as Promise<boolean>,
    toggle: () => ipcRenderer.invoke('orb:toggle') as Promise<boolean>,

    /**
     * 拖动：渲染层只报光标位置，位移由主进程按增量累加。
     * screenX/screenY 是 CSS 像素，与 setBounds 的 DIP 同一尺度。
     */
    dragStart: (screenX: number, screenY: number) =>
      ipcRenderer.send('orb:drag-start', { x: screenX, y: screenY }),
    dragMove: (screenX: number, screenY: number) =>
      ipcRenderer.send('orb:drag-move', { x: screenX, y: screenY }),
    dragEnd: () => ipcRenderer.send('orb:drag-end'),

    sessions: {
      list: () => ipcRenderer.invoke('orb:sessions:list') as Promise<ChatSession[]>,
      save: (session: Partial<ChatSession>) =>
        ipcRenderer.invoke('orb:sessions:save', session) as Promise<ChatSession>,
      delete: (id: string) => ipcRenderer.invoke('orb:sessions:delete', id) as Promise<ChatSession[]>,
      clear: () => ipcRenderer.invoke('orb:sessions:clear') as Promise<ChatSession[]>
    },

    /** 把一条桌面会话搬到主窗口（打上 origin 标记），主窗口会跳过去打开它 */
    promote: (sessionId: string) =>
      ipcRenderer.invoke('orb:promote', sessionId) as Promise<
        { ok: true; sessionId: string } | { ok: false; reason: string }
      >,

    /** 偏好变了（设置页改完立刻推给已开着的球与面板） */
    onPrefs: (handler: (prefs: OrbPrefs) => void) => {
      const listener = (_e: IpcRendererEvent, prefs: OrbPrefs): void => handler(prefs)
      ipcRenderer.on('orb:prefs', listener)
      return (): void => {
        ipcRenderer.removeListener('orb:prefs', listener)
      }
    },
    /** 面板被打开：把焦点交给输入框 */
    onPanelShown: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('orb:panel-shown', listener)
      return (): void => {
        ipcRenderer.removeListener('orb:panel-shown', listener)
      }
    },
    /** 球的右键菜单（原生菜单由主进程弹，72px 的窗口里画不下） */
    menu: () => ipcRenderer.invoke('orb:menu') as Promise<boolean>,
    /** 面板把对话状态报给主进程，由它转给球；面板收起时球也要能显示「等你确认」 */
    reportStatus: (status: 'idle' | 'think' | 'ask' | 'done') => ipcRenderer.send('orb:status', status),
    onStatus: (handler: (status: 'idle' | 'think' | 'ask' | 'done') => void) => {
      const listener = (_e: IpcRendererEvent, status: 'idle' | 'think' | 'ask' | 'done'): void =>
        handler(status)
      ipcRenderer.on('orb:status', listener)
      return (): void => {
        ipcRenderer.removeListener('orb:status', listener)
      }
    },
    /** 主窗口侧：「移到主窗口」之后跳去打开这条会话 */
    onOpenSession: (handler: (sessionId: string) => void) => {
      const listener = (_e: IpcRendererEvent, sessionId: string): void => handler(sessionId)
      ipcRenderer.on('orb:open-session', listener)
      return (): void => {
        ipcRenderer.removeListener('orb:open-session', listener)
      }
    }
  },
}

contextBridge.exposeInMainWorld('butler', api)

export type ButlerApi = typeof api
