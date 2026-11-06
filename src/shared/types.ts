/** 主进程与渲染层共用的数据结构（不含任何函数与 Electron 依赖） */

/**
 * 效果分档（v1.3 三档权限的代码表达）
 * read/ui  → 自动放行
 * write    → 先备份再放行，可撤销
 * destroy  → 必须过授权闸门，用户点了才执行
 */
export type ToolEffect = 'read' | 'ui' | 'write' | 'destroy' | 'install'

export type AuthzDecision = 'auto' | 'user_once' | 'user_always' | 'denied' | 'expired'

/** 用户在授权卡上的选择；expired 只由 60 秒超时产生，用户点不出来 */
export type AuthAnswer = 'once' | 'always' | 'deny' | 'expired'

export interface Evidence {
  id: string
  /** local = 本机实测读取；web = 联网访问 */
  type: 'local' | 'web'
  title: string
  detail?: string
  url?: string
  /** 实际访问/读取时间，ISO 字符串 */
  at: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  stream: boolean
  temperature: number
}

/**
 * 检索来源：
 * - duckduckgo / bing   免费 HTML 抓取（易被反爬，只作兜底）
 * - tavily / serper     带 Key 的检索 API（结果质量好，中文友好）
 * - bingapi             Bing Web Search v7（Azure 订阅 Key）
 * - none                关闭联网，用来验证"查不到"降级
 */
export type SearchProvider = 'duckduckgo' | 'bing' | 'tavily' | 'serper' | 'bingapi' | 'none'

export interface ButlerConfig extends ModelConfig {
  searchProvider: SearchProvider
  searchKey: string
  /** 旧版单账号邮箱（只读接入；address 为空 = 未配置）。mailAccounts 非空时不再使用 */
  mail?: MailConfig
  /** 多账号邮箱（只读接入）。数组第一个为默认账号；为空时回落到 mail */
  mailAccounts?: MailAccount[]
  /** 能力开关（插件页）：name → 是否启用；缺省视为启用 */
  toolToggles?: Record<string, boolean>
}

/** 定时任务的计划：每天固定时间，或每隔 N 分钟 */
export type TaskSchedule = { kind: 'daily'; time: string } | { kind: 'interval'; minutes: number }

/** 定时任务：到点把 prompt 作为用户消息交给长庚跑一轮（无人在场，需要授权的操作会被当场拒绝并留痕） */
export interface TaskDef {
  id: string
  name: string
  /** 到点后作为用户消息发出的完整指令 */
  prompt: string
  schedule: TaskSchedule
  enabled: boolean
  createdAt: string
  /** 上次运行（ISO 时间）与结果摘要 */
  lastRun?: string
  lastResult?: string
}

/** 出处：某条方案/任务是从哪次对话的哪条回答里攒出来的 */
export interface SourceRef {
  sessionId: string
  messageId: string
}

/** 一条会话：落盘保存，便于回看与"出处"反查。messages 是渲染层结构，主进程只存取不解释 */
export interface ChatSession {
  id: string
  ts: number
  title: string
  messages: unknown[]
}

export type ProjectStatus = 'active' | 'paused' | 'done'

/** 方案：项目里可保存、可重跑的结构化产出（正文是 Markdown，不自动执行） */
export interface PlanDef {
  id: string
  title: string
  /** 方案正文（模型产出或手写） */
  body: string
  createdAt: string
  /** 生成它的提示词，便于重跑 */
  prompt?: string
  /** 最终采纳哪条路径（人填） */
  decision?: string
  /** 可选路径的名称（从生成的元信息块解析，可手改） */
  options?: string[]
  /** 模型推荐哪条 */
  recommended?: string
  /** 工期估计 */
  estimate?: string
  /** 第一步动作 */
  firstStep?: string
  /** 出自哪次对话的哪条回答 */
  source?: SourceRef
}

/** 项目简报：某一时刻的进度快照 + 判断（模型撰写或本地事实版） */
export interface BriefDef {
  id: string
  createdAt: string
  /** 简报正文（Markdown） */
  body: string
  /** 生成瞬间的任务计数，便于回看当时的进度 */
  snapshot?: { total: number; done: number; doing: number; blocked: number; todo: number }
  /** true = 由模型撰写；false = 模型不可用时的本地事实版 */
  byModel?: boolean
}

/** 项目：一个有目标、有方案、有派发任务的实体；prompts 只是它的「常用指令」 */
export interface ProjectDef {
  id: string
  name: string
  /** 一句话目标：做成什么样算完成 */
  goal?: string
  /** 背景与现状 */
  context?: string
  /** 关键约束（时间、预算、不能碰的东西） */
  constraints?: string
  status?: ProjectStatus
  prompts: string[]
  plans?: PlanDef[]
  briefs?: BriefDef[]
  createdAt: string
  updatedAt?: string
}

/** dropped = 路径收敛时被放弃的任务：保留可回看，不算未完成、不算完成 */
export type TodoStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'dropped'
export type TodoPriority = 'high' | 'normal' | 'low'

/** 派发任务：从方案拆出来的一条待办；只做跟踪，不排程、不自动执行 */
export interface TodoDef {
  id: string
  projectId?: string
  title: string
  detail?: string
  /** 属于方案的哪条路径（对应 PlanDef.options 里的名字），用来对比不同路线的工作量 */
  option?: string
  /** 出自哪次对话的哪条回答 */
  source?: SourceRef
  status: TodoStatus
  priority: TodoPriority
  due?: string
  createdAt: string
  doneAt?: string
}

/** 带 Key 的来源：缺 Key 时直接说缺，而不是偷偷退回免费源 */
export const KEYED_PROVIDERS: SearchProvider[] = ['tavily', 'serper', 'bingapi']

export interface AppInfo {
  name: string
  version: string
  publisher: string
  installLocation: string
  sizeKB: number
  installDate: string
  systemComponent: number
  scope: 'machine' | 'user'
  arch: '32' | '64'
  /** 注册表登记的产品网址：查证时优先直连，比检索可靠得多 */
  urlInfoAbout?: string
  /** 注册表登记的安装来源（下载路径 / 包缓存） */
  installSource?: string
}

export interface StartupItem {
  name: string
  command: string
  source: string
  kind: 'registry' | 'startup-folder' | 'scheduled-task'
  enabled: boolean
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface PageContent {
  url: string
  finalUrl: string
  title: string
  text: string
  fetchedAt: string
}

/**
 * 「始终允许」的一条记忆。
 *
 * 只有 `allowAlways: true` 的工具才可能产生（当前仅 install_app；删除/卸载等销毁类固定不开），
 * key 形如 `tool::target`：工具或目标任一变化就失效，避免"换个目标沿用旧授权"。
 */
export interface AlwaysAllowedEntry {
  key: string
  tool: string
  /** 卡片上显示过的目标，人要用它核对"我当初到底允许了什么" */
  target: string
  createdAt: string
}

export interface VerifyResult {
  appName: string
  status: 'verified' | 'unverified'
  sentence: string
  sourceUrl: string
  evidenceText: string
  checkedAt: string
  /** 官网地址是怎么来的：注册表登记 / 模型提议后核对 / 检索出来 */
  via?: 'registry' | 'guess' | 'search'
  /** 失败原因（未查证时） */
  reason?: string
}

/**
 * 应用功能说明的手写备注：覆盖查证生成的句子。
 * 说明的两个来源——查证（官网 sentence，随 verify.json 落盘）与人写；
 * 用户写过的以人写为准，来源标记随行展示，不冒充官网出处。
 */
export interface AppNote {
  appName: string
  text: string
  updatedAt: string
}

/** 重装凭据：只保留下载路径/包 ID，不保留安装包本体 */
export interface AppSource {
  appName: string
  version: string
  publisher: string
  kind: 'winget' | 'official' | 'registry'
  wingetId?: string
  downloadPage?: string
  /** 官网不提供直链时，写明"需手动下载"的地址 */
  manualNote?: string
  recordedAt: string
}

/** 邮箱只读接入：授权码存在本地 config.json，与应用内其他密钥同等待遇 */
export interface MailConfig {
  address: string
  /** IMAP 授权码（不是登录密码；QQ 邮箱在 设置→账户→IMAP/SMTP 服务 里生成） */
  authCode: string
  host: string
  port: number
}

/** 多账号邮箱的一个账号：id 用于工具参数与展示；label 缺省时用 address 区分 */
export interface MailAccount extends MailConfig {
  id: string
  label?: string
}

export type RecordKind = 'read' | 'web' | 'ui' | 'write' | 'destroy' | 'refuse' | 'verify' | 'memory' | 'task'

export interface RecordEntry {
  id: string
  ts: string
  kind: RecordKind
  title: string
  sub: string
  result: 'ok' | 'rejected' | 'partial'
  /** 是否可撤回（只读动作一律 false：没有可撤回的东西） */
  reversible: boolean
  /** 动作分档 */
  effect?: ToolEffect
  /** 动了什么：路径、程序名、检索词（不是"调了哪个工具"） */
  target?: string
  before?: string
  after?: string
  /** 怎么撤回：回收站 / 备份路径 / 无 */
  undo?: string
  /** 谁批的 */
  authz?: AuthzDecision
  sourceUrl?: string
  /** 卸载前存的状态快照 id（用来回答"卸完少了什么"） */
  snapshot?: string
}

/**
 * 卸载前抓的状态快照：注册表项 + 安装目录规模 + 关联的开机自启项。
 *
 * 用途只有两个：卡片上告诉用户"这次会动掉多少东西"，以及卸载后对比
 * "注册表项/目录/自启项还在不在"。它不承诺能还原任何东西。
 */
export interface AppSnapshot {
  id: string
  appName: string
  takenAt: string
  registry: {
    key: string
    scope: 'machine' | 'user'
    arch: '32' | '64'
    version: string
    publisher: string
    uninstallString: string
    installLocation: string
    urlInfoAbout: string
  } | null
  installDir: {
    path: string
    exists: boolean
    fileCount: number
    dirCount: number
    totalBytes: number
    /** 顶层条目（最多 20 个），给人看"装了什么" */
    topLevel: string[]
    /** 扫描是否因为条目太多被截断 */
    truncated: boolean
  } | null
  startup: StartupItem[]
  /**
   * 卸载前的数据残留记账：AppData/ProgramData 下与发布者或产品名同名的目录。
   * 卸载对比时逐个重扫，"还在"的就是残留——只报告，不删除。
   */
  residuals: Array<{ path: string; fileCount: number; totalBytes: number }>
  summary: { sizeMB: number; files: number; startupCount: number }
}

/** 快照与"现在"的对比：只说明现状，不推断卸载程序做得对不对 */
export interface SnapshotDiff {
  appName: string
  takenAt: string
  registryStillThere: boolean
  installDirStillThere: boolean
  filesBefore: number
  filesNow: number
  bytesBefore: number
  bytesNow: number
  startupGone: string[]
  startupStillThere: string[]
  /** 快照记过的残留目录里，现在还存在的（这就是"卸完还剩什么"） */
  residualLeft: Array<{ path: string; fileCount: number; totalBytes: number }>
  /** 已经被清掉的残留目录数 */
  residualCleaned: number
  verdict: string
}

/** 授权卡内容：给人看的，不是给模型看的 */
export interface AuthRequest {
  id: string
  tool: string
  effect: ToolEffect
  title: string
  target: string
  impact: string
  undoHint?: string
  reinstallHint?: string
  paramsPreview: string
  requestedAt: string
  /** 是否允许"始终允许"（销毁类固定 false；install_app 允许，key 含包名+版本） */
  allowAlways: boolean
}

export interface ToolTrace {
  name: string
  label: string
  ok: boolean
  effect: ToolEffect
  /** 被授权闸门拦下 */
  blocked?: boolean
  args: Record<string, unknown>
}

export interface TurnResult {
  text: string
  evidence: Evidence[]
  tools: ToolTrace[]
  /** 本轮没有任何工具证据却给出了回答 */
  unsourced: boolean
  steps: number
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export type ChatEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'status'; text: string }
  | { requestId: string; type: 'tool'; name: string; label: string; effect: ToolEffect }
  /** 授权闸门要求确认：渲染层必须回 auth:answer，否则主进程一直等（超时视为拒绝） */
  | { requestId: string; type: 'auth'; request: AuthRequest }
  /** 授权卡超时：渲染层把对应的卡标记为「已超时」，不用等 turn 结束 */
  | { requestId: string; type: 'authExpired'; authId: string }
  | { requestId: string; type: 'done'; result: TurnResult }
  | { requestId: string; type: 'error'; message: string }

/** 对联合类型逐个 Omit，避免 Omit<联合> 只保留公共字段 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type ChatPayload = DistributiveOmit<ChatEvent, 'requestId'>

export interface HealthReport {
  ok: boolean
  model?: string
  detail: string
  latencyMs?: number
}
