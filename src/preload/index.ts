import { contextBridge, ipcRenderer } from 'electron'
import type {
  AlwaysAllowedEntry,
  AppInfo,
  AppNote,
  AppSnapshot,
  AuthAnswer,
  ButlerConfig,
  ChatEvent,
  ChatMessage,
  ChatSession,
  ProjectDef,
  RecordEntry,
  SnapshotDiff,
  StartupItem,
  TaskDef,
  TodoDef,
  TurnResult,
  VerifyResult
} from '../shared/types'

const api = {
  info: () =>
    ipcRenderer.invoke('app:info') as Promise<{
      machineName: string
      userName: string
      osVersion: string
      today: string
      appVersion: string
      userData: string
    }>,

  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<ButlerConfig>,
    save: (patch: Partial<ButlerConfig>) =>
      ipcRenderer.invoke('config:save', patch) as Promise<ButlerConfig>,
    /** 密钥是否加密落盘（决定设置页提示文案） */
    secretsEncrypted: () => ipcRenderer.invoke('config:secretsEncrypted') as Promise<boolean>,
    test: (patch: Partial<ButlerConfig>) =>
      ipcRenderer.invoke('config:test', patch) as Promise<{
        ok: boolean
        detail: string
        latencyMs: number
      }>
  },

  apps: {
    list: () =>
      ipcRenderer.invoke('apps:list') as Promise<{
        apps: AppInfo[]
        verifyMap: Record<string, VerifyResult>
        durationMs: number
      }>,
    verify: (appName: string, publisher: string, officialUrl?: string) =>
      ipcRenderer.invoke('apps:verify', { appName, publisher, officialUrl }) as Promise<VerifyResult>,
    /** 功能说明的手写备注：覆盖查证生成的句子；空文本 = 删除 */
    notes: () => ipcRenderer.invoke('notes:list') as Promise<Record<string, AppNote>>,
    saveNote: (appName: string, text: string) =>
      ipcRenderer.invoke('notes:save', { appName, text }) as Promise<AppNote | null>
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
        sample: Array<{ title: string; url: string }>
      }>
  },

  startup: {
    list: () => ipcRenderer.invoke('startup:list') as Promise<{ items: StartupItem[]; durationMs: number }>
  },

  /** 邮箱连接自检：IMAP 只读打开收件箱，不拉正文；accountId 缺省测默认账号 */
  mail: {
    test: (patch: Partial<ButlerConfig>, accountId?: string) =>
      ipcRenderer.invoke('mail:test', patch, accountId) as Promise<{ ok: boolean; detail: string; total?: number }>
  },

  records: {
    list: (limit?: number) => ipcRenderer.invoke('records:list', limit) as Promise<RecordEntry[]>
  },

  /** 全局搜索：项目/方案/任务/会话，在主进程侧扫，只回命中的条目 */
  find: {
    all: (query: string, limit?: number) =>
      ipcRenderer.invoke('search:all', query, limit) as Promise<
        Array<{
          key: string
          kind: 'project' | 'plan' | 'task' | 'session'
          title: string
          sub: string
          projectId?: string
          planId?: string
          sessionId?: string
          messageId?: string
        }>
      >
  },

  /** 卸载快照：get 取原始快照，diff 拿当下与快照比对（没有对应快照时返回 null） */
  snapshot: {
    get: (id: string) => ipcRenderer.invoke('snapshot:get', id) as Promise<AppSnapshot | null>,
    diff: (id: string) => ipcRenderer.invoke('snapshot:diff', id) as Promise<SnapshotDiff | null>
  },

  /**
   * 纯写字补全：不带工具、不弹授权卡。
   * 项目页生成方案/简报走这里，不走 chat.send（那条会带全套工具和闸门）。
   */
  llm: {
    complete: (payload: { messages: ChatMessage[]; system?: string }) =>
      ipcRenderer.invoke('llm:complete', payload) as Promise<
        { ok: true; text: string } | { ok: false; error: string }
      >
  },

  chat: {
    send: (requestId: string, messages: ChatMessage[]) =>
      ipcRenderer.invoke('chat:send', { requestId, messages }) as Promise<TurnResult | { error: string }>,
    abort: (requestId: string) => ipcRenderer.invoke('chat:abort', requestId) as Promise<boolean>,
    /** 授权卡作答：once=只这一次 / always=始终允许（仅当卡片允许） / deny=拒绝 */
    answer: (authId: string, answer: AuthAnswer) =>
      ipcRenderer.invoke('chat:answer', { authId, answer }) as Promise<boolean>,
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

  /** 项目：命名好的快捷指令集 */
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<ProjectDef[]>,
    save: (project: Partial<ProjectDef>) => ipcRenderer.invoke('projects:save', project) as Promise<ProjectDef[]>,
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id) as Promise<ProjectDef[]>,
    /** 导出成 Markdown：弹保存框，写到用户选的位置 */
    exportMarkdown: (payload: { name: string; markdown: string }) =>
      ipcRenderer.invoke('projects:export', payload) as Promise<{
        ok: boolean
        path?: string
        canceled?: boolean
      }>
  },

  /** 会话：存 userData/sessions.json，可长期回看（之前只在 localStorage 留 20 条） */
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list') as Promise<ChatSession[]>,
    save: (session: Partial<ChatSession>) => ipcRenderer.invoke('sessions:save', session) as Promise<ChatSession>,
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id) as Promise<ChatSession[]>,
    clear: () => ipcRenderer.invoke('sessions:clear') as Promise<ChatSession[]>
  },

  /** 派发任务：方案里拆出来的待办，只做跟踪，不排程、不自动执行 */
  todos: {
    list: () => ipcRenderer.invoke('todos:list') as Promise<TodoDef[]>,
    save: (todo: Partial<TodoDef>) => ipcRenderer.invoke('todos:save', todo) as Promise<TodoDef>,
    delete: (id: string) => ipcRenderer.invoke('todos:delete', id) as Promise<TodoDef[]>
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

  shell: {
    open: (url: string) => ipcRenderer.invoke('shell:open', url) as Promise<boolean>,
    /** 打开系统回收站（删除类记录的"怎么撤"） */
    recycleBin: () => ipcRenderer.invoke('shell:recycle') as Promise<boolean>,
    /** 打开本机文件夹（仅限 userData 内的路径） */
    openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p) as Promise<boolean>
  },

  /** 存储占用（存储与缓存分区） */
  storage: {
    stats: () =>
      ipcRenderer.invoke('storage:stats') as Promise<{
        dir: string
        files: Array<{ file: string; bytes: number }>
      }>
  },
}

contextBridge.exposeInMainWorld('butler', api)

export type ButlerApi = typeof api
