import { ipcMain } from 'electron'
import type { AlwaysAllowedEntry, ButlerConfig } from '../../shared/types'
import { pingModel } from '../agent/llm'
import { testMail } from '../node/mail'
import { searchWeb } from '../node/web'
import { mergeMemory, removeMemory } from '../node/memory'
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

  // ---- 跨会话记忆：用户能看、能删、能自己加一条 ----
  ipcMain.handle('memory:list', () => ctx.store.listMemory())
  ipcMain.handle('memory:save', async (_e, input: { kind?: string; text?: string }) => {
    let rejected = ''
    const list = await ctx.store.mutateMemory((current) => {
      const outcome = mergeMemory(current, { kind: input?.kind, text: input?.text })
      if (!outcome.ok) {
        rejected = outcome.reason
        return { list: current, result: current }
      }
      return { list: outcome.list, result: outcome.list }
    })
    return rejected ? { ok: false, reason: rejected, list } : { ok: true, list }
  })
  ipcMain.handle('memory:delete', (_e, ref: string) =>
    ctx.store.mutateMemory((current) => {
      const { list } = removeMemory(current, String(ref ?? ''))
      return { list, result: list }
    })
  )
  ipcMain.handle('memory:clear', () => ctx.store.mutateMemory(() => ({ list: [], result: [] })))
}
