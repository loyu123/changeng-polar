import { ipcMain } from 'electron'
import type { AuthAnswer, ChatMessage, ChatPayload } from '../../shared/types'
import { listInstalledApps, listStartupItems } from '../node/registry'
import { diffSnapshot } from '../node/snapshot'
import { searchAll } from '../node/search'
import { verifyApp } from '../verify'
import type { IpcContext } from './app'

/** 对话、记录、全局搜索、应用台账 */
export function registerChatIpc(ctx: IpcContext): void {
  // 停止：除了打断网络请求，还要把「正等着用户点卡」的那一次按拒绝收口——
  // 否则用户点了停止，那张卡还挂着，直到超时才能动
  ipcMain.handle('chat:abort', (_e, requestId: string) => {
    ctx.inflight.get(requestId)?.abort()
    ctx.auth.settleRequest(requestId, 'deny')
    return true
  })

  // 用户点了授权卡：把答案交回正在等待的闸门
  ipcMain.handle('chat:answer', (_e, payload: { authId: string; answer: AuthAnswer }) => {
    if (!payload || typeof payload.authId !== 'string') return false
    return ctx.auth.answer(payload.authId, payload.answer)
  })

  /**
   * 用户点了候选卡上的一项：把选中的值交回闸门，闸门会拿它**重新解析一次**，
   * 再弹正常的授权卡。所以这里点完不等于装，界面上也要说清楚。
   */
  ipcMain.handle('chat:choose', (_e, payload: { choiceId: string; value: string }) => {
    if (!payload || typeof payload.choiceId !== 'string' || typeof payload.value !== 'string') return false
    // 只接受卡上真有的值：Broker 里核对，见 AuthBroker.choose
    return ctx.auth.choose(payload.choiceId, payload.value)
  })

  ipcMain.handle('chat:send', async (event, payload: { requestId: string; messages: ChatMessage[] }) => {
    const { requestId, messages } = payload
    const controller = new AbortController()
    ctx.inflight.set(requestId, controller)
    const sender = event.sender
    const emit = (raw: ChatPayload) => {
      if (!sender.isDestroyed()) sender.send('chat:event', { requestId, ...raw })
    }
    try {
      const result = await ctx.executeTurn({ requestId, messages, controller, emit, uiAuth: true })
      emit({ type: 'done', result })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'error', message })
      return { error: message }
    } finally {
      // 本次请求里还没被回答的授权卡：收尾时一律按「拒绝」处理
      ctx.auth.settleRequest(requestId, 'deny')
      ctx.inflight.delete(requestId)
    }
  })

  // 只读记录页。这里没有「撤销记录」这种接口：往日志里追加一条标记不等于把文件还原回来，
  // 叫「撤销」就是骗人。能撤回的只有回收站，那一步必须用户自己点（shell:recycle）
  ipcMain.handle('records:list', (_e, limit?: number) => ctx.store.listRecords(limit ?? 200))

  /**
   * 全局搜索在主进程做：会话数据本来就在这里，扫完只把命中的几十条送出去。
   * 原来渲染层一打开搜索框就拉 300 条会话的全部消息，每次按键全量扫一遍。
   */
  ipcMain.handle('search:all', async (_e, query: string, limit?: number) => {
    const [projects, todos, sessions] = await Promise.all([
      ctx.store.listProjects(),
      ctx.store.listTodos(),
      ctx.store.listSessions()
    ])
    return searchAll({ projects, todos, sessions, query: String(query ?? ''), limit })
  })

  // 卸载快照：按 id 取原始快照；对比是即时算的（拿当下再查一遍注册表/目录/自启项），
  // 不落盘——diff 只陈述现状，用户随时可以重新问
  ipcMain.handle('snapshot:get', (_e, id: string) => ctx.store.getSnapshot(String(id ?? '')))
  ipcMain.handle('snapshot:diff', async (_e, id: string) => {
    const snapshot = await ctx.store.getSnapshot(String(id ?? ''))
    if (!snapshot) return null
    return diffSnapshot(snapshot)
  })

  // ---- 应用台账 ----
  // 总览页的"已装应用"计数要用它（台账页已移除，但这项统计还有用）
  ipcMain.handle('apps:list', async () => {
    const { apps, durationMs } = await listInstalledApps()
    return { apps, durationMs }
  })
  ipcMain.handle('apps:verify', async (_e, payload: { appName: string; publisher: string; officialUrl?: string }) => {
    const config = await ctx.store.getConfig()
    const result = await verifyApp(payload.appName, payload.publisher, config, {
      officialUrl: payload.officialUrl
    })
    await ctx.store.setVerify(result)
    await ctx.store.appendRecord({
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
  })

  ipcMain.handle('startup:list', async () => {
    const { items, durationMs } = await listStartupItems()
    return { items, durationMs }
  })
}
