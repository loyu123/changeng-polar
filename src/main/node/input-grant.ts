/**
 * 模拟键鼠的「时间窗授权」。
 *
 * 为什么需要这个东西：模拟鼠标的能力是**无粒度**的——一旦能动鼠标，
 * 它就能点这块屏幕上的任何东西（包括长庚自己的授权卡、别的程序的「确定」）。
 * 逐次点确认又不可用：填一个表单要批十几次，手机上批到手软，最后用户会
 * 学会不看内容直接点允许——那比不批更糟。
 *
 * 所以做成"一段时间内的通行证"：
 * - 用户批准一次，开一个 **60 秒 / 最多 10 个动作** 的窗口
 * - 窗口内免卡，但每个动作都照常写审计（谁在什么时候点了哪儿）
 * - 超时或额度用完立刻失效，下一次要重新批
 * - 用户随时能撤销（关掉窗口）
 *
 * 时间由外部注入，测试里可以精确驱动"现在正好过期"。
 */

export const INPUT_GRANT_MS = 60_000
export const INPUT_GRANT_MAX_ACTIONS = 10

export interface GrantState {
  active: boolean
  /** 窗口到期时刻（ms）；没开时为 null */
  expiresAt: number | null
  /** 还剩几个动作额度 */
  remaining: number
  /** 用户批准时给的理由（授权卡上显示过的那句） */
  reason?: string
}

export type ConsumeResult = { ok: true } | { ok: false; reason: string }

export class InputGrant {
  private expiresAt: number | null = null
  private remaining = 0
  private reason: string | undefined

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 用户批准后开窗口。
   *
   * 每次 open 都**重置**额度与时间：用户又批了一次，就该是新的完整窗口，
   * 而不是在上一次的余量上叠加（叠加会让有效期越来越长，和"每次都要批"矛盾）。
   */
  open(reason?: string): void {
    this.expiresAt = this.now() + INPUT_GRANT_MS
    this.remaining = INPUT_GRANT_MAX_ACTIONS
    this.reason = reason
  }

  /**
   * 每个输入动作前调用一次。
   *
   * 返回 ok 才允许真正动鼠标/键盘；不 ok 时调用方必须**拒绝这次动作并重新弹卡**，
   * 不能"先做了再说"——那样时间窗就形同虚设。
   */
  consume(): ConsumeResult {
    if (this.expiresAt === null) return { ok: false, reason: '还没有授权：需要你先批准这一段操作' }
    if (this.now() >= this.expiresAt) {
      this.close()
      return { ok: false, reason: '授权已过期（窗口 60 秒），需要重新批准' }
    }
    if (this.remaining <= 0) {
      this.close()
      return { ok: false, reason: `授权额度已用完（最多 ${INPUT_GRANT_MAX_ACTIONS} 个动作），需要重新批准` }
    }
    this.remaining -= 1
    return { ok: true }
  }

  close(): void {
    this.expiresAt = null
    this.remaining = 0
    this.reason = undefined
  }

  get active(): boolean {
    return this.expiresAt !== null && this.now() < this.expiresAt && this.remaining > 0
  }

  state(): GrantState {
    const live = this.active
    return {
      active: live,
      expiresAt: live ? this.expiresAt : null,
      remaining: live ? this.remaining : 0,
      ...(live && this.reason ? { reason: this.reason } : {})
    }
  }
}
