import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import type { AuthAnswer, AuthRequest, ChatMessage, ChatPayload, TaskDef, TurnResult } from '../shared/types'
import { runTurn, TOOL_BUDGET_STEPS, type GateHooks } from './agent/agent'
import { buildSystemPrompt } from './agent/prompt'
import { capabilityBrief, createTools } from './agent/tools'
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

export class TurnRuntime {
  constructor(private readonly opts: TurnRuntimeOptions) {}

  /** 构建本轮的工具集：按能力开关过滤，依赖由 Store 注入 */
  private toolsFor(toggles: Record<string, boolean>): ReturnType<typeof createTools> {
    const { store } = this.opts
    return createTools({
      openSettings: this.opts.openSettings,
      // 卸载卡上的「重装入口」：注册表没登记时，用查证过的官网兜底
      officialSite: async (appName) => {
        const known = (await store.getVerifyMap())[appName]
        return known?.status === 'verified' ? known.sourceUrl : undefined
      },
      saveSnapshot: (snapshot) => store.saveSnapshot(snapshot),
      appNotes: () => store.getNotes(),
      appVerify: () => store.getVerifyMap()
    }).filter((t) => toggles[t.name] !== false)
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
    // 能力开关（插件页）：toolToggles[name] === false 的工具不出现在本轮
    const tools = this.toolsFor(config.toolToggles ?? {})

    const system: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(
        { ...machineEnv(), hasSearch: config.searchProvider !== 'none', toolBudget: TOOL_BUDGET_STEPS },
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
