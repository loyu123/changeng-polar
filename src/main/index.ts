import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  AlwaysAllowedEntry,
  AppNote,
  AuthAnswer,
  ButlerConfig,
  ChatMessage,
  ChatSession,
  BriefDef,
  ChatPayload,
  PlanDef,
  ProjectDef,
  TaskDef,
  TodoDef,
  TurnResult
} from '../shared/types'
import { runTurn, TOOL_BUDGET_STEPS, type GateHooks } from './agent/agent'
import { buildSystemPrompt } from './agent/prompt'
import { createTools } from './agent/tools'
import { capabilityBrief } from './agent/tools'
import { pingModel, chatCompletion } from './agent/llm'
import { Store } from './node/store'
import { makeSafeStorageCodec } from './node/secrets'
import { listInstalledApps, listStartupItems } from './node/registry'
import { openRecycleBin, prepareSandbox } from './node/sandbox'
import { diffSnapshot } from './node/snapshot'
import { testMail } from './node/mail'
import { searchWeb } from './node/web'
import { verifyApp } from './verify'
import { TaskRunner } from './node/tasks'

const store = new Store(path.join(app.getPath('userData')), makeSafeStorageCodec(safeStorage))
const inflight = new Map<string, AbortController>()

/** 授权卡等待用户点击：authId → 回调。请求结束时统一 deny，绝不留悬空 Promise */
const pendingAuth = new Map<string, (answer: AuthAnswer) => void>()
/** 哪个请求在等哪几张卡：用户点「停止」时要精确放掉这一次的卡 */
const pendingByRequest = new Map<string, Set<string>>()
/**
 * 「始终允许」白名单（只有 allowAlways 的工具才会写进来：当前仅 install_app，
 * 销毁/卸载类永远不写）。
 * 内存 + `auth-memory.json` 双份：内存保证闸门同步判断，文件保证设置页能看见、能撤销。
 */
const alwaysAllowed = new Set<string>()
const AUTH_TIMEOUT_MS = 60_000

/** 把某个请求名下所有未作答的卡按给定答案收口 */
function settleAuthOfRequest(requestId: string, answer: AuthAnswer): void {
  const ids = pendingByRequest.get(requestId)
  if (!ids) return
  for (const authId of [...ids]) {
    const resolve = pendingAuth.get(authId)
    pendingAuth.delete(authId)
    ids.delete(authId)
    resolve?.(answer)
  }
  pendingByRequest.delete(requestId)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#F3F3F3',
    title: '长庚',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 外链一律走系统浏览器，应用内不加载远程页面
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 同一窗口内的导航也要挡住：页面一旦被导航到远端，preload 的 window.butler
  // 会跟着挂上去，那个页面就能直接调 config:get 读到密钥
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (allowed) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}

function machineEnv() {
  return {
    machineName: os.hostname(),
    userName: os.userInfo().username,
    osVersion: `Windows ${os.release()} (${os.arch()})`,
    today: new Date().toLocaleDateString('zh-CN')
  }
}

/**
 * 跑一轮对话：chat:send（有人在看）与定时任务（无人在场）共用同一条链路。
 * 区别只在授权：uiAuth=false 时需要授权的操作一律当场拒绝（fail-closed），照样留痕。
 */
async function executeTurn(params: {
  requestId: string
  messages: ChatMessage[]
  controller: AbortController
  emit: (raw: ChatPayload) => void
  uiAuth: boolean
}): Promise<TurnResult> {
  const { requestId, messages, controller, emit, uiAuth } = params
  const config = await store.getConfig()
  // 能力开关（插件页）：toolToggles[name] === false 的工具不出现在本轮
  const toggles = config.toolToggles ?? {}
  const tools = createTools({
    openSettings: async (page) => {
      await shell.openExternal(page)
    },
    // 卸载卡上的「重装入口」：注册表没登记时，用查证过的官网兜底
    officialSite: async (appName) => {
      const known = (await store.getVerifyMap())[appName]
      return known?.status === 'verified' ? known.sourceUrl : undefined
    },
    saveSnapshot: (snapshot) => store.saveSnapshot(snapshot),
    appNotes: () => store.getNotes(),
    appVerify: () => store.getVerifyMap()
  }).filter((t) => toggles[t.name] !== false)

  const gate: GateHooks = {
    requestAuth: (request) =>
      new Promise<AuthAnswer>((resolve) => {
        if (!uiAuth) {
          // 定时任务无人在场：写操作当场拒绝（审计照常留痕），绝不默默放行
          resolve('deny')
          return
        }
        const ids = pendingByRequest.get(requestId) ?? new Set<string>()
        pendingByRequest.set(requestId, ids)
        const timer = setTimeout(() => {
          pendingAuth.delete(request.id)
          ids.delete(request.id)
          emit({ type: 'authExpired', authId: request.id })
          resolve('expired')
        }, AUTH_TIMEOUT_MS)
        ids.add(request.id)
        pendingAuth.set(request.id, (answer) => {
          clearTimeout(timer)
          ids.delete(request.id)
          resolve(answer)
        })
        emit({ type: 'auth', request })
      }),
    isRemembered: (key) => alwaysAllowed.has(key),
    remember: (key, request) => {
      alwaysAllowed.add(key)
      void store
        .addAlwaysAllowed({
          key,
          tool: request.tool,
          target: request.target,
          createdAt: new Date().toISOString()
        })
        .then(() =>
          store.appendRecord({
            kind: 'memory',
            title: `记住授权：${request.tool}`,
            sub: `${request.target}（以后同类操作不再弹卡，可在设置里撤销）`,
            result: 'ok',
            reversible: true,
            undo: '设置 → 授权记忆',
            target: request.target,
            authz: 'user_always'
          })
        )
    },
    record: (entry) => {
      void store.appendRecord(entry)
    }
  }

  const env = machineEnv()
  const system: ChatMessage = {
    role: 'system',
    content: buildSystemPrompt(
      { ...env, hasSearch: config.searchProvider !== 'none', toolBudget: TOOL_BUDGET_STEPS },
      capabilityBrief(tools)
    )
  }
  const { result } = await runTurn({
    messages: [system, ...messages],
    config,
    tools,
    signal: controller.signal,
    emit,
    gate,
    ctx: {
      config,
      signal: controller.signal,
      record: (entry) => {
        void store.appendRecord(entry)
        return { ...entry, id: randomUUID(), ts: new Date().toISOString() }
      }
    }
  })
  return result
}

/** 定时任务跑一轮（无头）：结果摘要回写任务卡，过程留痕进操作记录 */
async function runTaskOnce(task: TaskDef): Promise<string> {
  const result = await executeTurn({
    requestId: `task-${task.id}-${Date.now()}`,
    messages: [{ role: 'user', content: task.prompt }],
    controller: new AbortController(),
    emit: () => {},
    uiAuth: false
  })
  void store.appendRecord({
    kind: 'task',
    title: `定时任务「${task.name}」运行`,
    sub: task.prompt.slice(0, 80),
    result: 'ok',
    reversible: false
  })
  return result.text?.slice(0, 140) || '完成（无文本输出）'
}

function normalizeTask(raw: Partial<TaskDef> | undefined): TaskDef {
  const name = String(raw?.name ?? '').trim().slice(0, 40) || '未命名任务'
  const prompt = String(raw?.prompt ?? '').trim().slice(0, 500)
  const schedule =
    raw?.schedule?.kind === 'daily'
      ? { kind: 'daily' as const, time: /^\d{1,2}:\d{2}$/.test(raw.schedule.time ?? '') ? raw.schedule.time : '09:00' }
      : { kind: 'interval' as const, minutes: Math.max(1, Math.min(Number(raw?.schedule?.minutes) || 30, 1440)) }
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
    name,
    prompt,
    schedule,
    enabled: raw?.enabled !== false && Boolean(prompt),
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    lastRun: raw?.lastRun,
    lastResult: raw?.lastResult
  }
}

function broadcastTasks(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('tasks:changed')
    } catch {
      /* 窗口正在关闭 */
    }
  }
}

const taskRunner = new TaskRunner({
  getTasks: () => store.listTasks(),
  updateTask: (id, patch) => store.updateTask(id, patch),
  execute: runTaskOnce,
  onTaskUpdated: () => broadcastTasks()
})

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    ...machineEnv(),
    appVersion: app.getVersion(),
    userData: app.getPath('userData')
  }))

  ipcMain.handle('win:minimize', () => mainWindow?.minimize())
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('win:close', () => mainWindow?.close())

  ipcMain.handle('config:get', () => store.getConfig())
  ipcMain.handle('config:save', (_e, patch: Partial<ButlerConfig>) => store.saveConfig(patch))
  /** 密钥是加密落盘还是明文落盘：设置页那句提示要跟着变，不能骗人 */
  ipcMain.handle('config:secretsEncrypted', () => store.secretsEncrypted())
  ipcMain.handle('config:test', async (_e, patch: Partial<ButlerConfig>) => {
    const config = { ...(await store.getConfig()), ...patch }
    return pingModel(config)
  })

  /**
   * 纯写字补全：给项目页生成方案/简报用。
   *
   * 不能借用 chat:send —— 那条链路带全套工具 schema 和授权闸门，而项目页并没有
   * 装 chat:event 监听器：模型一旦在写简报时申请 install_app，卡会 emit 出去、
   * 谁都不渲染，用户在屏幕上什么都看不到，60 秒后超时变拒绝。
   * 这里 tools 传空数组，模型只能写字，不会触发任何需要授权的动作。
   */
  ipcMain.handle('llm:complete', async (_e, payload: { messages?: ChatMessage[]; system?: string }) => {
    const config = await store.getConfig()
    const messages: ChatMessage[] = [
      ...(typeof payload?.system === 'string' && payload.system.trim()
        ? [{ role: 'system' as const, content: payload.system }]
        : []),
      ...(Array.isArray(payload?.messages) ? payload.messages : [])
    ]
    if (messages.length === 0) return { ok: false, error: '没有要补全的内容' }
    try {
      const res = await chatCompletion({
        config,
        messages,
        tools: [],
        signal: AbortSignal.timeout(120_000)
      })
      return { ok: true, text: res.content.trim() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('apps:list', async () => {
    const [{ apps, durationMs }, verifyMap] = await Promise.all([listInstalledApps(), store.getVerifyMap()])
    return { apps, verifyMap, durationMs }
  })
  ipcMain.handle(
    'apps:verify',
    async (_e, payload: { appName: string; publisher: string; officialUrl?: string }) => {
      const config = await store.getConfig()
      const result = await verifyApp(payload.appName, payload.publisher, config, {
        officialUrl: payload.officialUrl
      })
      await store.setVerify(result)
      await store.appendRecord({
        kind: 'verify',
        title: `查证「${payload.appName}」的功能说明`,
        sub:
          result.status === 'verified'
            ? `官网：${result.sourceUrl}${result.via === 'registry' ? '（注册表登记）' : '（检索）'}`
            : `未查证 · ${result.reason ?? ''}`,
        result: result.status === 'verified' ? 'ok' : 'partial',
        reversible: false,
        sourceUrl: result.sourceUrl || undefined
      })
      return result
    }
  )

  // 邮箱连接自检：只连一次 IMAP 只读打开收件箱，不进模型、不拉正文；accountId 缺省测默认账号
  ipcMain.handle('mail:test', async (_e, patch: Partial<ButlerConfig>, accountId?: string) => {
    const config = { ...(await store.getConfig()), ...patch }
    return testMail(config, accountId)
  })

  // 应用功能说明的手写备注：覆盖查证生成的句子；空文本 = 删除该条
  ipcMain.handle('notes:list', () => store.getNotes())
  ipcMain.handle('notes:save', (_e, payload: { appName: string; text: string }) => {
    const appName = String(payload?.appName ?? '').trim()
    if (!appName) return null
    return store.saveNote(appName, String(payload?.text ?? ''))
  })

  // 设置页的「测试检索」：只发一次检索，不发模型请求
  ipcMain.handle('search:test', async (_e, patch: Partial<ButlerConfig>) => {
    const config = { ...(await store.getConfig()), ...patch }
    const started = Date.now()
    const outcome = await searchWeb('微信 官网', config)
    return {
      ok: outcome.ok,
      provider: outcome.provider,
      count: outcome.hits.length,
      latencyMs: outcome.durationMs || Date.now() - started,
      error: outcome.error,
      sample: outcome.hits.slice(0, 3).map((hit) => ({ title: hit.title, url: hit.url }))
    }
  })

  ipcMain.handle('startup:list', async () => {
    const { items, durationMs } = await listStartupItems()
    return { items, durationMs }
  })

  // 只读记录页。这里没有「撤销记录」这种接口：往日志里追加一条标记不等于把文件还原回来，
  // 叫「撤销」就是骗人。能撤回的只有回收站，那一步必须用户自己点（shell:recycle）
  ipcMain.handle('records:list', (_e, limit?: number) => store.listRecords(limit ?? 200))

  // 卸载快照：按 id 取原始快照；对比是即时算的（拿当下再查一遍注册表/目录/自启项），
  // 不落盘——diff 只陈述现状，用户随时可以重新问
  ipcMain.handle('snapshot:get', (_e, id: string) => store.getSnapshot(String(id ?? '')))
  ipcMain.handle('snapshot:diff', async (_e, id: string) => {
    const snapshot = await store.getSnapshot(String(id ?? ''))
    if (!snapshot) return null
    return diffSnapshot(snapshot)
  })

  // 停止：除了打断网络请求，还要把「正等着用户点卡」的那一次按拒绝收口——
  // 否则用户点了停止，那张卡还挂着，直到 180 s 超时才动
  ipcMain.handle('chat:abort', (_e, requestId: string) => {
    inflight.get(requestId)?.abort()
    settleAuthOfRequest(requestId, 'deny')
    return true
  })

  // 用户点了授权卡：把答案交回正在等待的闸门
  // 这里也过一遍白名单：渲染层传什么就转什么的话，一个畸形值会在闸门侧变成「已授权」
  ipcMain.handle('chat:answer', (_e, payload: { authId: string; answer: AuthAnswer }) => {
    if (!payload || typeof payload.authId !== 'string') return false
    const resolve = pendingAuth.get(payload.authId)
    if (!resolve) return false
    pendingAuth.delete(payload.authId)
    resolve(payload.answer === 'once' || payload.answer === 'always' ? payload.answer : 'deny')
    return true
  })

  ipcMain.handle(
    'chat:send',
    async (event, payload: { requestId: string; messages: ChatMessage[] }) => {
      const { requestId, messages } = payload
      const controller = new AbortController()
      inflight.set(requestId, controller)
      const sender = event.sender
      const emit = (raw: ChatPayload) => {
        if (!sender.isDestroyed()) sender.send('chat:event', { requestId, ...raw })
      }
      try {
        const result = await executeTurn({ requestId, messages, controller, emit, uiAuth: true })
        emit({ type: 'done', result })
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ type: 'error', message })
        return { error: message }
      } finally {
        // 本次请求里还没被回答的授权卡：收尾时一律按「拒绝」处理
        settleAuthOfRequest(requestId, 'deny')
        inflight.delete(requestId)
      }
    }
  )

  // ---- 定时任务（图标条 · 时钟） ----
  ipcMain.handle('tasks:list', () => store.listTasks())
  ipcMain.handle('tasks:save', async (_e, raw: Partial<TaskDef>) => {
    const task = normalizeTask(raw)
    if (!task.prompt) throw new Error('任务指令不能为空')
    await store.upsertTask(task)
    taskRunner.reschedule()
    broadcastTasks()
    return task
  })
  ipcMain.handle('tasks:delete', async (_e, id: string) => {
    const list = await store.deleteTask(id)
    taskRunner.reschedule()
    broadcastTasks()
    return list
  })
  ipcMain.handle('tasks:run', async (_e, id: string) => {
    const task = (await store.listTasks()).find((t) => t.id === id)
    if (!task) return { ok: false, detail: '任务不存在' }
    try {
      const summary = await runTaskOnce(task)
      await store.updateTask(task.id, {
        lastRun: new Date().toISOString(),
        lastResult: summary
      })
      broadcastTasks()
      return { ok: true, detail: summary }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void store.appendRecord({
        kind: 'task',
        title: `定时任务「${task.name}」运行`,
        sub: task.prompt.slice(0, 80),
        result: 'rejected',
        reversible: false
      })
      return { ok: false, detail: message.slice(0, 160) }
    }
  })

  // ---- 项目：目标 / 背景 / 约束 / 方案 / 常用指令（只存本地，不执行） ----
  ipcMain.handle('projects:list', () => store.listProjects())
  ipcMain.handle('projects:save', async (_e, raw: Partial<ProjectDef>) => {
    const name = String(raw?.name ?? '').trim().slice(0, 40)
    if (!name) throw new Error('项目名不能为空')
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()

    // 读-改-写整段交给 Store 排队：对话页「存为方案」和项目页自动保存撞在一起时，
    // 谁后写就把谁整条覆盖，这是原来 listProjects() 在队列外造成的
    return store.mutateProjects((list) => {
      const existing = list.find((p) => p.id === id)

    // 未传 prompts / plans 时保留原值，避免旧界面（或半截 patch）把方案冲掉
    const prompts = Array.isArray(raw?.prompts)
      ? raw.prompts.map((p) => String(p).trim().slice(0, 300)).filter(Boolean).slice(0, 12)
      : (existing?.prompts ?? [])

    const plans: PlanDef[] = Array.isArray(raw?.plans)
      ? raw.plans
          .map((p) => ({
            id: typeof p?.id === 'string' && p.id ? p.id : randomUUID(),
            title: String(p?.title ?? '').trim().slice(0, 60) || '未命名方案',
            body: String(p?.body ?? '').slice(0, 40000),
            createdAt: typeof p?.createdAt === 'string' && p.createdAt ? p.createdAt : new Date().toISOString(),
            prompt: typeof p?.prompt === 'string' && p.prompt ? p.prompt.slice(0, 4000) : undefined,
            decision:
              typeof p?.decision === 'string' && p.decision.trim() ? p.decision.trim().slice(0, 300) : undefined,
            options: Array.isArray(p?.options)
              ? p.options.map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 5)
              : undefined,
            recommended:
              typeof p?.recommended === 'string' && p.recommended.trim()
                ? p.recommended.trim().slice(0, 300)
                : undefined,
            estimate:
              typeof p?.estimate === 'string' && p.estimate.trim() ? p.estimate.trim().slice(0, 120) : undefined,
            firstStep:
              typeof p?.firstStep === 'string' && p.firstStep.trim() ? p.firstStep.trim().slice(0, 300) : undefined,
            source:
              p?.source && typeof p.source.sessionId === 'string' && typeof p.source.messageId === 'string'
                ? { sessionId: p.source.sessionId, messageId: p.source.messageId }
                : undefined
          }))
          .slice(0, 30)
      : (existing?.plans ?? [])

    const briefs: BriefDef[] = Array.isArray(raw?.briefs)
      ? raw.briefs
          .map((b) => ({
            id: typeof b?.id === 'string' && b.id ? b.id : randomUUID(),
            createdAt: typeof b?.createdAt === 'string' && b.createdAt ? b.createdAt : new Date().toISOString(),
            body: String(b?.body ?? '').slice(0, 40000),
            snapshot: b?.snapshot
              ? {
                  total: Number(b.snapshot.total) || 0,
                  done: Number(b.snapshot.done) || 0,
                  doing: Number(b.snapshot.doing) || 0,
                  blocked: Number(b.snapshot.blocked) || 0,
                  todo: Number(b.snapshot.todo) || 0
                }
              : undefined,
            byModel: Boolean(b?.byModel)
          }))
          .filter((b) => b.body.trim().length > 0)
          .slice(0, 20)
      : (existing?.briefs ?? [])

    const proj: ProjectDef = {
      id,
      name,
      goal: typeof raw?.goal === 'string' && raw.goal.trim() ? raw.goal.trim().slice(0, 200) : undefined,
      context:
        typeof raw?.context === 'string' && raw.context.trim() ? raw.context.trim().slice(0, 2000) : undefined,
      constraints:
        typeof raw?.constraints === 'string' && raw.constraints.trim()
          ? raw.constraints.trim().slice(0, 1000)
          : undefined,
      status:
        raw?.status === 'paused' || raw?.status === 'done' || raw?.status === 'active'
          ? raw.status
          : (existing?.status ?? 'active'),
      prompts,
      plans,
      briefs,
      createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
      const idx = list.findIndex((p) => p.id === proj.id)
      if (idx >= 0) list[idx] = proj
      else list.push(proj)
      return { list, result: list }
    })
  })
  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const list = await store.mutateProjects((current) => {
      const next = current.filter((p) => p.id !== id)
      return { list: next, result: next }
    })
    // 项目删了，挂在它下面的派发任务一起清掉，避免留下找不到归属的孤儿任务
    await store.mutateTodos((current) => {
      const next = current.filter((t) => t.projectId !== id)
      return { list: next, result: next }
    })
    return list
  })

  // ---- 项目档案导出：渲染层拼好 Markdown，这里只负责选路径、写文件 ----
  ipcMain.handle('projects:export', async (_e, payload: { name: string; markdown: string }) => {
    const name = String(payload?.name ?? '项目').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '项目'
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      title: '导出项目档案',
      defaultPath: path.join(app.getPath('documents'), `${name}-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await fs.writeFile(result.filePath, String(payload?.markdown ?? ''), 'utf8')
    return { ok: true, path: result.filePath }
  })

  // ---- 派发任务（方案拆出来的待办）：只跟踪，不排程、不自动执行 ----
  ipcMain.handle('todos:list', () => store.listTodos())
  ipcMain.handle('todos:save', async (_e, raw: Partial<TodoDef>) => {
    const title = String(raw?.title ?? '').trim().slice(0, 140)
    if (!title) throw new Error('任务标题不能为空')
    const status: TodoDef['status'] =
      raw?.status === 'doing' || raw?.status === 'blocked' || raw?.status === 'done' || raw?.status === 'dropped'
        ? raw.status
        : 'todo'
    const priority: TodoDef['priority'] = raw?.priority === 'high' || raw?.priority === 'low' ? raw.priority : 'normal'
    const todo: TodoDef = {
      id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
      projectId: typeof raw?.projectId === 'string' && raw.projectId ? raw.projectId : undefined,
      title,
      detail: typeof raw?.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 1000) : undefined,
      option: typeof raw?.option === 'string' && raw.option.trim() ? raw.option.trim().slice(0, 60) : undefined,
      source:
        raw?.source && typeof raw.source.sessionId === 'string' && typeof raw.source.messageId === 'string'
          ? { sessionId: raw.source.sessionId, messageId: raw.source.messageId }
          : undefined,
      status,
      priority,
      due: typeof raw?.due === 'string' && raw.due ? raw.due : undefined,
      createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
      doneAt: status === 'done' ? (typeof raw?.doneAt === 'string' && raw.doneAt ? raw.doneAt : new Date().toISOString()) : undefined
    }
    await store.mutateTodos((current) => {
      const next = [...current]
      const idx = next.findIndex((t) => t.id === todo.id)
      if (idx >= 0) next[idx] = todo
      else next.push(todo)
      return { list: next, result: next }
    })
    return todo
  })
  ipcMain.handle('todos:delete', async (_e, id: string) => {
    return store.mutateTodos((current) => {
      const next = current.filter((t) => t.id !== id)
      return { list: next, result: next }
    })
  })

  // ---- 会话：从 localStorage 搬到 userData/sessions.json，可长期回看 ----
  ipcMain.handle('sessions:list', () => store.listSessions())
  ipcMain.handle('sessions:save', async (_e, raw: Partial<ChatSession>) => {
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()
    const entry: ChatSession = {
      id,
      ts: Number(raw?.ts) || Date.now(),
      title: String(raw?.title ?? '未命名').slice(0, 80),
      messages: Array.isArray(raw?.messages) ? raw.messages.slice(0, 200) : []
    }
    await store.mutateSessions((current) => {
      const list = current.filter((s) => s.id !== id)
      list.unshift(entry)
      return { list: list.sort((a, b) => b.ts - a.ts).slice(0, 300), result: [] }
    })
    return entry
  })
  ipcMain.handle('sessions:delete', async (_e, id: string) => {
    return store.mutateSessions((current) => {
      const next = current.filter((s) => s.id !== id)
      return { list: next, result: next }
    })
  })
  ipcMain.handle('sessions:clear', async () => {
    await store.saveSessions([])
    return []
  })

  // ---- 能力开关（图标条 · 插头）：工具清单 + 启用状态 ----
  ipcMain.handle('tools:list', async () => {
    const config = await store.getConfig()
    const toggles = config.toolToggles ?? {}
    const tools = createTools({
      openSettings: async () => {},
      officialSite: async () => undefined,
      saveSnapshot: async () => {},
      appNotes: async () => ({}),
      appVerify: async () => ({})
    })
    return tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      effect: t.effect,
      allowAlways: t.allowAlways === true,
      enabled: toggles[t.name] !== false
    }))
  })

  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (!/^(https?:\/\/|ms-settings:)/i.test(url)) return false
    await shell.openExternal(url)
    return true
  })

  // 打开数据目录（存储与缓存分区）：只允许打开 userData 里的东西
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    const dir = app.getPath('userData')
    if (typeof p !== 'string' || !path.resolve(p).startsWith(path.resolve(dir))) return false
    const err = await shell.openPath(path.resolve(p))
    return err === ''
  })

  // 存储占用：列 userData 下的数据文件与大小，给「存储与缓存」分区
  ipcMain.handle('storage:stats', async () => {
    const dir = app.getPath('userData')
    const names = [
      'config.json',
      'records.jsonl',
      'records.jsonl.1',
      'records.jsonl.2',
      'tasks.json',
      'projects.json',
      'todos.json',
      'sessions.json',
      'auth-memory.json',
      'verify.json',
      'notes.json',
      'snapshots.json'
    ]
    const files: Array<{ file: string; bytes: number }> = []
    for (const file of names) {
      try {
        const st = await fs.stat(path.join(dir, file))
        files.push({ file, bytes: st.size })
      } catch {
        /* 不存在 = 还没生成 */
      }
    }
    return { dir, files }
  })

  // 记录页的「去还原」：只打开回收站窗口，还原仍然由用户点
  ipcMain.handle('shell:recycle', () => {
    openRecycleBin()
    return true
  })

  // 「始终允许」的记忆：设置页列出、可单条撤销、可全部撤销
  ipcMain.handle('auth:memory:list', () => store.listAlwaysAllowed())
  ipcMain.handle('auth:memory:revoke', async (_e, key: string) => {
    const list = await store.revokeAlwaysAllowed(key)
    alwaysAllowed.delete(key)
    return list
  })
  ipcMain.handle('auth:memory:clear', async () => {
    await store.clearAlwaysAllowed()
    alwaysAllowed.clear()
    return [] as AlwaysAllowedEntry[]
  })
}

void app.whenReady().then(async () => {
  await store.init()
  // 先把「始终允许」写进内存，否则重启后闸门会以为用户从没授权过
  for (const entry of await store.listAlwaysAllowed()) alwaysAllowed.add(entry.key)
  // 演示沙箱只是闸门的验收脚手架，仅开发态造一次。
  // 正式运行时不再往用户临时目录里塞假文件（删了下次开机又长出来，很怪）
  if (!app.isPackaged && process.env.BUTLER_SANDBOX !== '0') {
    await prepareSandbox().catch(() => [])
  }
  registerIpc()
  createWindow()
  // 定时任务调度器：启动即排程，错过今天这一次的任务会补跑一次
  taskRunner.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
