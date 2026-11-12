import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * 远程入口的配对与设备白名单。
 *
 * 为什么是「一次性配对码 + token」而不是固定密码：
 * 固定密码会被记住、会被截图、会在别人电脑上被试着输入；而远程入口一旦被猜到，
 * 等于整台机器交出去（长庚能装软件、删文件）。一次性码用完即废，泄露了也没有第二次机会。
 *
 * 这个类刻意不碰文件系统和时钟：时间由外部注入，持久化由调用方负责。
 * 于是它能在测试里被精确地驱动（"现在正好过期"是可以断言的事）。
 */

export const PAIR_CODE_TTL_MS = 2 * 60_000
/** 同一个码最多可以被试错几次；超过就作废，必须重新生成 */
export const PAIR_CODE_MAX_ATTEMPTS = 5

export interface PairedDevice {
  id: string
  /** 给人看的名字（手机型号 / 用户自己起的） */
  label: string
  /** **只存哈希**：盘上不该出现任何能直接拿去用的 token */
  tokenHash: string
  createdAt: number
  lastSeenAt: number | null
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 定长比较，避免用字符串比较泄漏"前几位对了多久" */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export type RedeemResult =
  | { ok: true; token: string; device: PairedDevice }
  | { ok: false; reason: string }

export class PairingStore {
  private code: { value: string; expiresAt: number } | null = null
  private failedAttempts = 0
  private devices: PairedDevice[] = []

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 发一个新配对码；旧码立刻作废（同一时刻只允许一个有效码，少一个漏点） */
  issueCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.now() + PAIR_CODE_TTL_MS
    this.code = { value: code, expiresAt }
    this.failedAttempts = 0
    return { code, expiresAt }
  }

  /** 当场撤销当前配对码（用户关掉配对面板时调用） */
  clearCode(): void {
    this.code = null
    this.failedAttempts = 0
  }

  /**
   * 还剩多少毫秒有效；没有码或已过期返回 0。
   *
   * 过期不是靠定时器清理，而是每次用到时现算——定时器在进程休眠时会漂，
   * 而这个判断一旦出错，后果是"过期的码还能用"。
   */
  codeRemainingMs(): number {
    if (!this.code) return 0
    const left = this.code.expiresAt - this.now()
    if (left <= 0) {
      this.code = null
      return 0
    }
    return left
  }

  /**
   * 当前有效的配对码。给桌面配对面板显示用。
   *
   * 只在这个进程的内存里：配对码不该落盘，也不该出现在日志里。
   */
  peekCode(): { code: string; expiresAt: number } | null {
    const left = this.codeRemainingMs()
    if (!this.code || left <= 0) return null
    return { code: this.code.value, expiresAt: this.code.expiresAt }
  }

  redeem(code: string, label: string): RedeemResult {
    if (!this.code || this.codeRemainingMs() <= 0) {
      return { ok: false, reason: '配对码已过期，请在电脑上重新生成' }
    }
    if (this.failedAttempts >= PAIR_CODE_MAX_ATTEMPTS) {
      // 已经被人试爆了：作废这个码，让真正的用户重新生成
      this.code = null
      return { ok: false, reason: '配对码试错次数过多，已作废，请在电脑上重新生成' }
    }
    const input = String(code ?? '').trim()
    if (!sameHash(hashToken(input), hashToken(this.code.value))) {
      this.failedAttempts += 1
      // 不回报"错了还是过期了"之外的任何信息，也不回显正确的码
      return { ok: false, reason: '配对码不对' }
    }

    const token = randomBytes(32).toString('base64url')
    const device: PairedDevice = {
      id: randomBytes(8).toString('hex'),
      label: String(label ?? '').trim().slice(0, 60) || '手机',
      tokenHash: hashToken(token),
      createdAt: this.now(),
      lastSeenAt: null
    }
    this.devices.push(device)
    // 用一次就作废：这是"一次性"的全部含义，不能只写在注释里
    this.code = null
    this.failedAttempts = 0
    return { ok: true, token, device }
  }

  /** 校验 token，命中则刷新 lastSeenAt 并返回设备 */
  verify(token: string | null | undefined): PairedDevice | null {
    if (!token) return null
    const h = hashToken(String(token))
    const device = this.devices.find((d) => sameHash(d.tokenHash, h))
    if (!device) return null
    device.lastSeenAt = this.now()
    return device
  }

  /** 给界面看的设备清单：**不含 tokenHash**，界面没有理由拿到它 */
  listDevices(): Array<Omit<PairedDevice, 'tokenHash'>> {
    return this.devices.map(({ tokenHash: _drop, ...rest }) => rest)
  }

  revoke(deviceId: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== deviceId)
    return this.devices.length !== before
  }

  revokeAll(): number {
    const n = this.devices.length
    this.devices = []
    return n
  }

  /** 落盘用：包含哈希，调用方负责放到只有本机可读的位置 */
  snapshot(): PairedDevice[] {
    return this.devices.map((d) => ({ ...d }))
  }

  restore(devices: PairedDevice[]): void {
    this.devices = (Array.isArray(devices) ? devices : []).filter(
      (d): d is PairedDevice =>
        !!d &&
        typeof d.id === 'string' &&
        typeof d.tokenHash === 'string' &&
        typeof d.label === 'string' &&
        typeof d.createdAt === 'number'
    )
  }
}
