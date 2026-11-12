import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppInfo, AppSnapshot, Evidence, MemoryEntry, SearchHit } from '../../shared/types'
import { diffStartupNames, listInstalledApps, listStartupItems, type StartupDiff } from '../node/registry'
import { deleteToRecycle, listSandbox, SANDBOX_ROOT } from '../node/sandbox'
import { captureSnapshot, diffSnapshot, pickSnapshot } from '../node/snapshot'
import { listRecentMail, readMailBody } from '../node/mail'
import {
  checkInstalled,
  installWinget,
  matchedByName,
  rankCandidates,
  searchWinget,
  wingetAvailable,
  type InstalledCheck,
  type WingetPackage
} from '../node/install'
import { launchUninstaller, planUninstall } from '../node/uninstall'
import { resolveLaunch } from '../node/launch'
import { appIdentity, findOpenWindow, type LaunchProbe } from '../node/running'
import { windowAt } from '../node/screen'
import { planFolder } from '../node/folder'
import {
  DEFAULT_MAX_CHARS,
  HARD_MAX_CHARS,
  fileKindOf,
  isExecutableFile,
  planFile,
  readFileSlice,
  unsupportedReason,
  type FileRead
} from '../node/file'
import { fetchPage, searchWeb } from '../node/web'
import {
  buildDocument,
  inspectDocument,
  MAX_DOC_CHARS,
  OUTPUT_FOLDER,
  resolveDocument,
  writeDocumentOnce,
  type BuiltDocument
} from '../node/document'
import { MEMORY_MAX_TEXT, mergeMemory, removeMemory, sameMemory } from '../node/memory'
import type { ToolDef, ToolPlan, ToolResult } from './tool-types'
import { runDelegation, workerConfigFrom } from '../orchestrator/delegate'
import { assertUploadableFile, ghReady, searchRepos, uploadFile, verifyRemoteFile } from '../node/github'
import { dispatchOptions, parseMode, previewDispatch, runProject, taskArtifacts } from '../orchestrator/project'
import { validatePlan } from '../orchestrator/plan'
import type { AcceptanceCheck, OrchestrationTask } from '../orchestrator/types'

/**
 * 从模型给的单个任务里读出 worker 声明。
 *
 * 认不出的后端名直接丢掉（走默认），**不猜**——猜错会派给一家不适合的，
 * 而且用户以为是自己指定的那家。能力词交给 capabilities 层归一。
 */
function buildWorkerSpec(t: Record<string, unknown>): OrchestrationTask['worker'] {
  const backend = String(t.backend ?? '').trim().toLowerCase()
  const known = ['pi', 'codex', 'codebuddy', 'claude']
  const spec: NonNullable<OrchestrationTask['worker']> = {}
  if (known.includes(backend)) spec.backend = backend as NonNullable<OrchestrationTask['worker']>['backend']
  if (Array.isArray(t.tools)) spec.tools = t.tools.map(String).filter(Boolean)
  if (typeof t.model === 'string' && t.model.trim()) spec.model = t.model.trim()
  return Object.keys(spec).length > 0 ? spec : undefined
}

/** 把模型给的任务列表转成结构化计划。认不出的直接丢掉，不猜 */
function parseProjectTasks(raw: unknown): OrchestrationTask[] {
  if (!Array.isArray(raw)) return []
  const out: OrchestrationTask[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const id = String(t.id ?? '').trim()
    const title = String(t.title ?? '').trim()
    const prompt = String(t.prompt ?? '').trim()
    if (!id || !title || !prompt) continue
    out.push({
      id,
      title,
      prompt,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String).filter(Boolean) : [],
      status: 'pending',
      acceptance: parseAcceptance(Array.isArray(t.acceptance) ? t.acceptance : []),
      // 任务的 worker 声明：后端与能力词都不是必填，缺了就走默认后端
      worker: buildWorkerSpec(t),
      attempts: 0
    })
  }
  return out
}

/**
 * 把模型给的验收项转成结构化检查。参数来自模型，属于不可信输入：
 * 认不出的 kind 直接丢掉，而不是猜一个——猜错会变成"检查了个寂寞却显示通过"。
 */
function parseAcceptance(raw: unknown[]): AcceptanceCheck[] {
  const out: AcceptanceCheck[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const path = String(c.path ?? '').trim()
    if (!path) continue
    const kind = String(c.kind ?? '')
    if (kind === 'file-exists') out.push({ kind, path })
    else if (kind === 'min-bytes' && typeof c.bytes === 'number' && c.bytes > 0)
      out.push({ kind, path, bytes: Math.floor(c.bytes) })
    else if (kind === 'contains' && String(c.text ?? '').length > 0)
      out.push({ kind, path, text: String(c.text) })
    else if (kind === 'not-contains' && String(c.text ?? '').length > 0)
      out.push({ kind, path, text: String(c.text) })
  }
  return out
}

export interface ToolDeps {
  /** 打开系统设置页（由主进程注入，评测脚本里为空实现） */
  openSettings?: (page: string) => Promise<void>
  /**
   * 启动一个开始菜单快捷方式：主进程注入 `shell.openPath`，成功返回空字符串。
   *
   * 只传快捷方式路径，不传 exe、不传参数——参数拼接是另一类风险，
   * 而"打开程序"这件事用不着它。
   */
  launchShortcut?: (filePath: string) => Promise<string>
  /**
   * 委派给外部智能体（编排层）。rootDir 由主进程注入 userData 下的目录；
   * 没注入 = 当前环境不支持委派（评测/闸门自检），工具会如实拒绝。
   */
  delegate?: {
    rootDir: string
    worker: { provider?: string; model?: string; timeoutSec?: number }
    onProgress?: (note: string) => void
  }
  /**
   * 允许上传到 GitHub 的目录白名单。
   *
   * 只认这几个根：上传带 `repo` 权限，等于能往用户所有仓库写东西。
   * 允许"传任意路径"就是允许模型把桌面上的任何文件推到公开仓库去——
   * 这一步不该存在，所以给白名单目录，而不是给一个开关。
   * 没注入 = 当前环境不支持上传。
   */
  uploadRoots?: string[]
  /**
   * 启动前先看一眼：这个快捷方式指向哪个 exe、现在有哪些进程和可见窗口。
   *
   * 用来避免"已经开着的程序又被启动一份"——用户点了两次不是因为想开两个，
   * 而是因为他看不见已经有窗口了。
   */
  probeLaunch?: (lnkPath: string) => Promise<LaunchProbe>
  /** 把已经开着的那个窗口调到前面（拿不到窗口就返回 false，不影响"它开着"这个结论） */
  focusApp?: (pid: number) => Promise<boolean>
  /**
   * 后台安装的任务清单。
   *
   * 有它 = 安装不再占住那一轮对话：工具立刻返回，装完之后由任务自己收尾并通知。
   * 没有它（评测、闸门自检、离线验收）= 老样子同步装完再返回。
   * 不给这些环境编一个假后台：那里没有窗口、没有通知、也没有人能点取消，
   * "后台"只会变成"结果不知道去哪了"。
   */
  installJobs?: import('../node/install-jobs').InstallJobs
  /**
   * 启动系统应用清单里的条目（`shell:AppsFolder\<AppID>`）。
   *
   * 豆包、商店应用这类**不建任何快捷方式**的程序只有这一条路。
   * 传进去的 AppID 来自 `Get-StartApps`，不是模型给的字符串。
   */
  launchAppsFolder?: (appId: string) => Promise<string>
  /**
   * 在资源管理器里打开一个**目录**。主进程注入 `shell.openPath`，成功返回空字符串。
   *
   * 只接目录路径：同一个外壳接口对文件会"打开"（exe 就是执行），
   * 所以路径的合法性由 node/folder.ts 在解析阶段就卡死，不靠这里再判断。
   */
  openFolder?: (dirPath: string) => Promise<string>
  /**
   * 用系统默认程序打开一个**文件**。主进程注入 `shell.openPath`，成功返回空字符串。
   *
   * 和 openFolder 是同一个外壳接口，但分开注入：后缀该不该放行由 node/file.ts
   * 在解析阶段定（会执行的后缀一律拒绝），这里不再重复判断。
   */
  openFile?: (filePath: string) => Promise<string>
  /**
   * 屏幕截图（给模拟键鼠的授权卡用）。主进程注入 Electron 的 desktopCapturer。
   * 没注入 = 当前环境截不了图（评测/离线），模拟键鼠类工具会如实拒绝执行——
   * 看不到屏幕就不该批准点击，也不该在没有图的情况下让用户盲签。
   */
  captureScreen?: (x?: number, y?: number) => Promise<{ dataUrl: string; width: number; height: number; originX: number; originY: number; scale: number }>
  /**
   * 模拟键鼠的入口。主进程注入真实实现；没注入 = 不支持。
   *
   * 三个动作分开注入而不是一个大函数：白名单检查要在调用**之前**做，
   * 而且每个动作的授权语义不同（点击看坐标、输入看文本、按键看组合键）。
   */
  desktopInput?: {
    /** 列可见窗口（白名单检查用） */
    listWindows: () => Promise<Array<{ title: string; process: string; x: number; y: number; width: number; height: number }>>
    click: (x: number, y: number, button: 'left' | 'right') => Promise<{ ok: boolean; detail: string }>
    type: (text: string) => Promise<{ ok: boolean; detail: string }>
    press: (combo: string) => Promise<{ ok: boolean; detail: string }>
    /** 允许操作哪些进程（白名单）；空数组 = 一个都不允许 */
    allowedProcesses: () => string[]
  }
  /** 卸载前的快照落盘（主进程注入 Store；评测脚本可不注入，只跳过存档） */
  saveSnapshot?: (snapshot: AppSnapshot) => Promise<void>
  /**
   * 读回卸载前快照（最近的在前）。
   *
   * 卸载当场核对不了，那句 unavailable 承诺了"点完再问我"——要兑现它，
   * 得有一个能在事后自己找到那份快照的入口，而不是让用户去记录页点按钮。
   */
  listSnapshots?: () => Promise<AppSnapshot[]>
  /**
   * 用户的桌面目录（主进程注入 `app.getPath('desktop')` —— 走这个 API 而不是拼
   * `%USERPROFILE%\Desktop`，因为桌面被重定向到 OneDrive 时拼出来的路径是错的）。
   *
   * 只给这一个根，产出目录名在 node/document.ts 里写死。不注入 = 当前环境不写文件
   * （评测、离线验收），而不是"写到当前目录"——后者会把文件丢在进程的 cwd 里。
   */
  outputRoot?: string
  /** 跨会话记忆的读写（主进程注入 Store） */
  memory?: {
    list: () => Promise<MemoryEntry[]>
    save: (list: MemoryEntry[]) => Promise<void>
  }
  /**
   * 管家装过的程序：注册表显示名 → 安装时间（ISO）。
   * 来自审计记录里 effect=install 且成功的那几条，应用台账据此标"是不是管家装的"。
   */
  butlerInstalls?: () => Promise<Record<string, string>>
}

/**
 * 注册表的 InstallDate 是 YYYYMMDD 字符串。
 * 格式对不上就原样返回，不去猜它是什么日期——猜错比空着更糟。
 */
function formatInstallDate(raw: string): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : text
}

interface InstallVerification {
  /** 是否真的在程序清单里查到了 */
  confirmed: boolean
  /** 注册表里的那一行（查不到就是 null） */
  app: AppInfo | null
  /** 登记进审计的显示名 */
  displayName: string
  /** 一句话结论，直接并进工具 summary */
  note: string
}

/**
 * 装完核对：winget 说成功之后，再自己查三件事。
 *
 * 全部用 force=true：注册表与启动项各有 TTL 缓存（5 分钟 / 1 分钟），
 * 装完不强制刷新，读到的还是装之前那一份，"核对通过"就成了自己骗自己。
 */
async function verifyInstall(
  chosen: WingetPackage,
  beforeStartup: string[] | null,
  signal?: AbortSignal
): Promise<InstallVerification> {
  let check: InstalledCheck
  try {
    check = await checkInstalled(chosen.id, signal)
  } catch (err) {
    check = { found: false, detail: `核对失败：${err instanceof Error ? err.message : String(err)}` }
  }

  let apps: AppInfo[] = []
  try {
    apps = (await listInstalledApps(true)).apps
  } catch {
    apps = []
  }
  // winget 的 name 与注册表 DisplayName 不保证一致，所以两级匹配：先全等、再包含。
  // 包含匹配只在**唯一命中**时采用：否则查 "WeChat" 可能挑到 "WeChat Work"，
  // 报告出来的安装路径就是另一个程序的。都找不到就认"没核实到"，不硬凑一行上去
  const wanted = [check.name, chosen.name]
    .map((n) => (n ?? '').trim().toLowerCase())
    .filter((n) => n.length >= 2)
  const exact = apps.find((a) => wanted.includes(a.name.toLowerCase()))
  const loose = exact ? [] : apps.filter((a) => wanted.some((w) => a.name.toLowerCase().includes(w)))
  const app = exact ?? (loose.length === 1 ? loose[0] : null)

  let startup: StartupDiff | null = null
  if (beforeStartup) {
    try {
      startup = diffStartupNames(
        beforeStartup,
        (await listStartupItems(true)).items.map((i) => i.name)
      )
    } catch {
      startup = null
    }
  }

  const confirmed = check.found || Boolean(app)
  const parts: string[] = []
  if (confirmed) {
    const where = app?.installLocation ? `，装到 ${app.installLocation}` : ''
    parts.push(`核过程序清单：${app?.name ?? check.name ?? chosen.name} 在册${where}`)
  } else {
    parts.push(`核对没对上（${check.detail}）：安装器可能还没写完，或安装被中途取消`)
  }
  if (app) {
    const date = formatInstallDate(app.installDate)
    if (date) parts.push(`注册表登记安装日期 ${date}`)
  }
  if (startup && (startup.added.length > 0 || startup.removed.length > 0)) {
    if (startup.added.length > 0) {
      const shown = startup.added.slice(0, 4).join('、')
      parts.push(
        `安装前后新增 ${startup.added.length} 个开机自启项（${shown}${startup.added.length > 4 ? '…' : ''}），这是两次扫描的差异，未必全是它加的`
      )
    }
    if (startup.removed.length > 0) {
      parts.push(`另有 ${startup.removed.length} 个自启项在安装前后消失，不正常，值得看一眼`)
    }
  } else if (startup) {
    parts.push('安装前后开机自启项没有变化')
  }

  return {
    confirmed,
    app,
    displayName: app?.name ?? check.name ?? chosen.name,
    note: parts.join('；')
  }
}

function ev(partial: Omit<Evidence, 'id' | 'at'>): Evidence {
  return { id: `ev_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), ...partial }
}

/**
 * 从"装"到"核对完"的整条路，一次跑完。
 *
 * 抽出来是为了让前台/后台两种跑法用的是**同一段代码**：有没有后台任务清单，
 * 装的过程、取消的措辞、核对的口径都必须一模一样。分两份写的话，
 * 迟早一边改了另一边没改，而"装没装上"这件事容不得两种说法。
 *
 * `beforeStartup` 是装之前抓的自启项基准线，必须由调用方在装之前取好传进来——
 * 这里已经太晚了，安装器一开，基准线就没了。
 *
 * 返回体里单独给一个 `status`，**不靠 summary 的措辞去猜**：核对那段话里本来
 * 就含有"或安装被中途取消"这种字样，用正则从里面认"这次是不是被取消了"，
 * 迟早把一次核对失败认成用户取消（真踩过）。
 */
async function runInstallToCompletion(
  chosen: WingetPackage,
  beforeStartup: string[] | null,
  signal?: AbortSignal
): Promise<{ result: ToolResult; status: 'ok' | 'failed' | 'cancelled' }> {
  const outcome = await installWinget(chosen.id, signal)
  if (outcome.cancelled) {
    // 用户自己点的取消不是故障：别让模型说成"安装失败"或再劝一次
    return { result: { ok: false, summary: `「${chosen.name}」${outcome.detail}` }, status: 'cancelled' }
  }
  /**
   * 走到这里说明装前查重没查到，但 winget 说"已经装了"——
   * 清单缓存、用户自己刚装过、或查重那一步超时都会这样。
   * 这时候**什么都没装**，绝不能顺着下面"装完了"的流程宣布安装成功：
   * 那会让用户以为刚装上是新版本。
   */
  if (outcome.alreadyInstalled) {
    return {
      result: {
        ok: false,
        summary: `「${chosen.name}」本来就在这台机器上，这一轮没有安装任何东西（winget 发现已有此包，直接没有运行安装程序）。如实告诉用户它已经在了，不要重试 install_app，也不要劝他重装——需要更新时软件自己会提示；他想看到这个程序就调用 launch_app 打开它。`,
        data: { id: chosen.id, version: chosen.version, source: 'winget', alreadyInstalled: true }
      },
      status: 'failed'
    }
  }
  if (!outcome.ok) {
    return { result: { ok: false, summary: `没能安装「${chosen.name}」：${outcome.detail}` }, status: 'failed' }
  }

  const verified = await verifyInstall(chosen, beforeStartup, signal)
  const headline = verified.confirmed
    ? `已通过 winget 安装「${chosen.name}」（${chosen.id}）`
    : `winget 报告安装成功，但核对没对上：程序清单里查不到「${chosen.name}」（${chosen.id}）`

  return {
    status: verified.confirmed ? 'ok' : 'failed',
    result: {
      // winget 说成功、我们却查不到，这条就按未成功上报（审计记 partial），
      // 让模型如实说"没核实到"，而不是替 winget 宣布装好了
      ok: verified.confirmed,
      summary: `${headline}。${verified.note}`,
      undo: '安装不可撤回（卸载可再找管家）',
      sourceUrl: outcome.sourceUrl,
      /**
       * 核对结果直接填上，不让闸门再跑一遍：装完核对需要装之前抓的自启项基准线，
       * 事后补不了。填的是同一次核对（三条事实）的结论，格式与其它工具统一。
       */
      verify: {
        state: verified.confirmed ? 'confirmed' : 'mismatch',
        fact: verified.note
      },
      // 只登记核实到的显示名：没核实到就不往台账上写"管家装的"
      installedName: verified.confirmed ? verified.displayName : undefined,
      data: {
        id: chosen.id,
        version: chosen.version,
        source: 'winget',
        sourceUrl: outcome.sourceUrl,
        installedName: verified.displayName,
        installLocation: verified.app?.installLocation || null,
        installDate: verified.app ? formatInstallDate(verified.app.installDate) : null,
        confirmed: verified.confirmed
      },
      evidence: [
        ev({
          type: 'local',
          title: `安装：${chosen.name}`,
          detail: `winget 交互式安装（安装器界面里由用户确认） · Id ${chosen.id} · 用户授权后执行 · 装后核对${
            verified.confirmed ? '通过' : '未对上'
          }${outcome.sourceUrl ? ` · 安装包来源 ${outcome.sourceUrl}` : ''}`
        })
      ]
    }
  }
}

/**
 * 把一段读出来的内容包成工具结果。
 *
 * summary 里必须写清"读了多少、还剩多少"：这是模型判断"能不能说'全文讲的是…'"
 * 的唯一依据。写成"已读取"这种笼统的话，模型就会拿前 3000 字当全文总结，
 * 而用户完全看不出结论只覆盖了开头。
 *
 * nextOffset 为非空时，把 offset 参数的名字也写进 summary——模型照着念就能接着读，
 * 不用去猜参数怎么传。
 */
function describeRead(read: FileRead): ToolResult {
  const sizeKB = Math.max(1, Math.round(read.sizeBytes / 1024))
  const covered = read.offset + read.text.length
  const partial = read.nextOffset !== null
  const span = partial
    ? `第 ${read.offset + 1}~${covered} 字，共 ${read.totalChars} 字，还剩 ${read.totalChars - covered} 字`
    : read.offset > 0
      ? `第 ${read.offset + 1}~${covered} 字（已到结尾，共 ${read.totalChars} 字）`
      : `全文 ${read.totalChars} 字`
  const tail = partial
    ? `。**只读到一部分**：总结时必须说明结论只覆盖这 ${read.text.length} 字；要接着读就再调一次、offset=${read.nextOffset}`
    : ''
  return {
    ok: true,
    summary: `读取「${read.name}」（${sizeKB}KB · ${read.encoding}）：${span}${tail}`,
    data: {
      path: read.path,
      name: read.name,
      kind: read.kind,
      encoding: read.encoding,
      sizeKB,
      totalChars: read.totalChars,
      offset: read.offset,
      nextOffset: read.nextOffset,
      /** 已经读到结尾了，模型据此可以放心说"全文" */
      complete: !partial,
      text: read.text
    },
    evidence: [
      ev({
        type: 'local',
        title: `读取文件：${read.name}`,
        detail: `${read.path} · ${read.encoding} · ${span}`
      })
    ]
  }
}

/**
 * prompt 的能力段：由工具注册表生成，单一事实源。
 * 只列「能真正改动机器」的工具（destroy / install / write）；
 * 新增或删除这类工具时，模型的自述自动跟着变，不再手写第二份。
 */
export function capabilityBrief(tools: ToolDef[]): string {
  const mutating = tools.filter((t) => t.effect === 'destroy' || t.effect === 'install' || t.effect === 'write')
  if (mutating.length === 0) return '   （当前版本没有能改动机器的工具，一切真实文件都不动。）'
  return mutating
    .map((t) => {
      const first = t.description.split(/[。；]/)[0].replace(/\*\*/g, '')
      return `   - **${t.label}**（${t.name}）：${first.slice(0, 110)}。都必须用户点授权卡才会真正执行`
    })
    .join('\n')
}

const SETTINGS_PAGES: Record<string, string> = {
  apps: 'ms-settings:appsfeatures',
  startup: 'ms-settings:startupapps',
  privacy: 'ms-settings:privacy',
  storage: 'ms-settings:storagesense'
}

export function createTools(deps: ToolDeps = {}): ToolDef[] {
  const delegateTool: ToolDef = {
    name: 'delegate_to_agent',
    label: '委派给外部智能体（需授权）',
    description:
      '把一个**耗时长、需要反复读写文件**的活交给外部的 pi 工作体去做：它有自己的模型、自己的工具循环，做完把产出和验收结果交回来。适合"读一批材料写一份报告""照这个要求改一份文档"这类长活；**不适合一次性的问答、也不适合改用户正在用的项目**——每次委派都落在一个全新的独立目录里，不会碰你手上的仓库。用户没有明确同意前不要调用。',
    effect: 'write',
    // 交给无人值守的外部智能体：目录里有什么它都能读，命令也能执行。
    // 所以必须过卡，且永不「始终允许」——见 gate.ts 里 requiresConfirmation 分支
    requiresConfirmation: true,
    allowAlways: false,
    // 提示词和文件内容都会发到本机之外（除非工作体接的是内网网关，这一点由配置决定）
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '这次委派的一句话标题，卡片上会显示' },
        prompt: {
          type: 'string',
          description: '交给工作体的完整提示词：要做什么、读哪些文件、写成什么文件。写清楚交付物'
        },
        expect: {
          type: 'array',
          description: '验收清单：工作体说做完了不算，这些检查过了才算。留空表示只取回答',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['file-exists', 'min-bytes', 'contains', 'not-contains'] },
              path: { type: 'string', description: '相对工作目录的路径' },
              bytes: { type: 'number' },
              text: { type: 'string' }
            },
            required: ['kind', 'path']
          }
        },
        tools: {
          type: 'array',
          description: '工作体可用的工具白名单，默认只给 read 和 write。不给 bash 它就跑不了命令',
          items: { type: 'string' }
        }
      },
      required: ['prompt']
    },
    describeTarget: (args) => {
      const title = String(args.title ?? '').trim() || '委派任务'
      const expect = Array.isArray(args.expect) ? args.expect.length : 0
      return {
        title: `委派给外部智能体：${title}`,
        target: title,
        impact:
          `会把提示词和它读到的文件内容交给本机之外的工作体；它会在这个新目录里写文件、可能执行命令，` +
          `过程中不会回来问你。默认只给 read/write 两个工具。${expect > 0 ? `交付要过 ${expect} 项检查。` : '不设验收，只取回答。'}`,
        undoHint: '拒绝就什么都不派出去'
      }
    },
    run: async (args, ctx): Promise<ToolResult> => {
      if (!deps.delegate) {
        return { ok: false, summary: '当前环境不支持委派（没有注入工作目录）' }
      }
      const worker = workerConfigFrom(deps.delegate.worker, Array.isArray(args.tools) ? args.tools.map(String) : undefined)
      if (!worker) {
        return {
          ok: false,
          summary:
            '工作体没有配置：要先在设置里填 provider 和 model（例如 eepseek / deepseek-v4-flash）。' +
            '不填就会走 pi 的默认模型，那条路会 401，所以这里不猜默认值。'
        }
      }
      const expect = Array.isArray(args.expect) ? parseAcceptance(args.expect) : undefined
      const result = await runDelegation(
        {
          title: String(args.title ?? '').trim() || undefined,
          prompt: String(args.prompt ?? ''),
          expect,
          tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined
        },
        worker,
        { rootDir: deps.delegate.rootDir, signal: ctx.signal, onProgress: deps.delegate.onProgress }
      )
      return {
        ok: result.ok,
        summary: `${result.summary}${result.artifactPaths.length > 0 ? `。产出：${result.artifactPaths.join(' | ')}` : ''}`,
        /**
         * 事实来自验收，不是工作体自己那句"做完了"：会跑的检查通过了才算过。
         * 验收清单为空时（只取回答）没有可核对的东西，那就按结果如实说。
         */
        verify: {
          state: result.ok ? 'confirmed' : 'mismatch',
          fact: result.ok
            ? `验收过了：${result.taskStatus} · 产出 ${result.artifactPaths.length} 个文件 · 回答 ${result.outputChars} 字节`
            : `验收没过：${result.taskStatus}${result.failureReason ? ` · ${result.failureReason}` : ''}`
        },
        data: result,
        evidence: [
          {
            id: randomUUID().slice(0, 8),
            type: 'local',
            title: `委派：${String(args.title ?? '').trim() || '委派任务'}`,
            detail: `${result.taskStatus} · 目录 ${result.projectRoot} · 回答 ${result.outputChars} 字节${
              result.failureReason ? ` · ${result.failureReason}` : ''
            }`,
            at: new Date().toISOString()
          }
        ]
      }
    }
  }

  /**
   * 多任务项目派发：候选卡在这一步让用户选「串行还是并行几路」。
   *
   * 为什么不用工具参数让模型自己决定并行度：并行 = 多倍并发打到同一个模型网关，
   * 那是用户的钱和时间。模型看不到这些代价，用户看得到——所以做成卡上的一次点击。
   */
  const runProjectTool: ToolDef = {
    name: 'run_project',
    label: '派发项目（需授权）',
    description:
      '把**一组有先后依赖的任务**整体交给外部工作体跑：长庚按依赖分好批，能并行的并行、有依赖的排队，全部跑完再逐个验收。' +
      '适合"读这几份材料、各自提炼、再合成一份报告"这类多步活。**一次只派一个任务的简单委派请用 delegate_to_agent**。' +
      '派发前会弹一张候选卡让你选串行还是并行几路（并行更快，但同时在跑的进程数也翻倍），再用授权卡确认。' +
      '每个任务都落在独立目录里，不碰你手上的仓库。用户没有明确同意前不要调用。',
    effect: 'write',
    requiresConfirmation: true,
    allowAlways: false,
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名，一句话' },
        mode: {
          type: 'string',
          description: '派发方式，由候选卡写回（serial / parallel:3）。调用时留空，等用户选'
        },
        tasks: {
          type: 'array',
          description: '任务列表。每个任务要有 id、title、prompt；dependsOn 写依赖的任务 id；acceptance 写可执行的验收',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              prompt: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              backend: {
                type: 'string',
                enum: ['pi', 'codex', 'codebuddy', 'claude'],
                description: '这一件交给哪家做。留空用设置里的默认后端。按活的性质分配：整理资料可以给 codebuddy，跑代码给 pi'
              },
              model: { type: 'string', description: '这一件用哪个模型，留空用该后端自己的配置' },
              acceptance: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['file-exists', 'min-bytes', 'contains', 'not-contains'] },
                    path: { type: 'string' },
                    bytes: { type: 'number' },
                    text: { type: 'string' }
                  },
                  required: ['kind', 'path']
                }
              },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: '允许干哪几类事，用能力词写：read / write / edit / bash。不要写各家自己的工具名（claude 的 Read、pi 的 read）——系统会自动翻译'
              }
            },
            required: ['id', 'title', 'prompt']
          }
        }
      },
      required: ['name', 'tasks']
    },
    plan: async (args): Promise<ToolPlan> => {
      if (!deps.delegate) return { ok: false, reason: '当前环境不支持派发（没有注入工作目录）' }
      const tasks = parseProjectTasks(args.tasks)
      if (tasks.length === 0) return { ok: false, reason: '没有给出可行的任务（每个任务都要有 id、标题、提示词）' }

      const validation = validatePlan(tasks)
      if (!validation.ok) {
        return { ok: false, reason: `计划不合法：${validation.errors.map((e) => e.message).join('；')}` }
      }

      const preview = previewDispatch(tasks)
      const options = dispatchOptions(preview)
      const mode = String(args.mode ?? '').trim()

      // 还没选、且真的有多档可选 → 弹候选卡。只有串行一种时不必问。
      if (!mode && options.length > 1) {
        return {
          ok: false,
          reason: `计划有 ${preview.total} 个任务、最宽一层 ${preview.maxWidth} 个，等用户在候选卡上选派发方式`,
          choice: {
            title: '这次怎么派？',
            hint:
              `共 ${preview.total} 个任务，按依赖分成 ${preview.layerWidths.length} 批（每批 ${preview.layerWidths.join(' / ')} 个）。` +
              '并行更快，但同一时刻有多个工作体在跑，也就有多个进程在读你的材料。',
            pickInto: 'mode',
            options
          }
        }
      }

      const concurrency = Math.min(parseMode(mode), Math.max(1, preview.maxWidth))
      // target 里必须带上候选卡的原始选择值（K7）：闸门会检查"卡片上写的目标"
      // 里含不含用户点的那个 value。写成纯人话（"3 个任务 · 串行"）就不含 `serial`，
      // 于是每次选串行都被判成"解析结果与选择不一致"而拒绝——真机踩过。
      const modeLabel = concurrency === 1 ? '串行' : `并行 ${concurrency} 路`
      const rawMode = mode.trim() || (concurrency === 1 ? 'serial' : `parallel:${concurrency}`)
      return {
        ok: true,
        target: {
          title: `派发项目：${String(args.name ?? '').trim() || '未命名项目'}`,
          target: `${preview.total} 个任务 · ${modeLabel}（${rawMode}）`,
          impact:
            `会把各任务的提示词和它读到的文件内容交给本机之外的工作体；每个任务在各自的目录里写文件、可能执行命令，` +
            `过程中不会回来问你。任务全部完成后按预先写好的检查逐条验收，不通过就如实报不通过。`,
          undoHint: '拒绝就什么都不派出去'
        },
        execute: async () => {
          const worker = workerConfigFrom(deps.delegate!.worker)
          if (!worker) {
            return {
              ok: false,
              summary:
                '工作体没有配置：先在设置里填 provider 和 model（例如 eepseek / deepseek-v4-flash）。' +
                '不填就会走 pi 的默认模型，那条路会 401，所以这里不猜默认值。'
            }
          }
          const result = await runProject(
            { name: String(args.name ?? '').trim() || '未命名项目', tasks, mode },
            {
              rootDir: deps.delegate!.rootDir,
              worker,
              mode,
              onProgress: deps.delegate!.onProgress
            }
          )
          const artifacts: string[] = []
          for (const t of result.project.tasks) {
            artifacts.push(...(await taskArtifacts(result.projectRoot, t)))
          }
          const lines = result.taskStates
            .map((t) => `${t.status === 'done' ? '✓' : '✗'} ${t.title}（${t.status}）${t.reason ? `：${t.reason}` : ''}`)
            .join('\n')
          const done = result.taskStates.filter((t) => t.status === 'done').length
          const failed = result.taskStates.filter((t) => t.status !== 'done').map((t) => t.title)
          return {
            ok: result.ok,
            summary: `${result.summary}\n${lines}\n目录：${result.projectRoot}`,
            // 事实是逐条验收的计数，不是"跑完了"这件事本身
            verify: {
              state: result.ok ? 'confirmed' : 'mismatch',
              fact: `${done}/${result.taskStates.length} 个任务的验收通过${
                failed.length > 0 ? `；没过的：${failed.join('、')}` : ''
              }`
            },
            data: { ...result, artifacts },
            evidence: [
              {
                id: randomUUID().slice(0, 8),
                type: 'local',
                title: `派发项目：${String(args.name ?? '').trim() || '未命名项目'}`,
                detail: `${result.concurrency === 1 ? '串行' : `并行 ${result.concurrency} 路`} · ${result.taskStates.length} 个任务 · 目录 ${result.projectRoot}`,
                at: new Date().toISOString()
              }
            ]
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'run_project 必须先解析出计划（plan），直接 run 不会被放行' }
    }
  }

  /**
   * GitHub 搜索：只读，但检索词会发出去。
   *
   * 为什么不让模型用 web_search 代替：GitHub 搜索结果里有 star、许可证、
   * 最后推送时间——判断"这个项目还能不能用"全靠这三个字段，网页搜索给不了。
   */
  const githubSearchTool: ToolDef = {
    name: 'github_search',
    label: '搜索 GitHub 仓库（只读）',
    description:
      '在 GitHub 上搜仓库，返回 star 数、语言、许可证、最后推送日期。用户问"有没有现成的开源项目""哪个库最靠谱""这个方案别人做过吗"时用它，**用它而不是 web_search**——star 和最后推送日期是判断项目能不能用的关键，网页搜索拿不到。默认按 star 排序。只读，不发任何本机文件，只发检索词。',
    effect: 'read',
    auditKind: 'web',
    // 检索词会发到本机之外：本轮读过邮件之后，这类调用要先让用户确认
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，支持 GitHub 查询语法（如 language:typescript stars:>100）' },
        max: { type: 'number', description: '返回条数，默认 5，最多 10' },
        sort: { type: 'string', enum: ['stars', 'updated'], description: '排序：stars（默认）或 updated' }
      },
      required: ['query']
    },
    describeTarget: (args) => ({
      title: `搜索 GitHub：${String(args.query ?? '').slice(0, 40)}`,
      target: String(args.query ?? ''),
      impact: '只读检索，只把检索词发给 GitHub，不发送任何本机文件'
    }),
    run: async (args): Promise<ToolResult> => {
      const ready = await ghReady()
      if (!ready.ok) return { ok: false, summary: ready.reason ?? 'gh 不可用' }

      const query = String(args.query ?? '').trim()
      const outcome = await searchRepos(query, {
        max: Number(args.max) || 5,
        sort: args.sort === 'updated' ? 'updated' : 'stars'
      })
      if (!outcome.ok) return { ok: false, summary: `GitHub 搜索失败：${outcome.error ?? '未知原因'}` }
      if (outcome.repos.length === 0) {
        return { ok: true, summary: `GitHub 上没有匹配「${query}」的仓库`, data: { repos: [] } }
      }
      const lines = outcome.repos.map(
        (r, i) =>
          `${i + 1}. ${r.full_name} ★${r.stargazers_count} · ${r.language ?? '未知语言'} · ${r.license?.spdx_id ?? '无许可证'} · 最后推送 ${r.pushed_at.slice(0, 10)}\n   ${r.description ?? '（无描述）'}\n   ${r.html_url}`
      )
      return {
        ok: true,
        summary: `GitHub 上找到 ${outcome.repos.length} 个：\n${lines.join('\n')}`,
        data: { repos: outcome.repos },
        evidence: outcome.repos.map((r, i) => ({
          id: `${i}-${r.full_name}`.slice(0, 20),
          type: 'web' as const,
          title: `${r.full_name} ★${r.stargazers_count}`,
          detail: r.description ?? undefined,
          url: r.html_url,
          at: new Date().toISOString()
        }))
      }
    }
  }

  /**
   * GitHub 上传：真写，而且删不掉。
   *
   * 带 requiresConfirmation：上传用的是用户的 `repo` 权限，等于能往他所有仓库写东西。
   * 所以必须过卡、永不「始终允许」，而且只允许传沙箱/编排产出里的文件
   * （见 github.ts 的 assertUploadableFile）——不给"随便传一个路径"的能力。
   */
  const githubUploadTool: ToolDef = {
    name: 'github_upload',
    label: '上传到 GitHub（需授权）',
    description:
      '把一个文件传到 GitHub 仓库（新建或覆盖同一个路径）。用 Contents API，不需要本地 clone，一次一个提交。**上传后删不掉**——只能再传一次覆盖，或者去 GitHub 上手工删。只能上传沙箱目录或编排产出里的文件，不能传任意路径。用户没有明确说要上传前不要调用。',
    effect: 'write',
    requiresConfirmation: true,
    allowAlways: false,
    auditKind: 'web',
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要上传的本地文件绝对路径，必须在沙箱目录或编排产出目录里' },
        repo: { type: 'string', description: '目标仓库，形如 owner/name' },
        remotePath: { type: 'string', description: '仓库内的路径，如 reports/2026-11-10.md' },
        message: { type: 'string', description: '提交说明' },
        branch: { type: 'string', description: '目标分支，默认 main' }
      },
      required: ['file', 'repo', 'remotePath']
    },
    describeTarget: (args) => {
      const repo = String(args.repo ?? '').trim() || '（未指定仓库）'
      const remote = String(args.remotePath ?? '').trim() || '（未指定路径）'
      return {
        title: `上传到 GitHub：${repo}`,
        target: `${repo} / ${remote}`,
        impact:
          '会把文件内容发到 GitHub 上，**而且是公开可见的**（如果那个仓库是公开的）。' +
          '上传后删不掉——只能再传一次覆盖，或去 GitHub 手工删。',
        undoHint: '拒绝就什么都不上传'
      }
    },
    run: async (args): Promise<ToolResult> => {
      if (!deps.uploadRoots || deps.uploadRoots.length === 0) {
        return { ok: false, summary: '当前环境不支持上传（没有注入可上传目录）' }
      }
      const file = String(args.file ?? '').trim()
      const check = assertUploadableFile(file, deps.uploadRoots)
      if (!check.ok) return { ok: false, summary: check.reason ?? '这个文件不允许上传' }

      const repo = String(args.repo ?? '').trim()
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return { ok: false, summary: `仓库名要写成 owner/name，收到的是「${repo}」` }
      }
      const remotePath = String(args.remotePath ?? '').trim().replace(/^\/+/, '')
      if (!remotePath || remotePath.includes('..')) {
        return { ok: false, summary: '仓库内路径不合法（不能为空、不能含 ..）' }
      }

      const result = await uploadFile({
        file,
        repo,
        remotePath,
        message: String(args.message ?? '').trim() || `上传 ${path.basename(file)}`,
        branch: String(args.branch ?? '').trim() || undefined
      })
      return {
        ok: result.ok,
        summary: result.summary,
        undo: result.undoHint,
        evidence: result.url
          ? [{ id: 'gh', type: 'web' as const, title: `上传到 ${repo}`, url: result.url, at: new Date().toISOString() }]
          : undefined
      }
    },
    /**
     * 事后核对：回读远端那个路径，比对 git blob sha。
     *
     * 这一条尤其不能省：上传是**删不掉**的写。gh 报成功、实际上没上去
     * （分支名写错、仓库只读、企业策略拦了）都实际发生过，而用户看到的
     * 是一句"已上传"，转身去找文件找不到。
     */
    verify: async (args) => {
      const repo = String(args.repo ?? '').trim()
      const remotePath = String(args.remotePath ?? '').trim().replace(/^\/+/, '')
      const file = String(args.file ?? '').trim()
      const branch = String(args.branch ?? '').trim() || undefined
      const checked = await verifyRemoteFile({ repo, remotePath, branch, file })
      if (!checked.ok) {
        // 回读失败不等于没传上去（网络、限流都会这样），所以不当成 mismatch
        return { state: 'unavailable', fact: `回读远端失败，无法确认：${checked.reason ?? '原因未知'}` }
      }
      if (checked.sha && checked.localSha && checked.sha === checked.localSha) {
        return {
          state: 'confirmed',
          fact: `回读了 ${repo}/${remotePath}：远端那份的 sha 与本地文件算出的一致（${checked.size ?? 0} 字节）`
        }
      }
      return {
        state: 'mismatch',
        fact: `回读了 ${repo}/${remotePath}：远端 sha ${checked.sha ?? '（空）'} 与本地算出的 ${checked.localSha ?? '（空）'} 不一致，那一份不是这次要传的文件`
      }
    }
  }

  const listApps: ToolDef = {
    name: 'list_installed_apps',
    label: '读取已安装程序清单',
    description:
      '读取本机已安装程序清单（来自注册表 Uninstall 键，只读）。可回答"装了什么、版本、发布者、装在哪、什么时候装的"。**回答"这个程序是干什么的"时，只能用这些注册表字段**（发布者、安装位置、注册表里的产品网址）；字段说明不了就如实说没有登记说明，不要自己从目录名或图标去猜它是干嘛的——要查它是什么软件，用 web_search 或 github_search。installedByButler 非空表示这个程序是管家装的，值就是当时的安装时间。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按名称或发布者做包含匹配，留空返回全部' },
        include_system: { type: 'boolean', description: '是否包含系统组件，默认 false' },
        limit: { type: 'number', description: '最多返回多少条，默认 40' }
      }
    },
    describeTarget: (args) => {
      const query = String(args.query ?? '').trim()
      return {
        title: query ? `读取程序清单（筛选：${query}）` : '读取已安装程序清单',
        target: query || '全部已安装程序',
        impact: '只读注册表，不改动任何东西'
      }
    },
    run: async (args): Promise<ToolResult> => {
      const { apps, durationMs } = await listInstalledApps()
      // 管家装过的程序（显示名 → 安装时间）：台账据此回答"这个是管家装的吗"
      let installs: Record<string, string> = {}
      try {
        installs = (await deps.butlerInstalls?.()) ?? {}
      } catch {
        installs = {}
      }
      const query = String(args.query ?? '').trim().toLowerCase()
      const includeSystem = args.include_system === true
      const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 200)
      const filtered = apps.filter((a) => {
        if (!includeSystem && a.systemComponent === 1) return false
        if (!query) return true
        return a.name.toLowerCase().includes(query) || a.publisher.toLowerCase().includes(query)
      })
      return {
        ok: true,
        summary: `共 ${apps.length} 个程序，其中系统组件 ${apps.filter((a) => a.systemComponent === 1).length} 个；本次返回 ${Math.min(filtered.length, limit)} 条`,
        data: filtered.slice(0, limit).map((a) => ({
          name: a.name,
          version: a.version,
          publisher: a.publisher,
          installLocation: a.installLocation,
          installDate: formatInstallDate(a.installDate),
          installedByButler: installs[a.name] ?? null,
          sizeMB: a.sizeKB ? Math.round((a.sizeKB / 1024) * 10) / 10 : null
        })),
        evidence: [
          ev({
            type: 'local',
            title: `本机程序清单（${apps.length} 条）`,
            detail: `注册表 Uninstall 键 · 只读 · 耗时 ${durationMs || '<1'} ms`
          })
        ]
      }
    }
  }

  const listStartup: ToolDef = {
    name: 'list_startup_items',
    label: '读取开机启动项',
    description:
      '读取本机开机自启项（注册表 Run/RunOnce、启动文件夹、非微软计划任务，只读）。可回答"开机会自己起来什么"。返回不含"是否应当关闭"的判断。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'registry / startup-folder / scheduled-task，留空返回全部' },
        limit: { type: 'number', description: '最多返回多少条，默认 20（清单可能很长，超过部分需要分页）' },
        offset: { type: 'number', description: '从第几条开始，默认 0' }
      }
    },
    describeTarget: () => ({
      title: '读取开机启动项清单',
      target: '注册表 Run 键 + 启动文件夹 + 计划任务',
      impact: '只读，不改动任何启动项'
    }),
    run: async (args): Promise<ToolResult> => {
      const { items, durationMs } = await listStartupItems()
      const kind = String(args.kind ?? '').trim()
      const filtered = kind ? items.filter((i) => i.kind === kind) : items
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100)
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const page = filtered.slice(offset, offset + limit)
      const group = (k: string) => items.filter((i) => i.kind === k).length
      return {
        ok: true,
        summary: `共 ${items.length} 个启动项（注册表 ${group('registry')} / 启动文件夹 ${group('startup-folder')} / 计划任务 ${group('scheduled-task')}）；本次返回第 ${offset + 1}–${offset + page.length} 条${offset + page.length < filtered.length ? '，还有更多可继续分页' : ''}`,
        data: page.map((i) => ({ name: i.name, command: i.command, source: i.source, kind: i.kind })),
        evidence: [
          ev({
            type: 'local',
            title: `本机启动项清单（${items.length} 条）`,
            detail: `注册表 Run 键 + 启动文件夹 + 计划任务 · 只读 · 耗时 ${durationMs || '<1'} ms`
          })
        ]
      }
    }
  }

  /**
   * 卸载结果的核对：读一次卸载前的快照，跟"现在"比一遍。
   *
   * 为什么要单独有这个工具：`uninstall_app` 当场只能标 unavailable——卸载是用户在
   * 那个窗口里点完的，我们拉起它就交出去了。可"我无法确认"不该是终点：
   * 快照已经存下来了，缺的只是让模型之后能自己去读。没有这个工具，
   * 用户问"卸干净了没"时它只能回答"去记录页点按钮"，那句话是把活推回给人。
   */
  const checkUninstallTool: ToolDef = {
    name: 'check_uninstall_state',
    label: '核对卸载结果（只读）',
    description:
      '拿卸载前的快照跟现在的机器比一遍，回答"卸干净了没、还剩什么"。只读，不改动任何东西。只能核对**管家启动过卸载程序**的那些程序——没走过这一趟的没有快照，如实说不知道。不传参数就是最近一次卸载；要查别的程序就传程序名。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: '程序名（显示名或其中一段），留空=最近一次卸载' },
        snapshotId: { type: 'string', description: '直接指定某次卸载的快照 id（一般用不到）' }
      }
    },
    describeTarget: (args) => {
      const name = String(args.appName ?? '').trim()
      return {
        title: name ? `核对卸载结果（${name}）` : '核对最近一次卸载',
        target: name || '最近一次卸载',
        impact: '只读快照与注册表，不改动任何东西'
      }
    },
    run: async (args): Promise<ToolResult> => {
      if (!deps.listSnapshots) return { ok: false, summary: '当前环境读不到卸载快照' }

      let snapshots: AppSnapshot[]
      try {
        snapshots = await deps.listSnapshots()
      } catch (err) {
        return { ok: false, summary: `读取卸载快照失败：${err instanceof Error ? err.message : String(err)}` }
      }

      const wanted = String(args.appName ?? '').trim()
      const byId = String(args.snapshotId ?? '').trim()
      const picked = byId ? snapshots.find((item) => item.id === byId) ?? null : pickSnapshot(snapshots, wanted)

      if (!picked) {
        // 三种"查不到"，说清是哪种：没卸过 / 名字对不上多条 / 指定的 id 不存在
        if (snapshots.length === 0) {
          return {
            ok: false,
            summary:
              '还没有任何卸载前的快照，所以核对不了。只有管家启动过程序自己的卸载程序，才会有这份快照；没走过这一趟的，我只能说不知道'
          }
        }
        const names = [...new Set(snapshots.map((item) => item.appName))].slice(0, 8).join('、')
        return {
          ok: false,
          summary: byId
            ? `没有 id 为 ${byId} 的快照。手上有这些程序的快照：${names}`
            : `「${wanted}」对不上唯一一份快照（可能是同名多份，或者名字不一样）。手上有这些程序的快照：${names}——要查哪一个就按名字告诉我`
        }
      }

      let diff
      try {
        diff = await diffSnapshot(picked)
      } catch (err) {
        return { ok: false, summary: `对比没能跑完：${err instanceof Error ? err.message : String(err)}` }
      }

      const leftover: string[] = []
      if (diff.registryStillThere) leftover.push('注册表卸载项还在')
      if (diff.installDirStillThere) leftover.push(`安装目录还在（${Math.round(diff.bytesNow / 1024 / 1024)} MB、${diff.filesNow} 个文件）`)
      if (diff.startupStillThere.length > 0) leftover.push(`自启项还在 ${diff.startupStillThere.length} 个`)
      if (diff.residualLeft.length > 0) leftover.push(`数据目录残留 ${diff.residualLeft.length} 处`)

      return {
        ok: true,
        summary: `${picked.appName}（卸载前快照 ${picked.takenAt}）：${diff.verdict}`,
        data: {
          appName: diff.appName,
          snapshotTakenAt: diff.takenAt,
          registryStillThere: diff.registryStillThere,
          installDirStillThere: diff.installDirStillThere,
          filesBefore: diff.filesBefore,
          filesNow: diff.filesNow,
          startupGone: diff.startupGone,
          startupStillThere: diff.startupStillThere,
          residualLeft: diff.residualLeft,
          leftover,
          verdict: diff.verdict
        },
        evidence: [
          ev({
            type: 'local',
            title: `卸载对比：${picked.appName}`,
            detail: `快照 ${picked.takenAt} · 注册表 / 安装目录 / 开机自启项 · 只读`
          })
        ]
      }
    }
  }

  const webSearch: ToolDef = {
    name: 'web_search',
    label: '联网检索',
    description:
      '联网检索公开网页，返回标题、地址与摘要。凡是需要外部信息（软件是做什么的、有没有现成开源项目、某事实是否成立）都必须先调用它；不要用记忆里的知识代替检索。',
    effect: 'read',
    auditKind: 'web',
    // 检索词会发到本机之外：本轮读过邮件之后，这类调用要先让用户确认
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，可用 site: 限定站点' },
        max: { type: 'number', description: '返回条数，默认 5，最多 8' }
      },
      required: ['query']
    },
    describeTarget: (args) => ({
      title: `联网检索：${String(args.query ?? '').slice(0, 40)}`,
      target: String(args.query ?? ''),
      impact: '只读联网，不提交任何本机数据'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, summary: '检索词为空' }
      const max = Math.min(Math.max(Number(args.max ?? 5), 1), 8)
      const outcome = await searchWeb(query, ctx.config, ctx.signal)
      if (!outcome.ok) {
        // 三种失败要说三种话：说成"不存在"会让用户放弃寻找，说成"被限流"要他去重试
        const guidance =
          outcome.failureKind === 'rate-limited'
            ? '这时**不要说「查不到」或「没有这个东西」**——要告诉用户「检索可能被限流了，过一会儿再试」，并说明这不代表内容不存在。'
            : outcome.failureKind === 'blocked'
              ? '这时要说「检索被挡下了」，建议换网络环境或在设置里配一个带 Key 的检索源（Serper / Tavily）。不要凭记忆补全。'
              : '这时应当向用户说明「查不到」，不要凭记忆补全。'
        return {
          ok: false,
          summary: `${outcome.error ?? '检索失败'}。${guidance}`,
          data: { failureKind: outcome.failureKind ?? 'no-results', retryable: outcome.failureKind === 'rate-limited' }
        }
      }
      const hits = outcome.hits.slice(0, max)
      const sourceNote = outcome.note ? `（${outcome.note}）` : ''
      return {
        ok: true,
        summary: `检索到 ${outcome.hits.length} 条结果（来源：${outcome.provider}）${sourceNote}。摘要可能不完整，结论前建议对关键页面调用 web_fetch 核对。`,
        data: hits.map((h: SearchHit) => ({ title: h.title, url: h.url, snippet: h.snippet.slice(0, 260) })),
        evidence: hits.slice(0, 3).map((h) =>
          ev({
            type: 'web',
            title: h.title || h.url,
            url: h.url,
            detail: `检索命中 · ${outcome.provider} · 未读全文`
          })
        )
      }
    }
  }

  const webFetch: ToolDef = {
    name: 'web_fetch',
    label: '打开网页核对',
    description:
      '打开一个具体网页并提取正文（只读，最多 4000 字）。用于核对检索摘要、读官方文档原文。网页打不开或内容为空时，如实报告失败。',
    effect: 'read',
    auditKind: 'web',
    // URL 本身就是外发通道：把邮件原文拼进查询串就能带走，必须过确认
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 http/https 地址' } },
      required: ['url']
    },
    describeTarget: (args) => ({
      title: `打开网页：${String(args.url ?? '').slice(0, 60)}`,
      target: String(args.url ?? ''),
      impact: '只读抓取正文'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '地址无效，只支持 http/https' }
      try {
        const page = await fetchPage(url, ctx.signal)
        if (page.caveat) {
          // 读到了字但没读到正文：必须说清楚，否则模型会拿站点口号或排版碎片当内容总结
          return {
            ok: true,
            summary: `打开了 ${new URL(page.finalUrl).host}，但没读到正文：${page.caveat}。抓到的是这 ${page.text.length} 字：${page.text.slice(0, 120)}……此时应当告诉用户「这页我读不到正文」，不要拿这些字当页面内容回答。`,
            data: { title: page.title, url: page.finalUrl, text: page.text, caveat: page.caveat, readable: false },
            evidence: [
              ev({
                type: 'web',
                title: page.title,
                url: page.finalUrl,
                detail: `未读到正文 · ${page.caveat}`
              })
            ]
          }
        }
        return {
          ok: true,
          summary: `已读取 ${new URL(page.finalUrl).host} 的正文 ${page.text.length} 字（标题：${page.title}）`,
          data: { title: page.title, url: page.finalUrl, text: page.text, readable: true },
          evidence: [
            ev({
              type: 'web',
              title: page.title,
              url: page.finalUrl,
              detail: `已读取正文 · ${page.text.length} 字`
            })
          ]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, summary: `网页打不开：${message}。不要猜测页面内容。` }
      }
    }
  }

  const openSettings: ToolDef = {
    name: 'open_settings_page',
    label: '打开系统设置页',
    description:
      '在系统里打开一个设置页面，让用户自己点开关（apps=已安装应用 / startup=启动应用 / privacy=隐私 / storage=存储）。这是"只打开页面、不替你改设置"的做法。',
    effect: 'ui',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'apps / startup / privacy / storage' },
        reason: { type: 'string', description: '为什么打开这个页面，一句话' }
      },
      required: ['page']
    },
    describeTarget: (args) => ({
      title: `打开「设置 → ${String(args.page ?? '')}」`,
      target: String(args.page ?? ''),
      impact: '只打开页面，不改任何设置'
    }),
    run: async (args): Promise<ToolResult> => {
      const key = String(args.page ?? '').toLowerCase()
      const target = SETTINGS_PAGES[key]
      if (!target) return { ok: false, summary: `未知设置页：${key}` }
      const reason = String(args.reason ?? '').slice(0, 80)
      if (!deps.openSettings) return { ok: false, summary: '当前环境不能打开系统设置页' }
      await deps.openSettings(target)
      return {
        ok: true,
        summary: `已打开系统设置页（${key}）。管家没有改动任何设置。`
      }
    }
  }

  // ---- 授权闸门演练用的沙箱工具（作用域写死在 %TEMP%\butler-sandbox） ----

  const listSandboxTool: ToolDef = {
    name: 'list_sandbox_files',
    label: '查看演示沙箱',
    description:
      '列出演示沙箱目录里的文件（只读）。沙箱是给"删除能力"做演示用的隔离目录，路径固定在系统临时目录下。',
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    describeTarget: () => ({
      title: '查看演示沙箱文件',
      target: SANDBOX_ROOT,
      impact: '只读列目录'
    }),
    run: async (): Promise<ToolResult> => {
      const files = await listSandbox()
      return {
        ok: true,
        summary: `演示沙箱里有 ${files.length} 个文件（${SANDBOX_ROOT}）`,
        data: files.map((f) => ({ name: f.name, path: f.path, sizeKB: f.sizeKB })),
        evidence: [
          ev({ type: 'local', title: `演示沙箱清单（${files.length} 个文件）`, detail: SANDBOX_ROOT })
        ]
      }
    }
  }

  const deleteToRecycleTool: ToolDef = {
    name: 'delete_to_recycle',
    label: '删除到回收站（需授权）',
    description:
      '把**演示沙箱**里的一个文件移到系统回收站（可还原）。这是销毁类操作，必须先经用户授权，授权卡没点通过就不会执行；沙箱外的路径一律拒绝。用户没有明确同意前不要调用。',
    effect: 'destroy',
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内文件的完整路径（先用 list_sandbox_files 查）' },
        reason: { type: 'string', description: '为什么要删，一句话' }
      },
      required: ['path']
    },
    describeTarget: (args) => {
      const name = path.basename(String(args.path ?? '(未指定)'))
      return {
        title: `删除到回收站：${name}`,
        target: String(args.path ?? ''),
        impact: '从演示沙箱移到系统回收站；可以从回收站还原，但不会留在原处',
        undoHint: '回收站还原'
      }
    },
    /**
     * 事后核对：自己再去 stat 一次那个路径。
     *
     * 回收站的 PowerShell 脚本会回报"成功"，可它回报的是它自己那一步的结果；
     * 文件到底还在不在，只能由另一次读取来回答。**还在原处**就按 mismatch 报
     * （脚本说删了、文件说没有），不替它圆。
     */
    verify: async (args) => {
      const target = String(args.path ?? '').trim()
      try {
        await fs.lstat(target)
        return { state: 'mismatch', fact: `重新查了一次：「${path.basename(target)}」还在原处` }
      } catch {
        return { state: 'confirmed', fact: `重新查了一次：原路径上已经没有「${path.basename(target)}」` }
      }
    },
    run: async (args): Promise<ToolResult> => {
      const target = String(args.path ?? '').trim()
      if (!target) return { ok: false, summary: '没有给出要删除的文件路径' }
      try {
        const outcome = await deleteToRecycle(target)
        if (!outcome.ok) {
          return { ok: false, summary: `删除没有生效：${outcome.error ?? '原因未知'}，文件应该还在原处` }
        }
        return {
          ok: true,
          summary: `已把「${outcome.name}」（${outcome.sizeKB} KB）移入系统回收站，可以从回收站还原`,
          undo: '回收站还原',
          data: { name: outcome.name, sizeKB: outcome.sizeKB, recycled: true },
          evidence: [
            ev({
              type: 'local',
              title: `删除到回收站：${outcome.name}`,
              detail: `${outcome.sizeKB} KB · 用户授权后执行 · 可还原`
            })
          ]
        }
      } catch (err) {
        return {
          ok: false,
          summary: `没有执行：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  }

  const readEmailTool: ToolDef = {
    name: 'read_email',
    label: '读取邮件（只读）',
    description:
      '读取用户邮箱：mode=list 拉最近的邮件列表（谁发的、主题、时间、200 字摘要、是否已读、来自哪个账号）；mode=read 用列表返回的 uid 拉单封正文。IMAP 只读——不标记已读、不删信、不发信。支持多个邮箱账号（设置里配置）：account 参数传账号显示名或地址，不传用默认账号；列表返回里有 account 字段标明来源，回答多账号问题时必须区分。涉及"谁发来的 / 要不要紧 / 邮件说了什么"的问题用它；没配置邮箱时如实说去设置里配。',
    effect: 'read',
    // 邮件正文是用户私密内容：读过之后本轮就算被污染，后续外发一律要确认
    readsPrivateData: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'list=最近邮件列表（默认）；read=读单封正文' },
        uid: { type: 'number', description: 'mode=read 时必填，来自列表返回的 uid' },
        limit: { type: 'number', description: 'mode=list 时返回几封，默认 10，最多 30' },
        account: { type: 'string', description: '邮箱账号（显示名或地址），不传用默认账号' }
      }
    },
    describeTarget: (args) => ({
      title: String(args?.mode ?? 'list') === 'read' ? `读取邮件正文（uid ${args?.uid ?? '?'}）` : '读取最近邮件列表',
      target: args?.account ? `收件箱（IMAP 只读 · 账号 ${args.account}）` : '收件箱（IMAP 只读）',
      impact: '只读：不标记已读、不删除、不发信'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const mode = String(args.mode ?? 'list')
      const accountRef = typeof args.account === 'string' && args.account.trim() ? args.account.trim() : undefined
      try {
        if (mode === 'read') {
          const uid = Number(args.uid)
          if (!Number.isFinite(uid) || uid <= 0) {
            return { ok: false, summary: 'mode=read 需要有效的 uid：先调 read_email(mode=list) 拿到再读单封' }
          }
          const mail = await readMailBody(ctx.config, uid, accountRef)
          return {
            ok: true,
            summary: `已读取「${mail.subject}」（来自 ${mail.from} · 账号 ${mail.account}，IMAP 只读）`,
            data: mail,
            evidence: [
              ev({
                type: 'local',
                title: `读取邮件：${mail.subject}`,
                detail: `IMAP 只读 · 来自 ${mail.fromAddress} · ${new Date(mail.date).toLocaleString('zh-CN')}`
              })
            ]
          }
        }
        const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 30)
        const mails = await listRecentMail(ctx.config, limit, accountRef)
        if (mails.length === 0) return { ok: true, summary: '收件箱是空的（或最近没有邮件）', data: [] }
        const accountNames = [...new Set(mails.map((m) => m.account))]
        return {
          ok: true,
          summary: `读取了最近 ${mails.length} 封邮件（账号 ${accountNames.join('、')}，IMAP 只读）`,
          data: mails,
          evidence: [
            ev({
              type: 'local',
              title: '读取邮件列表',
              detail: `IMAP 只读 · 账号 ${accountNames.join('、')} · 最近 ${mails.length} 封 · 未读 ${
                mails.filter((m) => !m.seen).length
              } 封`
            })
          ]
        }
      } catch (err) {
        return { ok: false, summary: `读取邮件失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }

  /**
   * 打开程序 = 替用户双击开始菜单或桌面上的那个快捷方式。
   *
   * 定 ui 档而不是 install 档：它不安东西、不改注册表、不留痕迹，关掉就恢复原样，
   * 和「打开系统设置页」是同一类动作。真正需要授权的是"改动机器"，不是"看见一个窗口"。
   *
   * 但它也不是完全没有边：只认快捷方式（.lnk，见 node/launch.ts），
   * 而且卸载/修复/更新/命令提示符那几类被排除在外——
   * 「打开哔哩哔哩」不能弹出卸载确认框。
   */
  const launchAppTool: ToolDef = {
    name: 'launch_app',
    label: '打开程序',
    description:
      '打开一个已安装的程序（等价于用户自己双击它的图标），不改动任何东西。用户说"打开哔哩哔哩""把豆包打开""我要玩 ICEY""把计算器打开"时用它。它能开的是这台机器上装着的程序：开始菜单和桌面上的快捷方式、Steam 这类协议启动的游戏、以及系统应用清单里不建快捷方式的程序（商店应用、计算器、记事本等）。**它不打开网页、不打开文件夹**（网页用 web_fetch 取内容，文件夹用 open_folder）。程序名对不上唯一一个时工具会拒绝并列出候选，**这时不要自己挑一个，把名字念给用户让他确认**。如果工具说已经开着，就如实转述"本来就开着、窗口已经叫到前面"，不要说成刚打开。',
    effect: 'ui',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要打开的程序名，就是在开始菜单、桌面上或"所有应用"列表里显示的那个名字' },
        reason: { type: 'string', description: '为什么要打开，一句话' }
      },
      required: ['name']
    },
    plan: async (args): Promise<ToolPlan> => {
      const name = String(args.name ?? '').trim()
      if (!name) return { ok: false, reason: '没有给出要打开的程序名' }
      // 用"现在的"清单解析：缓存的 60 秒里程序可能刚装上/刚卸掉；
      // 快捷方式都找不到时，它还会去问系统应用清单（豆包那类不建快捷方式的程序）
      const planned = await resolveLaunch(name)
      if (!planned.ok) return { ok: false, reason: planned.reason }
      const shortcut = planned.shortcut
      const kind = shortcut.kind ?? 'shortcut'
      return {
        ok: true,
        target: {
          title: `打开：${shortcut.name}`,
          target: kind === 'apps-folder' ? `系统应用清单：${shortcut.path}` : shortcut.path,
          impact: '只是把这个程序启动起来，不改动机器上的任何东西；窗口归你，关掉就行'
        },
        execute: async (): Promise<ToolResult> => {
          /**
           * 已经开着就别再开一份。
           *
           * 判断口径写在 node/running.ts：只认**有可见窗口**的同名进程。
           * 探不到进程表（权限、PowerShell 抽风）时当它没开，照常启动——
           * "多开一个窗口"比"明明没开却说已经开了"轻得多。
           *
           * apps-folder 条目跳过这一步：它们的 AppID（`Doubao.ChatApp`、
           * `Microsoft.WindowsCalculator_...!App`）没法可靠地映射到进程名，
           * 猜错的代价是"用户想开却被告知已经开着"——比多按一次激活重得多。
           * 而这类程序本身多是单实例激活，按第二次通常只是把窗口叫到前面。
           */
          if (deps.probeLaunch && kind !== 'apps-folder') {
            const probe = await deps.probeLaunch(shortcut.path).catch(() => null)
            const open = probe ? findOpenWindow(probe.processes, appIdentity(shortcut, probe.targetPath)) : null
            if (open) {
              const focused = deps.focusApp ? await deps.focusApp(open.pid).catch(() => false) : false
              return {
                ok: true,
                summary: focused
                  ? `「${shortcut.name}」本来就开着，没有再启动一份，已经把它那个窗口叫到前面来了`
                  : `「${shortcut.name}」本来就开着（进程 ${open.name}），没有再启动一份。窗口没被叫到前面来，可能被最小化了或者在别的桌面`,
                evidence: [
                  ev({
                    type: 'local',
                    title: `已经在运行：${shortcut.name}`,
                    detail: `进程 ${open.name}（PID ${open.pid}）· 没有启动第二份 · 不改动机器`
                  })
                ]
              }
            }
          }

          const launch =
            kind === 'apps-folder'
              ? deps.launchAppsFolder
              : deps.launchShortcut
          if (!launch) {
            return {
              ok: false,
              summary:
                kind === 'apps-folder'
                  ? '当前环境不能启动系统应用清单里的程序，可以自己在开始菜单里点开它'
                  : '当前环境不能启动程序（没有可用的桌面外壳），可以自己双击它的图标打开'
            }
          }

          const error = await launch(shortcut.path)
          if (error) {
            return {
              ok: false,
              summary: `没能打开「${shortcut.name}」：${error}。可能是快捷方式已经失效、程序被卸载了但快捷方式还留着，也可能是 Store 应用（MSIX 包）的激活被系统拦下了。如实告诉用户这次没打开，可以让他自己双击图标试试；不要换个名字重试`
            }
          }
          return {
            ok: true,
            summary: `已经打开「${shortcut.name}」（${shortcut.path}）。启动后不会自动关闭，用户可以直接用；如果窗口没出现，可能它要加载几十秒，也可能被最小化到了托盘`,
            evidence: [
              ev({
                type: 'local',
                title: `打开程序：${shortcut.name}`,
                // 写明是从开始菜单还是桌面找到的：同一个程序两处都有时，便于事后核对打开的是哪一份
                detail: `${shortcut.source === 'desktop' ? '桌面' : '开始菜单'}快捷方式 ${shortcut.path} · 不改动机器`
              })
            ]
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'launch_app 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  /**
   * 打开文件夹：用户说"打开桌面上的「应用软件」"时走这条。
   *
   * 和 launch_app 分开是有原因的：文件夹不是快捷方式，开始菜单里根本没有，
   * 硬塞进「打开程序」里会让那个工具既认程序又认目录，最后两边都说不准。
   */
  const openFolderTool: ToolDef = {
    name: 'open_folder',
    label: '打开文件夹',
    description:
      '在资源管理器里打开一个文件夹（等价于用户自己双击它），不改动任何文件。用户说"打开 XX 文件夹"时用它。三种说法都认：光一个名字（桌面/下载/文档/图片/音乐/视频/用户目录、各磁盘根、桌面上的文件夹，以及各盘往下三层、用户目录往下四层的目录）、从认得的目录往下写一截（形如 文档\\报告）、或者完整路径（形如 D:\\资料\\项目）。它只开本机磁盘上的目录：网络共享（\\\\主机\\共享）和单个文件都不开，也不要拿它去"打开"某个 exe。名字对不上唯一一个时会**自动弹出候选卡让用户自己挑**（同一名字在多个盘、多处都有时尤其常见），这时不要自己替用户挑、也不要重复调用；同一个名字既指系统目录又指别处时，打的是系统目录（"图片"就是图片库）。',
    effect: 'ui',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件夹名字（如「应用软件」「下载」）、从认得的目录往下写一截（如「文档\\报告」）、或完整路径（如 D:\\资料\\项目）' },
        reason: { type: 'string', description: '为什么要打开，一句话' }
      },
      required: ['name']
    },
    plan: async (args): Promise<ToolPlan> => {
      const query = String(args.name ?? '').trim()
      if (!query) return { ok: false, reason: '没有给出要打开的文件夹' }
      // 每次现扫：桌面上的文件夹是用户随手建的，缓存一分钟会让"刚建好的找不到"
      const planned = planFolder(query)
      if (!planned.ok) {
        /**
         * 名字对上了好几个 → 做成可点的候选卡，而不是让模型念一段候选再等用户重说一遍。
         *
         * 用户报「kcareone」时，D 盘下确实有 KCareOne-ALL / -MAIN / -SQL / -TPS 四条，
         * 谁也不知道他要的是哪个——念一段文字过去，他得再用一句话描述，来回两三轮；
         * 卡片上点一下就到了。
         *
         * 写回的是**完整路径**（不是名字）：重新 plan 时它走"给的就是路径"那条分支，
         * 落到哪一个不依赖候选集有没有变。闸门还会核对解析出的目标里含不含这个路径
         * （K7），所以"点的是 D:\KCareOne-ALL，开的是别处"这种缝补不上。
         */
        const pool = planned.candidates ?? []
        if (pool.length > 1) {
          const options = pool.slice(0, 8).map((c) => ({
            value: c.path,
            label: c.name,
            detail: c.path
          }))
          return {
            ok: false,
            reason: `有 ${pool.length} 个叫「${query}」的文件夹，等用户在候选卡上选`,
            choice: {
              title: `要打开哪一个「${query}」？`,
              hint:
                pool.length > options.length
                  ? `找到 ${pool.length} 个，只列前 ${options.length} 个。点一下就在资源管理器里打开，不看里面的文件。`
                  : `找到 ${pool.length} 个，点一下就在资源管理器里打开，不改动里面的任何文件。`,
              pickInto: 'name',
              options
            }
          }
        }
        return { ok: false, reason: planned.reason }
      }
      const folder = planned.folder
      return {
        ok: true,
        target: {
          title: `打开文件夹：${folder.name}`,
          target: folder.path,
          impact: '只在资源管理器里打开这个文件夹，不移动、不改动里面的任何文件'
        },
        execute: async (): Promise<ToolResult> => {
          if (!deps.openFolder) {
            return { ok: false, summary: '当前环境不能打开文件夹（没有可用的桌面外壳），可以自己在资源管理器里打开' }
          }
          const error = await deps.openFolder(folder.path)
          if (error) {
            return {
              ok: false,
              summary: `没能打开「${folder.name}」：${error}。如实告诉用户这次没打开，不要换个名字重试`
            }
          }
          return {
            ok: true,
            summary: `已经在资源管理器里打开「${folder.name}」（${folder.path}）。只是打开了这个文件夹，没有改动里面的任何文件`,
            evidence: [
              ev({ type: 'local', title: `打开文件夹：${folder.name}`, detail: `${folder.path} · 不改动文件` })
            ]
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'open_folder 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  /**
   * 打开一个文件 = 替用户双击它。
   *
   * 和 open_folder 是一对，但边界不同：那边只认目录，这边只认文件。
   * 而"双击一个文件"在 Windows 上对某些后缀是**执行**——.exe 是运行、.ps1 是跑脚本、
   * .lnk 是顺着跳到别处、.reg 是改注册表。这类后缀在这里直接拒掉：
   * 要开程序走 launch_app（那条路有自己的门槛和候选卡），不从这里绕进来。
   *
   * 定 ui 档：打开一个文档不改动机器，和"打开设置页""打开文件夹"是同一类。
   */
  const openFileTool: ToolDef = {
    name: 'open_file',
    label: '打开文件',
    description:
      '用系统默认程序打开一个文件（相当于用户自己双击它），不改动文件内容。用户说"把那个 Word 打开""打开桌面的报告.pdf""我要看那张表"时用它。三种说法都认：完整路径（D:\\资料\\报告.docx）、从认得的目录往下写（文档\\报告.docx）、光一个文件名（报告.docx，只在桌面/下载/文档里找）。同名有多个时**会自动弹候选卡让用户挑**，这时不要自己选、也不要重复调用。它**不执行程序**：exe / bat / cmd / ps1 / lnk / msi / reg 这类会执行的后缀会被拒绝（开程序要用 launch_app），也不打开文件夹（用 open_folder）和网络共享。用户要的是"读出内容并总结"时用 read_file，不要用这个。',
    effect: 'ui',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径或文件名（如「报告.docx」「文档\\报告.docx」「D:\\资料\\报告.docx」）' },
        reason: { type: 'string', description: '为什么要打开，一句话' }
      },
      required: ['path']
    },
    plan: async (args): Promise<ToolPlan> => {
      const query = String(args.path ?? '').trim()
      if (!query) return { ok: false, reason: '没有给出要打开的文件' }
      const planned = planFile(query)
      if (!planned.ok) {
        const pool = planned.candidates ?? []
        if (pool.length > 1) {
          const options = pool.slice(0, 8).map((f) => ({ value: f.path, label: f.name, detail: f.path }))
          return {
            ok: false,
            reason: `有 ${pool.length} 个叫「${query}」的文件，等用户在候选卡上选`,
            choice: {
              title: `要打开哪一个「${query}」？`,
              hint: `找到 ${pool.length} 个。点一下就用默认程序打开，不看也不改里面的内容。`,
              pickInto: 'path',
              options
            }
          }
        }
        return { ok: false, reason: planned.reason }
      }
      const file = planned.file
      if (isExecutableFile(file.path)) {
        return {
          ok: false,
          reason: `「${file.name}」是会执行的文件（不是文档），双击它等于运行它。要开程序用 launch_app，要读它的内容用 read_file；这里不替你执行`
        }
      }
      return {
        ok: true,
        target: {
          title: `打开文件：${file.name}`,
          target: file.path,
          impact: '只是用系统默认程序把它打开，不改动文件内容'
        },
        execute: async (): Promise<ToolResult> => {
          if (!deps.openFile) {
            return { ok: false, summary: '当前环境不能打开文件（没有可用的桌面外壳），可以自己在资源管理器里双击它' }
          }
          const error = await deps.openFile(file.path)
          if (error) {
            return {
              ok: false,
              summary: `没能打开「${file.name}」：${error}。如实告诉用户这次没打开，不要换个名字重试`
            }
          }
          return {
            ok: true,
            summary: `已经用系统默认程序打开「${file.name}」（${file.path}）。只是打开了它，没有改动内容`,
            evidence: [ev({ type: 'local', title: `打开文件：${file.name}`, detail: `${file.path} · 不改动内容` })]
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'open_file 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  /**
   * 读一个文件的内容，交给模型看。
   *
   * **读完要总结**是这个工具存在的主要理由：用户说"看看这个文件写了什么""帮我总结这份材料"，
   * 光把文件打开给他看是没用的——他自己会点。真正的价值是把字读出来、压缩成结论。
   *
   * 三个设计取舍：
   * 1. `readsPrivateData`：读到的可能是合同、账单、密钥。读过之后本轮就算被污染，
   *    后面任何往外发的动作（web_search / web_fetch）都要先弹一张确认卡。
   *    没有这道闸，「读桌面那个 docx」+「搜一下里面的公司名」就能把文件内容送出去。
   * 2. **分段读**：默认一次 3200 字，返回 totalChars 和 nextOffset。长文件只读了一段时，
   *    模型必须照着说"只读了前 X 字"，而不是拿前面一小段编出全文结论。
   * 3. **读不了就说读不了**：图片、压缩包一律如实拒绝；老式 .doc/.xls 和 PDF 只读得出字，
   *    加密的、扫描件、没有 ToUnicode 的字体也会明说读不出。
   *    绝不吐一段乱码。读错比不读糟得多——错的内容会被当成事实讲给用户。
   */
  const readFileTool: ToolDef = {
    name: 'read_file',
    label: '读取文件内容（只读）',
    description:
      '把一个文件的文字内容读出来，交给模型阅读和总结。用户说"看看这个文件写了什么""总结一下这份材料""这份文档讲了啥""这几个数字对不对"时用它，**用它而不是 open_file**——用户要的是结论，不是自己盯着屏幕看。三种说法都认：完整路径、从认得的目录往下写（文档\\报告.docx）、光一个文件名（只在桌面/下载/文档里找）；同名多个会弹候选卡让用户挑。能读的是纯文本（txt/md/csv/json/代码/日志等，UTF-8 和 GBK 都能认）、Office 文档（.docx / .xlsx / .pptx）、PDF 的文字层，以及 2003 那种老格式的 .doc/.xls/.ppt。**图片、压缩包、音视频读不了**；PDF 如果是扫描件（整页是图）或者字体不带 ToUnicode 表，老 .doc/.xls/.ppt 如果是加密的或者文档基本是空的，也读不出字来——这些情况结果里会说明。读不了时工具会如实说明，这时不要再试第二次、也不要用别的工具绕，直接告诉用户"这个格式我读不了，可以帮你打开自己看"。只读，不改动文件。长文件一次读不完：返回里有 totalChars 和 nextOffset，需要就带 offset 再读一段；**只读了一部分时必须说明结论只覆盖读到的那部分**，不要把局部当全文。',
    effect: 'read',
    // 文件内容可能是合同、账单、密钥：读过之后本轮被污染，往外发要先确认
    readsPrivateData: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径或文件名（如「报告.docx」「文档\\报告.docx」「D:\\资料\\笔记.md」）' },
        offset: { type: 'number', description: '从第几个字符开始读，默认 0。上一段没读完时用返回值里的 nextOffset 接着读' },
        maxChars: { type: 'number', description: `本次最多读多少字，默认 ${DEFAULT_MAX_CHARS}，上限 ${HARD_MAX_CHARS}` },
        reason: { type: 'string', description: '为什么要读，一句话（用户想从里面知道什么）' }
      },
      required: ['path']
    },
    plan: async (args): Promise<ToolPlan> => {
      const query = String(args.path ?? '').trim()
      if (!query) return { ok: false, reason: '没有给出要读的文件' }
      const planned = planFile(query)
      if (!planned.ok) {
        const pool = planned.candidates ?? []
        if (pool.length > 1) {
          const options = pool.slice(0, 8).map((f) => ({ value: f.path, label: f.name, detail: f.path }))
          return {
            ok: false,
            reason: `有 ${pool.length} 个叫「${query}」的文件，等用户在候选卡上选`,
            choice: {
              title: `要读哪一个「${query}」？`,
              hint: `找到 ${pool.length} 个。只读文字，不改动文件。`,
              pickInto: 'path',
              options
            }
          }
        }
        return { ok: false, reason: planned.reason }
      }
      const file = planned.file
      // 格式在读之前就判掉：读 tier 不弹卡，先读一遍再发现是 PDF 等于白读一次
      const kind = fileKindOf(file.path)
      if (kind === 'unsupported') return { ok: false, reason: unsupportedReason(file.path) }
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0)
      return {
        ok: true,
        target: {
          title: `读取文件：${file.name}`,
          target: file.path,
          impact: '只读：不修改、不移动、不删除这个文件'
        },
        execute: async (): Promise<ToolResult> => {
          const maxChars = Number(args.maxChars ?? DEFAULT_MAX_CHARS)
          const outcome = readFileSlice(file.path, { offset, maxChars })
          if (!outcome.ok) return { ok: false, summary: outcome.reason }
          return describeRead(outcome.read)
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'read_file 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  /**
   * 写文件：长庚唯一的产出能力。
   *
   * 在此之前它能看（read_file）、能改系统（装卸删），却**没办法把结论交到用户手上**——
   * "把刚才那份整理成 md 存下来"只能靠委派给外部工作体，而那条路是要跑一整个智能体的。
   *
   * 三条边界都在 node/document.ts 里由代码定死，不靠提示词：
   * 落点只有「桌面\长庚产出」、只写看得懂的格式、永不覆盖同名文件。
   * 再加 requiresConfirmation：写进用户真实目录的文件，必须让他看见路径和内容预览再点头。
   *
   * 内容一律按 Markdown 理解，`.docx/.pptx` 由 Markdown **生成**（`node/docx.ts` /
   * `node/pptx.ts`，自己拼 OOXML，不装 Office、不拉起窗口）。用户要 `.doc/.ppt` 时
   * 落盘成 `.docx/.pptx` 并在结果里如实说明——那两代格式差着整整一代，
   * 换个后缀不会让它变成另一种文件。
   */
  const writeDocumentTool: ToolDef = {
    name: 'write_document',
    label: '写一份文件到桌面（需授权）',
    description:
      '把内容写成一个文件，存到用户桌面上的「' +
      OUTPUT_FOLDER +
      '」文件夹里。**只能写这一个目录**，不能让模型指定别的路径。支持的格式：文本类 .md/.txt/.csv/.json/.html（照原文写），以及 .docx（Word 文档）和 .pptx（PowerPoint 幻灯片）——后两种由 **Markdown 生成**，所以 content 要用 Markdown 写。同名文件已存在时**不会覆盖**，会换一个名字（如「周报 (2).docx」），结果里给的是最终路径。\n' +
      '**要 Word 就用 .docx，要幻灯片就用 .pptx**：用户说".doc / .ppt"时，落盘的会是 .docx / .pptx（老格式写不了），这时结果里会说明，你如实转告即可。\n' +
      '**写幻灯片（.pptx）的约定**：一行 `# 一级标题` 就是新的一页、标题就是它；`##` 是页内小标题；`- ` 是要点；`---` 也能分页。\n' +
      '用户说「存成文件」「导出」「保存下来」「做个 Word / PPT」「写到文档里」时用它。用户没有明确要求写文件前不要调用。',
    effect: 'write',
    requiresConfirmation: true,
    // 每次写的都是不同内容：没有"以后都自动写"这回事
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            '文件名，可带后缀（不给后缀按 .md 存）。支持 .md/.txt/.csv/.json/.html/.docx/.pptx；写 .doc/.ppt 会存成 .docx/.pptx。不能带目录，不能含「..」'
        },
        content: {
          type: 'string',
          description: `文件内容，Markdown 格式（.docx/.pptx 会按它生成标题层级与列表）。最长 ${MAX_DOC_CHARS} 字`
        }
      },
      required: ['name', 'content']
    },
    plan: async (args): Promise<ToolPlan> => {
      if (!deps.outputRoot) {
        return { ok: false, reason: '当前环境没有可写的位置（没有注入桌面路径）' }
      }
      const content = typeof args.content === 'string' ? args.content : ''
      if (!content.trim()) return { ok: false, reason: '内容是空的，没有可写的东西' }
      if (content.length > MAX_DOC_CHARS) {
        return {
          ok: false,
          reason: `内容有 ${content.length} 字，超过单次上限 ${MAX_DOC_CHARS} 字；拆成两份，或先精简`
        }
      }
      // 解析只做一次：卡片上写的路径，就是下面真正写下的那个（K7）
      const planned = await resolveDocument(deps.outputRoot, args.name)
      if (!planned.ok) return { ok: false, reason: planned.reason }

      // 生成也在 plan 阶段做完：生成不出来（比如幻灯片超过上限）就不该弹卡，
      // 而"共几页"这种信息卡片上就得有，点完才发现是 200 页也来不及了
      const ext = path.extname(planned.name).toLowerCase()
      const title = planned.name.slice(0, planned.name.length - ext.length)
      let built: BuiltDocument
      try {
        built = buildDocument(planned.format, content, title)
      } catch (err) {
        return {
          ok: false,
          reason: `生成 ${planned.name} 失败：${err instanceof Error ? err.message : String(err)}`
        }
      }

      const swapped = planned.swappedFrom
        ? `你要的是 ${planned.swappedFrom}，但那是 1997 年的老二进制格式，长庚写不了；这次生成的是 ${path.extname(planned.name)}，Word / PowerPoint / WPS 都能直接打开。`
        : ''
      const kind = planned.format === 'text' ? '这份文件' : `这份 ${path.extname(planned.name)}`
      return {
        ok: true,
        target: {
          title: `写文件：${planned.name}`,
          target: planned.path,
          impact: `${swapped}会在「桌面\\长庚产出」里新建${kind}${built.detail ? `（${built.detail}）` : ''}。${
            planned.renamed ? '**同名文件已存在，所以换了新名字**，原来那份不动' : '不覆盖任何已有文件'
          }，内容只写在这台机器上`,
          undoHint: '在资源管理器里删掉这个文件'
        },
        execute: async (): Promise<ToolResult> => {
          const outcome = await writeDocumentOnce(planned, built.buffer)
          if (!outcome.ok) return { ok: false, summary: `没有写成：${outcome.reason}` }
          const kb = Math.max(1, Math.round(outcome.bytes / 102.4) / 10)
          const summary =
            `已写入「${outcome.name}」（${kb} KB${built.detail ? `，${built.detail}` : ''}）：${outcome.path}` +
            (planned.swappedFrom
              ? `　⚠ 你要的是 ${planned.swappedFrom}，那是老二进制格式、长庚写不了，存的是 ${path.extname(planned.name)}，Word / PowerPoint 能直接打开`
              : '')
          return {
            ok: true,
            summary,
            undo: '在资源管理器里删掉这个文件',
            data: {
              path: outcome.path,
              name: outcome.name,
              bytes: outcome.bytes,
              sha256: outcome.sha256,
              renamed: planned.renamed,
              format: planned.name.slice(planned.name.lastIndexOf('.') + 1),
              ...(planned.swappedFrom ? { requestedFormat: planned.swappedFrom.slice(1) } : {})
            },
            evidence: [
              ev({
                type: 'local',
                title: `写出文件：${outcome.name}`,
                detail: `${outcome.path} · ${outcome.bytes} 字节 · 用户授权后写入`
              })
            ]
          }
        }
      }
    },
    /**
     * 事后核对：把那个路径重新读回来，比 sha。
     *
     * 写文件是最容易"以为成了"的一种：目录被策略拦掉、磁盘满、杀软隔离，
     * 都可能让前面那次写入只成功了一半，而回执里写着"已写入"。
     * 只比字节数不够——同一个长度的另一份内容也会过；所以比的是内容摘要。
     */
    verify: async (_args, _ctx, result) => {
      const data = result.data as { path?: string; bytes?: number; sha256?: string } | undefined
      const target = String(data?.path ?? '').trim()
      if (!target) return { state: 'unavailable', fact: '这次的结果里没有文件路径，没法回读' }
      const now = await inspectDocument(target)
      if (!now.ok) {
        return { state: 'mismatch', fact: `回读 ${target} 失败（${now.reason}）——文件可能根本没落盘` }
      }
      if (data?.sha256 && now.sha256 === data.sha256) {
        return { state: 'confirmed', fact: `回读了 ${target}：${now.bytes} 字节，内容与这次写进去的完全一致` }
      }
      return {
        state: 'mismatch',
        fact: `回读了 ${target}：现在是 ${now.bytes} 字节，与写进去的 ${data?.bytes ?? '?'} 字节对不上（内容被改动或写了一半）`
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'write_document 必须先解析出最终路径（plan），直接 run 不会被放行' }
    }
  }

  const installAppTool: ToolDef = {
    name: 'install_app',
    label: '安装软件（需授权）',
    description:
      '通过 winget（Windows 官方包管理器）安装一个软件：先在 winget 仓库检索，唯一匹配才出授权卡，然后**拉起这个软件自己的安装界面**由用户在窗口里点完（安装位置、快捷方式、开机自启都由他选）。来源与哈希校验由 winget 负责，不在桌面留安装包；安装不可撤回，装完可在「设置 → 应用」卸载。**装之前会先查一遍它是不是已经装着了**：已经装了就一个字节都不动、直接告诉你它在了，这时如实转告用户，**不要重试、不要劝他重装，也不要提"帮你升级"——要不要升级由软件自己提示**；他要看到这个程序就调用 launch_app。只有用户明确说要重装/修复时才传 force=true。**这个工具是"拉起来就返回"的：返回时安装器窗口才刚打开，结果还不知道，可能要好几分钟。所以返回后只能说"安装窗口已经打开了、装完会告诉你核对结果"，绝不能说已经装好了，也别说"正在安装、请稍候"——用户可以接着问别的事，管家装完会另行**自动核对**程序清单与新增的开机自启项，并通知他结果。**用户在安装器里点「取消」时，后台会说明是用户取消，不要当成失败、也不要劝他再试一次。核对没对上时必须如实说"没核实到装好了"，不要因为 winget 报了成功就告诉用户已经装好。授权卡上用户可以点「始终允许」：只对同一个包的同一版本生效（换个包/换版本仍要重新授权），并可在「设置 → 授权记忆」里撤销。用户没有明确同意前不要调用。名字有歧义（多个候选）时会自动弹出候选卡让用户自己点，这时不要自己替用户挑、也不要重复调用；仓库里没有这个词时，先把口语名/拼音/错拼翻成官方名称或英文名再调一次。',
    effect: 'install',
    // 全注册表唯一开「始终允许」的档位：安装是系统改动但非销毁，key 含包名+版本，
    // 换目标即失效；删除/卸载（销毁类）永远逐次弹卡，不允许记忆
    allowAlways: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '软件名，尽量用官方名称；winget 里的 Id 也接受' },
        reason: { type: 'string', description: '为什么要装，一句话' },
        force: {
          type: 'boolean',
          description:
            '只在用户明确说要「重装/修复」时才传 true。默认 false：已经装着的软件不会再装一遍，工具会直接告诉你它已经在了'
        }
      },
      required: ['name']
    },
    plan: async (args, ctx): Promise<ToolPlan> => {
      const name = String(args.name ?? '').trim()
      if (!name) return { ok: false, reason: '没有给出要安装的软件名' }
      if (!(await wingetAvailable(ctx.signal))) {
        return { ok: false, reason: '这台机器上没有可用的 winget，只能由用户自己去官网下载安装' }
      }
      let candidates: WingetPackage[]
      try {
        candidates = await searchWinget(name, ctx.signal)
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: `winget 仓库里没有「${name}」这个词（winget 只做字面匹配，没有模糊搜索）。**先把它翻成官方名称或英文名再调一次，不要原样重试**：口语/拼音/错拼要还原，例如「bibib」「阿B」→「哔哩哔哩」、「微信」→「WeChat」、「剪映」→「CapCut」。换成别的说法都搜不到，才能说仓库里没有，让用户去官网下载`
        }
      }
      /**
       * 唯一化阶梯：能确定的就直接走授权卡，确定不了才弹候选卡。
       *
       * 只有两种「能确定」：
       *  1. 用户报的就是包 Id（`Bilibili.Bilibili`）——那没有歧义可言。
       *     这条也是候选卡选完重新解析时走的路径，必须留：
       *     选完再问一次就成了死循环。
       *  2. 按名字只剩一个候选（`微信` → 只有 Tencent.WeChat）。
       *
       * 名字**完全相等**不算「能确定」，这是有意的：搜 kimi 时 Kimi / Kimi CLI /
       * Kimi Code CLI 三条名字都像，用户说的「Kimi」既可能是桌面客户端，
       * 也可能是那个命令行编程工具。差一个字的「哔哩哔哩直播姬」同理。
       * 与其替他猜，不如让他点一下——卡的第一个选项就是完全同名那个，回车即可。
       */
      const idExact = candidates.find((p) => p.id.toLowerCase() === name.toLowerCase()) ?? null
      /**
       * 名字里带检索词的优先，只靠 Tag/Command 命中的往后放。
       * 搜 kimi：三条名字命中，其余是清单里打了 kimi 标签的（Chatbox、LM Studio）
       * ——用户说的「Kimi」不会是它们，所以名字命中存在时就不拿它们占候选位。
       */
      const named = candidates.filter((p) => matchedByName(p, name))
      const pool = rankCandidates(named.length > 0 ? named : candidates, name)
      const chosen = idExact ?? (pool.length === 1 ? pool[0] : null)
      if (!chosen) {
        // 有候选但都不能确定是哪一个：做成可点的候选卡让用户自己点。
        // 以前是把候选写进一段文字让模型转述，来回两三轮还容易传错
        const options = pool.slice(0, 8).map((p) => ({
          value: p.id,
          label: p.name,
          detail: `${p.id} · ${p.version}`
        }))
        return {
          ok: false,
          reason: `winget 里有 ${pool.length} 个候选，等用户在候选卡上选`,
          choice: {
            title: `你要装哪一个「${name}」？`,
            hint:
              pool.length > options.length
                ? `按「${name}」找到 ${pool.length} 个包，只列前 ${options.length} 个。选定后还会再弹一次安装确认卡。`
                : `按「${name}」找到 ${pool.length} 个包。选定后还会再弹一次安装确认卡。`,
            pickInto: 'name',
            options
          }
        }
      }
      /**
       * 装前查重：机器上已经有了就别再走安装。
       *
       * 这一步不是"省事"：winget 在没有可升级版本时会直接放弃安装（退出码非 0），
       * 而它拉起安装器的那张卡用户已经点过同意了——他会以为是"又装了一遍"。
       * 更糟的是没有可升级版本时 winget 什么都不做，我们却可能按装完了上报。
       *
       * 查重失败（winget 卡住/查不到）按"不确定"处理，继续走安装：
       * 宁可多问一次卡，也不能因为查重没答上来就拒绝用户真正要的安装。
       */
      if (args.force !== true) {
        const existing = await checkInstalled(chosen.id, ctx.signal).catch(() => null)
        if (existing?.found) {
          const known = existing.name ?? chosen.name
          const version = existing.version ? `（版本 ${existing.version}）` : ''
          return {
            ok: false,
            reason: `「${known}」${version}已经装在这台机器上了，这一轮没有安装任何东西。**直接告诉用户它已经在了，不要重复调用 install_app，也不要劝他重装或升级**——需要更新的话软件自己会提示。他想看到这个程序的话，调用 launch_app 打开「${known}」就行。只有用户明确说要重装/修复，才带 force=true 再调一次。`
          }
        }
      }

      return {
        ok: true,
        target: {
          title: `安装：${chosen.name}`,
          target: `${chosen.id} ${chosen.version} · 来源 winget 官方仓库`,
          /**
           * 卡上的「影响」是用户在批准前唯一的信息来源。
           *
           * 最要紧的一句是「会有界面弹出来、位置和勾选你说了算」——
           * 之前这里是"全程没有界面、取消不了"（那时真的用 --silent），
           * 现在改成一律交互式，那句话就成了假话，必须跟着改。
           */
          impact: `会启动这个软件自己的安装界面（${chosen.id}）：安装位置、桌面快捷方式、开机自启都在那个界面里由你决定，长庚不替你选。**需要你在弹出的窗口里点完**——点「取消」就等于什么都没装。**点完就开始装，你不用在这儿等着**，可以接着问别的事：装完长庚会自动核对程序清单与新增的自启项，结果另行告诉你，并写进记录。来源与哈希由 winget 校验，不在桌面留安装包。`,
          undoHint: '安装不可撤回；装完可在「设置 → 应用」里卸载',
          reinstallHint: `安装源：winget（Id: ${chosen.id}）`
        },
        execute: async (): Promise<ToolResult> => {
          /**
           * 装之前先扫一次自启项：装完只陈述前后差异，不推断是谁加的。
           * 扫不到就当没有基准线，后面就不聊自启项（宁可不提，也不猜）。
           *
           * 这一步必须在**返回**之前做：它是核对用的基准线，安装器一开就变了。
           */
          const beforeStartup = await listStartupItems(true)
            .then((r) => r.items.map((i) => i.name))
            .catch(() => null)

          /**
           * 没有任务清单的环境（评测、闸门自检、离线验收）就照老样子同步做完。
           *
           * 不给它编一个假的后台：那些环境里没有窗口、没有通知、也没有人点取消，
           * "后台"在那里只会变成"结果不知道去哪了"。
           */
          const registry = deps.installJobs
          if (!registry) return (await runInstallToCompletion(chosen, beforeStartup, ctx.signal)).result

          const job = registry.start({ name: chosen.name, pkgId: chosen.id, version: chosen.version })
          // 后台任务自己收尾：装完核对、更新任务状态。审计由闸门在 deferred 落定时写
          const done = (async (): Promise<ToolResult> => {
            try {
              const final = await runInstallToCompletion(chosen, beforeStartup, job.signal)
              // 状态用 final.status，不从 summary 里认字眼——核对失败那句话里也带着「取消」
              job.finish(final.status, final.result.summary)
              return final.result
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err)
              job.finish('failed', `安装没做完：${reason}`)
              return { ok: false, summary: `「${chosen.name}」没装成：${reason}` }
            }
          })()

          return {
            /**
             * `ok: true` 说的是"这件事已经开始了"，不是"装好了"。
             *
             * 这两件事必须分开说：安装器现在才刚弹出来，结果还不知道。
             * summary 里写清楚，模型才不会照着这句回执对用户宣布装好了。
             */
            ok: true,
            summary: `「${chosen.name}」的安装已经开始了，现在由安装器自己的窗口负责：位置、快捷方式、开机自启都在那个窗口里由用户决定，装的时候不用等我。装完我会核对程序清单，结果另行告诉你——**不要说它已经装好了，也别说正在安装，就说安装窗口已经打开了、装完会告诉他核对结果**。这期间用户可以继续问别的事。`,
            deferred: done,
            data: { id: chosen.id, version: chosen.version, source: 'winget', jobId: job.id, background: true }
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'install_app 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  const uninstallAppTool: ToolDef = {
    name: 'uninstall_app',
    label: '卸载程序（需授权）',
    description:
      '卸载一个**已安装的程序**：校验注册表里的卸载入口，然后启动该程序自己的卸载程序，由用户在窗口里确认完成。这是销毁类操作，必须过授权卡；不做静默卸载、不删安装目录、不碰它没登记的文件。名字必须与「已安装程序」里的名称完全一致；同名多条或没有卸载入口时会拒绝执行。用户没有明确同意前不要调用。',
    effect: 'destroy',
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '程序名，必须与 list_installed_apps 返回的 name 完全一致' },
        reason: { type: 'string', description: '为什么要卸载，一句话' }
      },
      required: ['name']
    },
    plan: async (args) => {
      const requested = String(args.name ?? '').trim()
      const planned = await planUninstall(requested)
      if (!planned.ok) return planned

      const { entry, command } = planned
      const exeName = path.basename(command.exe)

      // 快照在 plan 阶段抓一次：卡片上的"会动掉多少东西"和 execute 落盘的
      // 是同一份（K7 同源）。抓失败不拦流程——快照是加分项，不是闸门
      let snapshot: AppSnapshot | null = null
      try {
        const { items } = await listStartupItems()
        snapshot = await captureSnapshot(entry.name, { entry, startupItems: items })
      } catch {
        snapshot = null
      }
      const snapshotText = snapshot
        ? `快照已记下：安装目录${snapshot.summary.files > 0 ? `约 ${snapshot.summary.sizeMB} MB / ${snapshot.summary.files} 个文件` : '为空或不可读'}${
            snapshot.summary.startupCount > 0 ? `，${snapshot.summary.startupCount} 个关联自启项` : ''
          }`
        : ''
      const registrySource = entry.installSource.trim() || entry.urlInfoAbout.trim()
      // 注册表没登记下载来源就如实说没有——早先这里还会用「官网查证」的结果兜底，
      // 那条链路已整体移除（它的唯一入口是已删掉的台账页），不再假装有第二来源
      const reinstallHint = registrySource
        ? `下载/官网：${registrySource}（注册表登记）`
        : '注册表没有记录下载来源，重装只能自己找官网'
      const scopeText = entry.scope === 'machine' ? '本机安装' : '仅为当前用户安装'

      return {
        ok: true,
        target: {
          title: `卸载：${entry.name}`,
          target: `${entry.name}${entry.version ? ` ${entry.version}` : ''}｜${scopeText} · ${entry.arch} 位 · 注册表项 ${entry.key}`,
          impact: `会启动它自己的卸载程序（${exeName}${
            command.args.length ? ` ${command.args.join(' ')}` : ''
          }）；程序文件与注册表项由那个窗口删除，不可撤回${snapshotText ? `。${snapshotText}` : ''}`,
          undoHint: '不可撤回（要回来只能重装）',
          reinstallHint
        },
        execute: async (): Promise<ToolResult> => {
          const launched = launchUninstaller(command.exe, command.args)
          if (!launched.ok) {
            return {
              ok: false,
              summary: `没能启动「${entry.name}」的卸载程序：${launched.detail ?? '原因未知'}，程序应该还在`
            }
          }
          // 卸载程序已拉起才落盘快照：被拒绝或启动失败时只抓不存，不留垃圾
          if (snapshot) {
            try {
              await deps.saveSnapshot?.(snapshot)
            } catch {
              /* 落盘失败不影响卸载本身，只是"卸完少了什么"这张卡没了 */
            }
          }
          return {
            ok: true,
            summary: `已启动「${entry.name}」自己的卸载程序（${exeName}）。卸载要等那个窗口里的确认，我无法确认你有没有点完；点完后回「记录」页点「卸载对比」，或直接问我「卸干净了没」。重装入口：${reinstallHint}`,
            undo: '不可撤回',
            snapshotId: snapshot?.id,
            /**
             * 这一类就是"当场查不到"：卸载的主体是用户在那个窗口里点确认，
             * 我们拉起它之后就交出去了。所以如实标 unavailable，而不是
             * 立刻去读一次注册表、把"还没点完"报成"没卸掉"。
             */
            verify: {
              state: 'unavailable',
              fact: `卸载要等你在它自己的窗口里点完，这一刻查不出结果；点完再问我「卸干净了没」，我拿卸载前的快照对比注册表项、安装目录和开机自启项`
            },
            data: {
              name: entry.name,
              version: entry.version,
              publisher: entry.publisher,
              exe: command.exe,
              args: command.args,
              registryKey: entry.key,
              reinstallHint,
              snapshotId: snapshot?.id
            },
            evidence: [
              ev({
                type: 'local',
                title: `卸载：${entry.name}`,
                detail: `注册表卸载入口 ${entry.key} · 用户授权后启动 · 安装来源：${registrySource || '未登记'}${
                  snapshotText ? ` · ${snapshotText}` : ''
                }`
              })
            ]
          }
        }
      }
    },
    // plan 提供了执行体；run 不会被调用，仅用于满足类型
    run: async (): Promise<ToolResult> => ({ ok: false, summary: '这个工具必须先解析目标，直接执行被拒绝' })
  }

  // ---- 跨会话记忆 ----

  const memoryTools: ToolDef[] = [
    {
      name: 'save_memory',
      label: '记住一件事（需确认）',
      description:
        '把一件"以后还用得上"的事记下来，下次对话还能想起来。适合：用户让你记住的偏好和习惯、正在做的项目与进度、约定的规则。不适合：一次性的问答内容、从工具读到的会变的事实（装了什么、有什么文件）、你自己的推测。同一件事重复保存只会刷新时间，不会重复记录。',
      effect: 'write',
      /**
       * 记忆必须让你看见再写。
       *
       * 标签一直写着「需确认」，但底子是 write 档——而 write 档是**自动放行**的
       * （只备份、不弹卡）。2026-11-10 真机实测抓到的就是这个：日志里
       * `save_memory ... authz=auto`，一次卡都没弹。
       *
       * 记忆和别的写入不一样：它改变的是"长庚以后怎么看你"。
       * 一句记错的偏好会一直生效，而且下次对话你看不到它是什么时候被写进去的。
       */
      requiresConfirmation: true,
      // 不设「始终允许」：每次都要看得见，否则"以后都自动记住"就没边了
      allowAlways: false,
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: `记忆类型：user=关于用户本人 / preference=偏好与习惯 / project=正在做的事 / fact=约定与规则。默认 fact`
          },
          text: { type: 'string', description: `一句话，最长 ${MEMORY_MAX_TEXT} 字` }
        },
        required: ['text']
      },
      describeTarget: (args) => ({
        title: '记住一件事',
        target: String(args.text ?? '').slice(0, 80),
        impact: '只在本地记一条笔记，不改动系统，可在「设置 → 记忆」里删除。但这条会被带进以后的每次对话——写错了会一直生效',
        undoHint: '设置 → 记忆'
      }),
      // write 档会先备份：这里存的是整个记忆列表的快照，撤销时据此还原
      backup: async () => {
        if (!deps.memory) return { ok: false, detail: '当前环境不能保存记忆' }
        try {
          const list = await deps.memory.list()
          return { ok: true, undo: `备份了 ${list.length} 条记忆` }
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) }
        }
      },
      /**
       * 事后核对：重新读一遍记忆清单，看这条在不在。
       *
       * 记忆的"写成功"是最不该靠回执宣布的一种——写盘失败被吞掉、或者列表被
       * 别的地方覆盖，用户下次对话才发现"它没记住"。所以这里按文本重新找一遍。
       */
      verify: async (args) => {
        if (!deps.memory) return { state: 'unavailable', fact: '这个环境读不了记忆清单' }
        const text = String(args.text ?? '').trim()
        try {
          const list = await deps.memory.list()
          // 用与去重同一个判据：落盘时文本会被规整（空白压缩、截断），
          // 拿原文全等去比，模型换了个换行就会误报"没记住"
          const found = list.some((item) => sameMemory(item.text, text))
          return found
            ? { state: 'confirmed', fact: `重新读了一遍记忆清单（共 ${list.length} 条）：这条在里面` }
            : { state: 'mismatch', fact: `重新读了一遍记忆清单（共 ${list.length} 条）：没找到这条` }
        } catch (err) {
          return { state: 'unavailable', fact: `重新读记忆清单失败：${err instanceof Error ? err.message : String(err)}` }
        }
      },
      run: async (args): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境不能保存记忆' }
        const list = await deps.memory.list()
        const outcome = mergeMemory(list, { kind: args.kind, text: args.text })
        if (!outcome.ok) return { ok: false, summary: `没有保存：${outcome.reason}` }
        await deps.memory.save(outcome.list)
        return {
          ok: true,
          summary: outcome.replaced
            ? `这条之前记过，已刷新时间：「${outcome.entry.text}」`
            : `已记住：「${outcome.entry.text}」（以后对话可以用上，可在设置里删除）`,
          undo: '设置 → 记忆',
          data: { id: outcome.entry.id, kind: outcome.entry.kind, text: outcome.entry.text },
          evidence: [
            ev({
              type: 'local',
              title: `记忆已更新（共 ${outcome.list.length} 条）`,
              detail: '本地 memory.json · 只存在这台机器上'
            })
          ]
        }
      }
    },
    {
      name: 'forget_memory',
      label: '忘掉一条记忆（需确认）',
      description:
        '删掉一条之前记下的内容。用户说"忘记这个""记错了""删掉那条记忆"时用它。参数可以是记忆的 id，也可以直接给原文（会按内容匹配）。删之前建议先 list_memory 核对是哪一条。',
      effect: 'write',
      /**
       * 删除记忆同样要过卡。理由和 save_memory 一样：它改的是"长庚记得的你"。
       * 虽然删错了还能重加，但用户得先知道发生了这件事。
       */
      requiresConfirmation: true,
      allowAlways: false,
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '记忆的 id，或要删除的那句话' }
        },
        required: ['ref']
      },
      describeTarget: (args) => ({
        title: '忘掉一条记忆',
        target: String(args.ref ?? '').slice(0, 80),
        impact: '从本地记忆里删掉这条，其他数据不受影响；删掉之后长庚就不再记得它了',
        undoHint: '设置 → 记忆（删除前有备份，可重新添加）'
      }),
      backup: async () => {
        if (!deps.memory) return { ok: false, detail: '当前环境不能修改记忆' }
        try {
          const list = await deps.memory.list()
          return { ok: true, undo: `备份了 ${list.length} 条记忆` }
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) }
        }
      },
      /**
       * 事后核对：重新读清单，确认这条真的不在了。
       *
       * 和 save_memory 反过来查：删成功的证据是"找不到"，不是"回执说删了"。
       */
      verify: async (args) => {
        if (!deps.memory) return { state: 'unavailable', fact: '这个环境读不了记忆清单' }
        const ref = String(args.ref ?? '').trim()
        try {
          const list = await deps.memory.list()
          const still = list.some((item) => item.id === ref || sameMemory(item.text, ref))
          return still
            ? { state: 'mismatch', fact: `重新读了一遍记忆清单（共 ${list.length} 条）：这条还在` }
            : { state: 'confirmed', fact: `重新读了一遍记忆清单（共 ${list.length} 条）：这条已经不在了` }
        } catch (err) {
          return { state: 'unavailable', fact: `重新读记忆清单失败：${err instanceof Error ? err.message : String(err)}` }
        }
      },
      run: async (args): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境不能修改记忆' }
        const list = await deps.memory.list()
        const { list: next, removed } = removeMemory(list, String(args.ref ?? ''))
        if (!removed) return { ok: false, summary: `没有找到要删除的记忆：${String(args.ref ?? '').slice(0, 60)}` }
        await deps.memory.save(next)
        return {
          ok: true,
          summary: `已删掉：「${removed.text}」`,
          undo: '设置 → 记忆',
          data: { removed: removed.text, remaining: next.length }
        }
      }
    },
    {
      name: 'list_memory',
      label: '看看自己记得什么',
      description:
        '列出之前记下的所有内容（只读）。用户问"你记得我什么""你记住了哪些东西"，或者删除前需要核对是哪一条时用它。',
      effect: 'read',
      parameters: { type: 'object', properties: {} },
      describeTarget: () => ({
        title: '读取记忆清单',
        target: '本地 memory.json',
        impact: '只读，不改动任何东西'
      }),
      run: async (): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境没有记忆存储' }
        const list = await deps.memory.list()
        if (list.length === 0) return { ok: true, summary: '还没有记下任何东西', data: [] }
        return {
          ok: true,
          summary: `共 ${list.length} 条记忆`,
          data: list.map((item) => ({ id: item.id, kind: item.kind, text: item.text, updatedAt: item.updatedAt })),
          evidence: [
            ev({ type: 'local', title: `本地记忆清单（${list.length} 条）`, detail: 'memory.json · 只读' })
          ]
        }
      }
    }
  ]


  /**
   * ---------------- 屏幕与模拟键鼠 ----------------
   *
   * 这组工具的能力是"无粒度"的：模拟鼠标一旦能动，就能点屏幕上的任何东西。
   * 所以三道闸一起上：
   *  1. screen_capture 只读，但读的是整块屏幕（可能看到密码/私信），算私密读取；
   *  2. 三个 input 工具一律 destroy 档、必须过卡、永不"始终允许"；
   *  3. 卡上带当前屏幕，并且**先算出坐标会落到哪个窗口**——不在白名单里直接拒绝，
   *     不靠模型自觉。
   *
   * 时间窗授权（60 秒 / 10 个动作）由闸门的 hasActiveGrant 处理，
   * 这里只负责"每个动作都如实回报做了什么"。
   */

  /** 屏幕截图（只读但涉及私密内容：整块屏幕什么都可能有） */
  const screenCaptureTool: ToolDef = {
    name: 'screen_capture',
    label: '看一眼屏幕（只读）',
    description:
      '截取当前屏幕。**只读**，不改动任何东西。用于：用户问"屏幕上现在是什么""那个报错写了什么"，或者你需要先看清界面再决定下一步。截的是整块屏幕，可能包含私密内容，所以会被记进操作记录。',
    effect: 'read',
    readsPrivateData: true,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要看屏幕，一句话' }
      }
    },
    describeTarget: (args) => ({
      title: '截取当前屏幕',
      target: String(args?.reason ?? '（未说明原因）'),
      impact: '只读取当前屏幕画面，不改动任何东西'
    }),
    run: async (args) => {
      if (!deps.captureScreen) {
        return { ok: false, summary: '当前环境不支持截屏（评测或离线模式）。' }
      }
      try {
        const shot = await deps.captureScreen()
        return {
          ok: true,
          summary: '已截取屏幕（' + shot.width + '×' + shot.height + '）。画面已返回给调用方。',
          data: { width: shot.width, height: shot.height },
          evidence: [ev({ type: 'local', title: '当前屏幕截图', detail: String(args?.reason ?? '') })]
        }
      } catch (err) {
        return { ok: false, summary: '截屏失败：' + (err instanceof Error ? err.message : String(err)) }
      }
    }
  }

  /**
   * 白名单检查：这个坐标会落到哪个窗口上，那个进程允不允许操作。
   *
   * 抽成函数是因为三个 input 工具都要用，而且**必须在真正动鼠标之前**用——
   * "先点了再检查"等于没检查。
   */
  const checkTarget = async (
    x?: number,
    y?: number
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }> => {
    if (!deps.desktopInput) return { ok: false, reason: '当前环境不支持模拟键鼠（评测或离线模式）' }
    const allowed = deps.desktopInput.allowedProcesses()
    if (allowed.length === 0) {
      return {
        ok: false,
        reason:
          '还没有允许任何程序接受模拟操作。请到「设置 → 远程访问」里把要操作的程序加进白名单。'
      }
    }
    if (typeof x !== 'number' || typeof y !== 'number') return { ok: true, note: '' }
    const wins = await deps.desktopInput.listWindows()
    const hit = windowAt(wins, x, y)
    if (!hit) return { ok: false, reason: '坐标 (' + x + ', ' + y + ') 上没有可操作的窗口' }
    const proc = hit.process.toLowerCase()
    if (!allowed.some((p) => p.toLowerCase() === proc)) {
      return {
        ok: false,
        reason:
          '坐标 (' + x + ', ' + y + ') 落在「' + (hit.title || hit.process) + '」(' + hit.process +
          ') 上，它不在允许名单里。允许的有：' + allowed.join('、')
      }
    }
    return { ok: true, note: '目标窗口：' + (hit.title || hit.process) + '（' + hit.process + '）' }
  }

  /** 模拟鼠标点击（需授权，卡上带截图） */
  const clickTool: ToolDef = {
    name: 'click_screen',
    label: '点击屏幕（需授权）',
    description:
      '在屏幕的指定坐标上点击鼠标。**这是改动机器的操作，必须过授权卡**，且坐标落点必须在用户允许的程序窗口内。用法：先用 screen_capture 看清界面，确认坐标，再调用它；reason 要写清"点的是哪个按钮、为什么"。用户没有明确同意前不要调用。',
    effect: 'destroy',
    requiresConfirmation: true,
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标（像素，与 screen_capture 同一套坐标）' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
        button: { type: 'string', enum: ['left', 'right'], description: '鼠标键，默认左键' },
        reason: {
          type: 'string',
          description: '点的是哪个按钮、为什么，一句话。这句话会显示在授权卡上'
        }
      },
      required: ['x', 'y', 'reason']
    },
    plan: async (args) => {
      const x = Math.round(Number(args?.x))
      const y = Math.round(Number(args?.y))
      const check = await checkTarget(x, y)
      if (!check.ok) return { ok: false, reason: check.reason }
      const shot = deps.captureScreen ? await deps.captureScreen(x, y).catch(() => null) : null
      return {
        ok: true,
        target: {
          title: '点击屏幕 (' + x + ', ' + y + ')',
          target: x + ', ' + y + ' · ' + check.note,
          impact: String(args?.reason ?? '（未说明原因）') + '。点击会立刻生效，无法自动撤销。',
          ...(shot ? { screenshot: shot.dataUrl } : {})
        },
        execute: async () => {
          const r = await deps.desktopInput!.click(x, y, args?.button === 'right' ? 'right' : 'left')
          return {
            ok: r.ok,
            summary: r.ok ? r.detail + '（' + check.note + '）' : '点击失败：' + r.detail,
            evidence: [ev({ type: 'local', title: r.detail, detail: String(args?.reason ?? '') })]
          }
        }
      }
    },
    /**
     * 事后核对：**做不到**，如实说。
     *
     * 模拟点击是不可逆、无痕的动作——没有"事后查一下"这回事。
     * 能确认的只有"这个动作被执行了"，不能确认"它作用在了预期的地方"。
     * 所以返回 unavailable 并把这句话写出来，而不是塞进 SELF_VERIFIED 名单
     * 假装有结论：核对表上有东西、但其实什么都没查，比空着更糟。
     */
    verify: async () => ({ state: 'unavailable' as const, fact: '模拟点击是一次性动作，事后无法回查——只能确认它执行了，不能确认点中的是不是预期的按钮' }),
    run: async () => ({ ok: false, summary: '这个工具必须走授权流程' })
  }

  /** 输入文字（需授权） */
  const typeTool: ToolDef = {
    name: 'type_text',
    label: '输入文字（需授权）',
    description:
      '把一段文字输入到**当前前台窗口**里（经剪贴板粘贴，原剪贴板内容会恢复）。**改动机器的操作，必须过授权卡**。注意：它输入到当前前台窗口，所以调用前通常要先用 click_screen 把焦点点到目标输入框，否则字会敲到别处。',
    effect: 'destroy',
    requiresConfirmation: true,
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字' },
        reason: { type: 'string', description: '输入这段文字是为了做什么，一句话' }
      },
      required: ['text', 'reason']
    },
    plan: async (args) => {
      const text = String(args?.text ?? '')
      if (!text) return { ok: false, reason: '没有要输入的内容' }
      const check = await checkTarget()
      if (!check.ok) return { ok: false, reason: check.reason }
      const shot = deps.captureScreen ? await deps.captureScreen().catch(() => null) : null
      return {
        ok: true,
        target: {
          title: '输入 ' + text.length + ' 个字符',
          target: text.slice(0, 120),
          impact:
            String(args?.reason ?? '（未说明原因）') +
            '。会临时占用剪贴板（粘贴后恢复），输入到当前前台窗口。',
          ...(shot ? { screenshot: shot.dataUrl } : {})
        },
        execute: async () => {
          const r = await deps.desktopInput!.type(text)
          return {
            ok: r.ok,
            summary: r.ok ? r.detail : '输入失败：' + r.detail,
            evidence: [ev({ type: 'local', title: r.detail, detail: String(args?.reason ?? '') })]
          }
        }
      }
    },
    /**
     * 事后核对：**做不到**，如实说。
     *
     * 模拟输入是不可逆、无痕的动作——没有"事后查一下"这回事。
     * 能确认的只有"这个动作被执行了"，不能确认"它作用在了预期的地方"。
     * 所以返回 unavailable 并把这句话写出来，而不是塞进 SELF_VERIFIED 名单
     * 假装有结论：核对表上有东西、但其实什么都没查，比空着更糟。
     */
    verify: async () => ({ state: 'unavailable' as const, fact: '输入的文字粘贴进前台窗口后无法回查——只能确认粘贴动作执行了，不能确认落到了哪个输入框' }),
    run: async () => ({ ok: false, summary: '这个工具必须走授权流程' })
  }

  /** 按键（需授权） */
  const pressTool: ToolDef = {
    name: 'press_keys',
    label: '按键（需授权）',
    description:
      '按一个组合键。**改动机器的操作，必须过授权卡**。只接受白名单里的写法（Ctrl+S、Enter、Alt+Tab、Esc 等），不认识的组合直接拒绝——不把任意字符串拼进按键序列，敲错一个字符可能是完全另一个键。',
    effect: 'destroy',
    requiresConfirmation: true,
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: '组合键，例如 Ctrl+S、Enter、Alt+Tab' },
        reason: { type: 'string', description: '为什么要按这个键，一句话' }
      },
      required: ['combo', 'reason']
    },
    plan: async (args) => {
      const combo = String(args?.combo ?? '').trim()
      const check = await checkTarget()
      if (!check.ok) return { ok: false, reason: check.reason }
      const shot = deps.captureScreen ? await deps.captureScreen().catch(() => null) : null
      return {
        ok: true,
        target: {
          title: '按键 ' + (combo || '(空)'),
          target: combo,
          impact: String(args?.reason ?? '（未说明原因）') + '。按键会作用在当前前台窗口上。',
          ...(shot ? { screenshot: shot.dataUrl } : {})
        },
        execute: async () => {
          const r = await deps.desktopInput!.press(combo)
          return {
            ok: r.ok,
            summary: r.ok ? r.detail : '按键失败：' + r.detail,
            evidence: [ev({ type: 'local', title: r.detail, detail: String(args?.reason ?? '') })]
          }
        }
      }
    },
    /**
     * 事后核对：**做不到**，如实说。
     *
     * 模拟按键是不可逆、无痕的动作——没有"事后查一下"这回事。
     * 能确认的只有"这个动作被执行了"，不能确认"它作用在了预期的地方"。
     * 所以返回 unavailable 并把这句话写出来，而不是塞进 SELF_VERIFIED 名单
     * 假装有结论：核对表上有东西、但其实什么都没查，比空着更糟。
     */
    verify: async () => ({ state: 'unavailable' as const, fact: '按键是一次性动作，事后无法回查——只能确认它执行了，不能确认作用到了哪个窗口' }),
    run: async () => ({ ok: false, summary: '这个工具必须走授权流程' })
  }

  return [
    listApps,
    listStartup,
    screenCaptureTool,
    clickTool,
    typeTool,
    pressTool,
    webSearch,
    webFetch,
    openSettings,
    listSandboxTool,
    deleteToRecycleTool,
    readEmailTool,
    launchAppTool,
    openFolderTool,
    openFileTool,
    readFileTool,
    writeDocumentTool,
    installAppTool,
    uninstallAppTool,
    checkUninstallTool,
    githubSearchTool,
    githubUploadTool,
    delegateTool,
    runProjectTool,
    ...memoryTools
  ]
}
