import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import type { AuthAnswer, AuthRequest, ChatMessage, ChatPayload, TaskDef, ToolEffect, TurnResult } from '../shared/types'
import { runTurn, TOOL_BUDGET_STEPS, type GateHooks } from './agent/agent'
import { buildSystemPrompt } from './agent/prompt'
import { capabilityBrief, createTools } from './agent/tools'
import type { ToolDef } from './agent/tool-types'
import { memoryBlock } from './node/memory'
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
 * 授权卡的登记簿。
 *
 * 两件事必须成对：谁在等卡（pendingAuth），以及哪个请求名下挂着哪些卡
 *（pendingByRequest）。少了后者，用户点「停止」时就只能等 60 秒超时。
 */
export class AuthBroker {
  private readonly pendingAuth = new Map<string, (answer: AuthAnswer) => void>()
  private readonly pendingByRequest = new Map<string, Set<string>>()

  /** 登记一张卡，返回"用户点了什么"的 Promise */
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

  /** 用户点了某张卡：把答案交回等待中的闸门 */
  answer(authId: string, answer: AuthAnswer): boolean {
    const resolve = this.pendingAuth.get(authId)
    if (!resolve) return false
    this.pendingAuth.delete(authId)
    // 只认这两个「通过」值：渲染层传什么就转什么的话，一个畸形值会变成「已授权」
    resolve(answer === 'once' || answer === 'always' ? answer : 'deny')
    return true
  }

  /** 把某个请求名下所有未作答的卡按给定答案收口（停止、请求结束时用） */
  settleRequest(requestId: string, answer: AuthAnswer): void {
    const ids = this.pendingByRequest.get(requestId)
    if (!ids) return
    for (const authId of [...ids]) {
      const resolve = this.pendingAuth.get(authId)
      this.pendingAuth.delete(authId)
      ids.delete(authId)
      resolve?.(answer)
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
  private toolsFor(toggles: Record<string, boolean>, readOnly: boolean): ToolDef[] {
    const { store } = this.opts
    const all = createTools({
      openSettings: this.opts.openSettings,
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
    const tools = this.toolsFor(config.toolToggles ?? {}, config.readOnly === true)

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
