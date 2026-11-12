import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
  /**
   * 便携版的密钥可能在本机解不开（DPAPI 绑当前用户）。
   * 现在 decrypt 是静默回空串的，界面必须能说出"是解不开，不是没填"。
   */
  ipcMain.handle('config:secretIssues', () => ctx.store.undecryptableSecrets())

  /**
   * 便携版第一次跑：把本机 userData 里的配置复制过来。
   *
   * 只在便携模式开放，且只复制 config.json——会话、记录、记忆留在本机，
   * 和「只搬配置」的口径一致。目标已存在时不覆盖，除非调用方明确要覆盖。
   */
  ipcMain.handle('config:importLocal', async (_e, overwrite: boolean) => {
    if (!ctx.portable.active) return { ok: false, detail: '当前不是便携模式，配置本来就在本机' }
    const src = path.join(app.getPath('userData'), 'config.json')
    const dst = path.join(ctx.portable.configDir, 'config.json')
    try {
      const raw = await fs.readFile(src, 'utf8')
      if (!overwrite) {
        try {
          await fs.access(dst)
          return { ok: false, needConfirm: true, detail: '便携配置已经存在，要覆盖吗？' }
        } catch {
          /* 目标不存在：直接写 */
        }
      }
      await fs.mkdir(ctx.portable.configDir, { recursive: true })
      await fs.writeFile(dst, raw, 'utf8')
      return { ok: true, detail: `已从本机导入配置到 ${dst}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: `没有可导入的本机配置：${message}` }
    }
  })
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
      note: outcome.note,
      sample: outcome.hits.slice(0, 3).map((hit) => ({ title: hit.title, url: hit.url }))
    }
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
