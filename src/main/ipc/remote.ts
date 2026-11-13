import { ipcMain } from 'electron'
import type { IpcContext } from './app'

/**
 * 远程入口（手机 App）的 IPC。
 *
 * 桌面这边只暴露四个动作：看状态、开关总闸、发配对码、踢设备。
 * **配对本身不在桌面做**——是手机带着码来换 token，走 HTTP（见 remote/server.ts）。
 * 这样桌面上永远不会出现一个"替手机登录"的按钮，权限来源始终是手机自己扫的那个码。
 */
export function registerRemoteIpc(ctx: IpcContext): void {
  ipcMain.handle('remote:state', () => ctx.remote.state())

  /**
   * 「手机连不上」自检。
   *
   * 放在 IPC 而不是渲染层拼：判断要读网卡、读防火墙配置、探测 Tailscale，
   * 这三样渲染进程都碰不到。返回的是一串**已经分好级**的结论，
   * 渲染层只负责显示——让界面去猜"绑回环意味着什么"会把判断分散到两处。
   */
  ipcMain.handle('remote:diagnose', () => ctx.remote.diagnose())

  ipcMain.handle('remote:enable', async (_e, enabled: boolean, lanAccess?: boolean) => {
    const want = enabled === true
    // 局域网测试模式只在"开启"时有意义；关掉时一并清掉，免得下次悄悄开着
    const lan = want && lanAccess === true
    if (want) {
      const ok = await ctx.remote.start(lan)
      if (!ok) {
        // 起不来就把配置也停在 false：否则重启后会一遍遍尝试同一个注定失败的端口
        await ctx.store.saveConfig({ remote: { enabled: false, lanAccess: false } })
        return ctx.remote.state()
      }
      await ctx.store.saveConfig({ remote: { enabled: true, lanAccess: lan } })
    } else {
      await ctx.remote.stop()
      await ctx.store.saveConfig({ remote: { enabled: false, lanAccess: false } })
    }
    return ctx.remote.state()
  })

  /**
   * 生成配对码。码只存在内存里、2 分钟有效、用一次作废。
   *
   * 返回里带着码，是因为桌面上必须能把它显示出来给用户输入/扫码；
   * 这是这个码唯一一次离开内存的路径，不写日志、不落盘。
   */
  ipcMain.handle('remote:pairing:issue', async () => {
    const result = await ctx.remote.issuePairingCode()
    if ('error' in result) return { ok: false, error: result.error, state: ctx.remote.state() }
    return { ok: true, code: result.code, expiresAt: result.expiresAt, state: ctx.remote.state() }
  })

  ipcMain.handle('remote:devices:revoke', async (_e, deviceId: string) => {
    const ok = await ctx.remote.revoke(String(deviceId ?? ''))
    return { ok, state: ctx.remote.state() }
  })

  ipcMain.handle('remote:devices:revokeAll', async () => {
    const revoked = await ctx.remote.revokeAll()
    return { revoked, state: ctx.remote.state() }
  })
}
