import { promises as fs } from 'node:fs'
import path from 'node:path'
import { logError } from '../log'
import { PairingStore, type PairedDevice } from './pairing'
import { DEFAULT_REMOTE_PORT, RemoteServer, type RemoteDeps } from './server'

/**
 * 远程入口的装配与总闸。
 *
 * 单独一层是为了让「开关」这件事有唯一负责人：桌面上的总闸、配对面板、设备清单
 * 都走这里，而不是各自去碰 server 或 pairing。关掉时连端口一起释放——
 * 「关掉了但端口还开着」不算关掉。
 */

const DEVICES_FILE = 'remote-devices.json'

export interface RemotePublicState {
  enabled: boolean
  address: string
  port: number
  devices: Array<Omit<PairedDevice, 'tokenHash'>>
  pairing: { code: string; expiresAt: number; remainingMs: number } | null
  listeners: number
  error?: string
}

export class RemoteService {
  readonly pairing = new PairingStore()
  private readonly server: RemoteServer
  private readonly devicesPath: string
  private enabled = false
  /** 磁盘上的设备列表只读一次；之后以内存为准（见 start 的注释） */
  private loaded = false
  private lastError: string | undefined

  constructor(
    deps: RemoteDeps,
    private readonly dataDir: string,
    private readonly preferredPort: number = DEFAULT_REMOTE_PORT
  ) {
    this.server = new RemoteServer(deps, this.pairing)
    this.devicesPath = path.join(dataDir, DEVICES_FILE)
  }

  /** 起服务并把已配对设备读回来。失败不抛：远程入口起不来不该让整个应用挂掉 */
  async start(): Promise<boolean> {
    /**
     * 只在**第一次**启动时读磁盘。
     *
     * 原来无条件 loadDevices：先开总闸、再配一台手机、然后关掉再打开，
     * 第二次 start 会用磁盘上的旧列表覆盖内存里刚配好的设备——
     * 表现是"刚配对完就提示 token 失效"。而且落盘是异步的，覆盖时磁盘上
     * 可能还是空的，于是一份空列表被写回去，设备就真的没了。
     */
    if (!this.loaded) {
      await this.loadDevices()
      this.loaded = true
    }
    try {
      // 只监听回环：外面那层是 frpc，长庚自己永远不直接面对公网
      await this.server.listen(this.preferredPort, '127.0.0.1')
      this.enabled = true
      this.lastError = undefined
      return true
    } catch (err) {
      this.enabled = false
      this.lastError = err instanceof Error ? err.message : String(err)
      logError('remote-start', err)
      return false
    }
  }

  async stop(): Promise<void> {
    // 先置 false：即便 close 抛错，语义上也已经关掉了
    this.enabled = false
    this.pairing.clearCode()
    await this.server.close()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get hub() {
    return this.server.hub
  }

  /**
   * 生成配对码。服务没开时自动开——用户点「配对」就是在表达「我要开」。
   *
   * 这里只发码，落盘在设备真的配对成功之后（见 redeem 的调用方）。
   */
  async issuePairingCode(): Promise<{ code: string; expiresAt: number } | { error: string }> {
    if (!this.enabled) {
      const ok = await this.start()
      if (!ok) return { error: this.lastError ?? '远程入口启动失败' }
    }
    return this.pairing.issueCode()
  }

  /** 配对成功后把设备白名单落盘（只写哈希） */
  async persistDevices(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true })
      const tmp = `${this.devicesPath}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ devices: this.pairing.snapshot() }, null, 2), 'utf8')
      await fs.rename(tmp, this.devicesPath)
    } catch (err) {
      logError('remote-devices-save', err)
    }
  }

  async revoke(deviceId: string): Promise<boolean> {
    const ok = this.pairing.revoke(deviceId)
    if (ok) await this.persistDevices()
    return ok
  }

  async revokeAll(): Promise<number> {
    const n = this.pairing.revokeAll()
    if (n > 0) await this.persistDevices()
    return n
  }

  state(): RemotePublicState {
    const live = this.pairing.peekCode()
    return {
      enabled: this.enabled,
      address: this.server.address,
      port: this.server.port(),
      devices: this.pairing.listDevices(),
      pairing: live
        ? { code: live.code, expiresAt: live.expiresAt, remainingMs: live.expiresAt - Date.now() }
        : null,
      listeners: this.server.hub.size,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      const raw = await fs.readFile(this.devicesPath, 'utf8')
      const parsed = JSON.parse(raw) as { devices?: unknown }
      if (parsed && Array.isArray(parsed.devices)) this.pairing.restore(parsed.devices as PairedDevice[])
    } catch {
      /* 没有文件 = 从来没配对过，正常 */
    }
  }
}
