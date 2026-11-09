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
  /**
   * 判分用的独立模型（评测脚本读它，不与干活的模型共用）。
   *
   * 为什么要分开：判分和智能体用同一个模型、同一份 config 时，等于自己给自己
   * 打分——分数高只证明"这个模型觉得自己的回答对"，证明不了能力。
   * 没配时评测会明确报"判分模型未配置"，而不是偷偷回落用主模型。
   */
  judge?: ModelConfig
  /** 旧版单账号邮箱（只读接入；address 为空 = 未配置）。mailAccounts 非空时不再使用 */
  mail?: MailConfig
  /** 多账号邮箱（只读接入）。数组第一个为默认账号；为空时回落到 mail */
  mailAccounts?: MailAccount[]
  /** 能力开关（插件页）：name → 是否启用；缺省视为启用 */
  toolToggles?: Record<string, boolean>
  /**
   * 只读模式（设置 › 权限与安全）。
   *
   * 打开后，所有 write / destroy / install 类的工具**根本不注册进本轮**——
   * 不是"弹卡时被拒"，而是模型连申请的机会都没有。定时任务同样受它约束。
   * undefined 视为 false，升级上来的老配置行为不变。
   */
  readOnly?: boolean
  /** 桌面常驻偏好（关闭行为 / 开机自启 / 任务通知），缺省按 DEFAULT_DESKTOP_PREFS */
  desktop?: DesktopPrefs
  /** 桌面悬浮助手（球与面板），缺省按 DEFAULT_ORB_PREFS */
  orb?: OrbPrefs
}

/**
 * 桌面悬浮助手的偏好。
 *
 * 与 desktop 分开：那一组决定「关窗之后进程还在不在」，这一组决定
 * 「桌面上多不多一个球」。混在一起会让「我只想关掉球、保留托盘」变成
 * 一次连带影响关窗行为的改动。
 */
export interface OrbPrefs {
  /** 桌面显示悬浮球（关掉后仍可从托盘与快捷键呼出面板） */
  enabled: boolean
  /** 球的位置；null = 用默认位置（右下角，留出任务栏） */
  x: number | null
  y: number | null
  /** 待命的呼吸动效；关掉后只在思考与等确认时有动画 */
  idleAnimation: boolean
  /** 全局快捷键呼出面板；空串 = 不注册 */
  hotkey: string
}

/**
 * 桌面常驻偏好。
 *
 * closeToTray 默认为开：定时任务只在进程活着的时候跑（见 node/tasks.ts 的边界说明），
 * 关窗即退等于顺手把定时任务关掉，所以默认让「关窗」只是收起窗口。
 */
export interface DesktopPrefs {
  /** 关闭窗口时收进托盘，不结束进程 */
  closeToTray: boolean
  /** 开机自动启动（写系统登录项，不另外注册自启项） */
  launchAtLogin: boolean
  /** 定时任务跑完或失败时弹系统通知 */
  notifyOnTask: boolean
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
  /**
   * 来自桌面悬浮助手的会话被「移到主窗口」后带上这个标记。
   *
   * 主窗口列表要能看出出身：这类会话的上下文通常只有一两轮，
   * 用户回看时会疑惑"为什么它没有前文"，标一下就说得通。
   */
  origin?: 'orb'
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

/**
 * 跨会话记忆的一条。
 *
 * 存的是"以后还用得上的事实"，不是聊天记录：聊天记录在 sessions.json 里，
 * 这里只留可以被下次对话引用的一句话。
 */
export type MemoryKind = 'user' | 'preference' | 'project' | 'fact'

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  user: '关于我',
  preference: '偏好',
  project: '在做的事',
  fact: '约定与事实'
}

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  /** 一句话，最长 200 字 */
  text: string
  createdAt: string
  /** 最后确认时间：重复保存同一条时只更新这个字段，不会堆出重复条目 */
  updatedAt: string
  /** 出自哪次对话（可选，便于回查原话） */
  source?: string
}

/** 重装凭据：只保留下载路径/包 ID，不保留安装包本体 */export interface AppSource {
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
  /**
   * 安装成功后登记的程序显示名（注册表 DisplayName）。
   *
   * 为什么记名字而不是只记 winget 包 Id：应用台账（list_installed_apps）的键是
   * DisplayName，要回答"这个程序是不是管家装的、什么时候装的"必须能对上那一行。
   * winget 包 Id 与 DisplayName 不保证一致，所以两条都留：Id 进 sourceUrl 那条记录
   * 的 data，显示名进这个字段。
   */
  installedName?: string
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

/**
 * 候选项：用户报的名称有歧义时，让用户在卡上自己选一个。
 *
 * 为什么要做成卡而不是让模型转述：之前是「有多条匹配就把候选写进一段文字，
 * 让模型念给用户听，用户回答，模型再报一次 Id」，来回两三轮还容易传错。
 * 把候选做成可点的按钮，选择是一次点击，且**用户看到的名字就是他批准的对象**。
 */
export interface ToolChoiceOption {
  /** 选完回传给工具的值（安装类就是 winget 包 Id） */
  value: string
  /** 卡上给人看的名字 */
  label: string
  /** 一行补充：包 Id、版本、来源 */
  detail?: string
}

/** 候选择卡：问的是「是哪一个」，不是「同不同意」，所以和授权卡分开 */
export interface ToolChoiceRequest {
  id: string
  /** 哪个工具在问 */
  tool: string
  title: string
  hint?: string
  options: ToolChoiceOption[]
  requestedAt: string
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
  /** 名称有歧义：请用户从候选里选一个（必须回 chat:choose，否则超时视为取消） */
  | { requestId: string; type: 'choice'; request: ToolChoiceRequest }
  /** 候选择卡超时：标记为已取消 */
  | { requestId: string; type: 'choiceExpired'; choiceId: string }
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
