import { ipcMain } from 'electron'
import type { AlwaysAllowedEntry, ButlerConfig, ChatMessage } from '../../shared/types'
import { chatCompletion, pingModel } from '../agent/llm'
import { testMail } from '../node/mail'
import { searchWeb } from '../node/web'
import type { IpcContext } from './app'

/** 配置 / 密钥 / 自检 / 授权记忆 */
export function registerConfigIpc(ctx: IpcContext): void {
  ipcMain.handle('config:get', () => ctx.store.getConfig())
  ipcMain.handle('config:save', (_e, patch: Partial<ButlerConfig>) => ctx.store.saveConfig(patch))
  /** 密钥是加密落盘还是明文落盘：设置页那句提示要跟着变，不能骗人 */
  ipcMain.handle('config:secretsEncrypted', () => ctx.store.secretsEncrypted())
  ipcMain.handle('config:test', async (_e, patch: Partial<ButlerConfig>) => {
    const config = { ...(await ctx.store.getConfig()), ...patch }
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
    const config = await ctx.store.getConfig()
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

  // 邮箱连接自检：只连一次 IMAP 只读打开收件箱，不进模型、不拉正文
  ipcMain.handle('mail:test', async (_e, patch: Partial<ButlerConfig>, accountId?: string) => {
    const config = { ...(await ctx.store.getConfig()), ...patch }
    return testMail(config, accountId)
  })

  // 设置页的「测试检索」：只发一次检索，不发模型请求
  ipcMain.handle('search:test', async (_e, patch: Partial<ButlerConfig>) => {
    const config = { ...(await ctx.store.getConfig()), ...patch }
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

  // 应用功能说明的手写备注：覆盖查证生成的句子；空文本 = 删除该条
  ipcMain.handle('notes:list', () => ctx.store.getNotes())
  ipcMain.handle('notes:save', (_e, payload: { appName: string; text: string }) => {
    const appName = String(payload?.appName ?? '').trim()
    if (!appName) return null
    return ctx.store.saveNote(appName, String(payload?.text ?? ''))
  })

  // 「始终允许」的记忆：设置页列出、可单条撤销、可全部撤销
  ipcMain.handle('auth:memory:list', () => ctx.store.listAlwaysAllowed())
  ipcMain.handle('auth:memory:revoke', async (_e, key: string) => {
    const list = await ctx.store.revokeAlwaysAllowed(key)
    // 内存副本也要删，否则闸门还会以为这条授权有效
    ctx.alwaysAllowed.delete(key)
    return list
  })
  ipcMain.handle('auth:memory:clear', async () => {
    await ctx.store.clearAlwaysAllowed()
    ctx.alwaysAllowed.clear()
    return [] as AlwaysAllowedEntry[]
  })
}
