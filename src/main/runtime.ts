import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type {
  AuthAnswer,
  AuthRequest,
  ButlerConfig,
  ChatMessage,
  ChatPayload,
  TaskDef,
  ToolChoiceRequest,
  ToolEffect,
  TurnResult
} from '../shared/types'
import { runTurn, TOOL_BUDGET_STEPS, type GateHooks } from './agent/agent'
import { buildSystemPrompt } from './agent/prompt'
import { capabilityBrief, createTools } from './agent/tools'
import type { ToolDef } from './agent/tool-types'
import { memoryBlock } from './node/memory'
import { focusProcessWindow, probeLaunch } from './node/running'
import type { Store } from './node/store'

/**
 * 一轮对话的运行环境：工具装配 + 授权闸门的实现 + 系统提示词。
 *
 * 从 index.ts 里拆出来，是因为这段和窗口、IPC 注册没有关系——
 * 改授权行为不该被迫翻完整个主进程入口。
 */

const AUTH_TIMEOUT_MS = 60_000

export function machineEnv(): {
  machineName: string
  userName: string
  osVersion: string
  today: string
} {
  return {
    machineName: os.hostname(),
    userName: os.userInfo().username,
    osVersion: `Windows ${os.release()} (${os.arch()})`,
    today: new Date().toLocaleDateString('zh-CN')
  }
}

/**
 * 授权卡与候选卡的登记簿。
 *
 * 两件事必须成对：谁在等卡（pendingAuth / pendingChoice），以及哪个请求名下
 * 挂着哪些卡（pendingByRequest）。少了后者，用户点「停止」时就只能等 60 秒超时。
 *
 * 候选卡和授权卡共用一张请求名下的登记簿，但答案类型不同：
 * 授权卡的答案是枚举（once/always/deny），候选卡的答案是用户点中的那个值。
 * 收口时一律按「没选 / 拒绝」处理——停止就是什么都没选。
 */
export class AuthBroker {
  private readonly pendingAuth = new Map<string, (answer: AuthAnswer) => void>()
  private readonly pendingChoice = new Map<string, (value: string | null) => void>()
  /**
   * 每张候选卡上真实列出的值。
   *
   * 存在的理由：choose() 收到的 value 来自渲染层，属于不可信输入——它会被写回
   * 工具参数再拿去解析执行。只接受"卡上真有的那些"，才守得住
   * 「用户点了 A、实际装 B」那条缝（K7 堵的就是这个）。
   */
  private readonly offeredByChoice = new Map<string, Set<string>>()
  private readonly pendingByRequest = new Map<string, Set<string>>()

  /** 登记一张授权卡，返回"用户点了什么"的 Promise */
  wait(request: AuthRequest, requestId: string, emit: (payload: ChatPayload) => void): Promise<AuthAnswer> {
    return new Promise<AuthAnswer>((resolve) => {
      const ids = this.pendingByRequest.get(requestId) ?? new Set<string>()
      this.pendingByRequest.set(requestId, ids)
      const timer = setTimeout(() => {
        this.pendingAuth.delete(request.id)
        ids.delete(request.id)
        emit({ type: 'authExpired', authId: request.id })
        resolve('expired')
      }, AUTH_TIMEOUT_MS)
      ids.add(request.id)
      this.pendingAuth.set(request.id, (answer) => {
        clearTimeout(timer)
        ids.delete(request.id)
        resolve(answer)
      })
      emit({ type: 'auth', request })
    })
  }

  /**
   * 登记一张候选卡，返回"用户点了哪个值"；取消或超时返回 null。
   *
   * 超时不算「拒绝」而算「取消」：这里问的是"哪一个"，没人回答时正确的做法是
   * 什么都不装，而不是替用户挑一个。所以超时只收口，不产生任何副作用。
   */
  waitChoice(request: ToolChoiceRequest, requestId: string, emit: (payload: ChatPayload) => void): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const ids = this.pendingByRequest.get(requestId) ?? new Set<string>()
      this.pendingByRequest.set(requestId, ids)
      const timer = setTimeout(() => {
        this.pendingChoice.delete(request.id)
        this.offeredByChoice.delete(request.id)
        ids.delete(request.id)
        emit({ type: 'choiceExpired', choiceId: request.id })
        resolve(null)
      }, AUTH_TIMEOUT_MS)
      ids.add(request.id)
      this.offeredByChoice.set(request.id, new Set(request.options.map((o) => o.value)))
      this.pendingChoice.set(request.id, (value) => {
        clearTimeout(timer)
        ids.delete(request.id)
        resolve(value)
      })
      emit({ type: 'choice', request })
    })
  }

  /** 用户点了某张卡：把答案交回等待中的闸门 */
  answer(authId: string, answer: AuthAnswer): boolean {
    const resolve = this.pendingAuth.get(authId)
    if (!resolve) return false
    this.pendingAuth.delete(authId)
    // 只认这两个「通过」值：渲染层传什么就转什么的话，一个畸形值会变成「已授权」
    resolve(answer === 'once' || answer === 'always' ? answer : 'deny')
    return true
  }

  /**
   * 用户点了某个候选。不在候选集里的值一律按「没选」处理。
   *
   * 静默忽略和显式拒绝在这里是同一个结果（都不装），所以不必区分错误类型：
   * 渲染层拿到 false 就够它把卡标成失效了。
   */
  choose(choiceId: string, value: string): boolean {
    const resolve = this.pendingChoice.get(choiceId)
    if (!resolve) return false
    this.pendingChoice.delete(choiceId)
    const offered = this.offeredByChoice.get(choiceId)
    this.offeredByChoice.delete(choiceId)
    resolve(offered?.has(value) ? value : null)
    return true
  }

  /** 把某个请求名下所有未作答的卡按给定答案收口（停止、请求结束时用） */
  settleRequest(requestId: string, answer: AuthAnswer): void {
    const ids = this.pendingByRequest.get(requestId)
    if (!ids) return
    for (const cardId of [...ids]) {
      const auth = this.pendingAuth.get(cardId)
      if (auth) {
        this.pendingAuth.delete(cardId)
        ids.delete(cardId)
        auth(answer)
        continue
      }
      // 候选卡：任何收口都按「没选」处理，不留悬念也不替用户选
      const choice = this.pendingChoice.get(cardId)
      this.pendingChoice.delete(cardId)
      this.offeredByChoice.delete(cardId)
      ids.delete(cardId)
      choice?.(null)
    }
    this.pendingByRequest.delete(requestId)
  }
}

export interface TurnRuntimeOptions {
  store: Store
  broker: AuthBroker
  /** 「始终允许」的内存副本：闸门要同步判断，文件只用于持久化与展示 */
  alwaysAllowed: Set<string>
  openSettings: (page: string) => Promise<void>
}

const MUTATING_EFFECTS = new Set<ToolEffect>(['write', 'destroy', 'install'])

/**
 * 决定一次对话里到底有哪些工具可用。
 *
 * 单一入口：运行时装配工具、插件页显示开关状态都走这里，
 * 免得两处各写一遍过滤条件，一处改了另一处忘。
 */
export function filterTools(
  tools: ToolDef[],
  options: { toggles?: Record<string, boolean>; readOnly?: boolean }
): ToolDef[] {
  const enabled = tools.filter((t) => options.toggles?.[t.name] !== false)
  return options.readOnly ? enabled.filter((t) => !MUTATING_EFFECTS.has(t.effect)) : enabled
}

export class TurnRuntime {
  constructor(private readonly opts: TurnRuntimeOptions) {}

  /**
   * 构建本轮的工具集：按能力开关与只读模式过滤，依赖由 Store 注入。
   *
   * 只读模式不是"提示模型别写"——那些工具根本不出现在工具清单里，
   * 模型连申请的机会都没有。能力段由注册表生成，所以提示词里那句
   * 「当前版本没有能改动机器的工具」也会自动成立，不需要另写一份。
   */
  private toolsFor(toggles: Record<string, boolean>, readOnly: boolean, worker: ButlerConfig['worker'] = {}): ToolDef[] {
    const { store } = this.opts
    const all = createTools({
      openSettings: this.opts.openSettings,
      // 「打开哔哩哔哩」这类请求：目标只能是 .lnk/.url 或系统应用清单里的一条
      launchShortcut: (filePath) => launchShortcut(filePath),
      // 豆包这类不建快捷方式的程序：走 shell:AppsFolder
      launchAppsFolder: (appId) => launchAppsFolder(appId),
      // 启动前先看它是不是已经开着：开着就不再启动一份，把那个窗口叫到前面
      probeLaunch: (lnkPath) => probeLaunch(lnkPath),
      focusApp: (pid) => focusProcessWindow(pid),
      // 「打开桌面上的『应用软件』」：目录不是快捷方式，走 node/folder.ts 单独解析
      openFolder: (dirPath) => openFolder(dirPath),
      // 「把那个 Word 打开」：会执行的后缀在 node/file.ts 就拒了
      openFile: (filePath) => openFile(filePath),
      // 卸载卡上的「重装入口」：注册表没登记时，用查证过的官网兜底
      officialSite: async (appName) => {
        const known = (await store.getVerifyMap())[appName]
        return known?.status === 'verified' ? known.sourceUrl : undefined
      },
      saveSnapshot: (snapshot) => store.saveSnapshot(snapshot),
      appNotes: () => store.getNotes(),
      appVerify: () => store.getVerifyMap(),
      memory: {
        list: () => store.listMemory(),
        save: (list) => store.saveMemory(list)
      },
      /**
       * 管家装过的程序（显示名 → 安装时间），供应用台账标注"是不是管家装的"。
       *
       * 不另建台账文件：装成功的动作本来就在 records.jsonl 里，多存一份就多一处会不一致。
       * 只读最近 500 条，滚出这个窗口的老安装记录会查不到——标注是"有据可查的加分项"，
       * 查不到就当不是，不猜。
       */
      butlerInstalls: async () => {
        const out: Record<string, string> = {}
        for (const entry of await store.listRecords(500)) {
          if (entry.effect !== 'install' || entry.result !== 'ok' || !entry.installedName) continue
          // listRecords 最新的在前：第一次遇到的就是这台机器上最近一次装它
          if (!out[entry.installedName]) out[entry.installedName] = entry.ts
        }
        return out
      },
      /**
       * 委派的工作目录：放在 userData 下，不落在任何代码仓库里。
       *
       * 用户正在用 Claude Code 改这个仓库；委派出去的任务如果动同一个目录，
       * 会和他手上的活互相覆盖。所以每次委派都是独立目录（见 orchestrator/delegate.ts）。
       */
      delegate: {
        rootDir: path.join(app.getPath('userData'), 'orchestrator'),
        worker: worker ?? {}
      }
    })
    return filterTools(all, { toggles, readOnly })
  }

  private gateFor(requestId: string, emit: (payload: ChatPayload) => void, uiAuth: boolean): GateHooks {
    const { store, broker, alwaysAllowed } = this.opts
    return {
      requestAuth: (request) => {
        // 定时任务无人在场：写操作当场拒绝（审计照常留痕），绝不默默放行
        if (!uiAuth) return Promise.resolve<AuthAnswer>('deny')
        return broker.wait(request, requestId, emit)
      },
      /**
       * 候选卡同样只在有人在看的时候才发。
       *
       * 返回 null 而不是抛错：闸门把 null 当「用户取消」，落一条"什么都没改动"的
       * 审计就收尾。无人在场的定时任务于是走的是同一条失败路径——
       * 不是"没人能点所以卡住了"，而是"没人能确认所以不做"。
       */
      requestChoice: (request) => {
        if (!uiAuth) return Promise.resolve<string | null>(null)
        return broker.waitChoice(request, requestId, emit)
      },
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
  }

  /**
   * 跑一轮对话：chat:send（有人在看）与定时任务（无人在场）共用同一条链路。
   * 区别只在授权：uiAuth=false 时需要授权的操作一律当场拒绝（fail-closed），照样留痕。
   */
  async executeTurn(params: {
    requestId: string
    messages: ChatMessage[]
    controller: AbortController
    emit: (raw: ChatPayload) => void
    uiAuth: boolean
  }): Promise<TurnResult> {
    const { requestId, messages, controller, emit, uiAuth } = params
    const config = await this.opts.store.getConfig()
    // 能力开关（插件页）+ 只读模式（权限与安全）：两者都决定本轮有哪些工具
    const tools = this.toolsFor(config.toolToggles ?? {}, config.readOnly === true, config.worker)

    // 跨会话记忆：每轮都读一次，用户刚删掉的东西不该还出现在提示词里
    let memory = ''
    try {
      memory = memoryBlock(await this.opts.store.listMemory())
    } catch {
      /* 记忆读失败不该让整轮对话挂掉，当没有记忆处理 */
    }

    const system: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(
        {
          ...machineEnv(),
          hasSearch: config.searchProvider !== 'none',
          toolBudget: TOOL_BUDGET_STEPS,
          memory
        },
        capabilityBrief(tools)
      )
    }

    const { result } = await runTurn({
      messages: [system, ...messages],
      config,
      tools,
      signal: controller.signal,
      emit,
      gate: this.gateFor(requestId, emit, uiAuth),
      ctx: {
        config,
        signal: controller.signal,
        record: (entry) => {
          void this.opts.store.appendRecord(entry)
          return { ...entry, id: randomUUID(), ts: new Date().toISOString() }
        }
      }
    })
    return result
  }

  /** 定时任务跑一轮（无头）：结果摘要回写任务卡，过程留痕进操作记录 */
  async runTaskOnce(task: TaskDef): Promise<string> {
    const result = await this.executeTurn({
      requestId: `task-${task.id}-${Date.now()}`,
      messages: [{ role: 'user', content: task.prompt }],
      controller: new AbortController(),
      emit: () => {},
      uiAuth: false
    })
    void this.opts.store.appendRecord({
      kind: 'task',
      title: `定时任务「${task.name}」运行`,
      sub: task.prompt.slice(0, 80),
      result: 'ok',
      reversible: false
    })
    return result.text?.slice(0, 140) || '完成（无文本输出）'
  }
}

/** 打开系统设置页：渲染层不能直接调 shell，这里包一层给工具用 */
export const openSettingsPage = (page: string): Promise<void> => shell.openExternal(page)

/**
 * 启动开始菜单快捷方式：渲染层同样不能直接碰 shell。
 *
 * `shell.openPath` 成功返回空字符串、失败返回原因，正好对上工具层要的签名
 * （我们不去猜它启动的是 exe 还是 UWP 应用，外壳自己知道）。
 */
export const launchShortcut = (filePath: string): Promise<string> => shell.openPath(filePath)

/**
 * 启动系统应用清单里的条目（豆包、商店应用这类不建快捷方式的程序）。
 *
 * 走 `explorer.exe shell:AppsFolder\<AppID>`：这是系统自己的激活入口，
 * 和用户点开始菜单里那一下等价。真机验过两种 AppID ——
 * `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`（打包应用）和
 * `Doubao.ChatApp`（普通 AppID）都能起来。
 *
 * 不用 `shell.openPath`：它对着 AppID 字符串只会回一句 Failed to open path。
 * 也不能拿 explorer 的退出码判成败（**它永远返回 1**，哪怕窗口已经开了）。
 */
export const launchAppsFolder = (appId: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'explorer.exe',
      [`shell:AppsFolder\\${appId}`],
      { windowsHide: true, timeout: 15_000 },
      // 只看"能不能把 explorer 拉起来"：它正常退出也是 1，所以没有错误信息就当成功
      () => resolve('')
    )
  })

/**
 * 打开一个目录：和打开程序走同一个外壳接口，区别只在传进去的东西。
 *
 * 传目录 → 资源管理器；传文件 → "打开"那个文件（exe 就是执行）。
 * 所以 node/folder.ts 在解析阶段就要求 isDirectory()，这里收到的只会是目录。
 */
export const openFolder = (dirPath: string): Promise<string> => shell.openPath(dirPath)

/**
 * 打开一个文件：同一个外壳接口，传的是文件而不是目录。
 *
 * 「打开」的含义由文件类型决定：文档是拉起对应的查看器，图片是看图，音视频是播放。
 * 会执行的后缀（exe/bat/ps1/lnk/msi/reg…）在 node/file.ts 的解析阶段就被拒掉，
 * 所以走到这里的不会是"一步就把程序跑起来"的东西。
 */
export const openFile = (filePath: string): Promise<string> => shell.openPath(filePath)
