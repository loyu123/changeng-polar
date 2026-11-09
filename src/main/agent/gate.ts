import { randomUUID } from 'node:crypto'
import type { AuthAnswer, AuthRequest, AuthzDecision, RecordEntry, RecordKind } from '../../shared/types'
import type { ToolContext, ToolDef, ToolPlan, ToolResult, ToolTarget } from './tool-types'

/**
 * 授权闸门：所有工具调用都必须从这里穿过。
 *
 * read / ui  → 自动放行，记审计
 * write      → 先备份，备份失败不执行；执行后记 undo 句柄
 * destroy    → 生成授权卡等用户点；「拒绝」就什么都不做
 *
 * 唯一不放在这里的东西：判断"这次操作危不危险"——那由工具自己声明 effect，
 * 闸门只按声明执行，不猜。
 */

export type { AuthAnswer }

export interface GateHooks {
  /** 弹授权卡，等用户点；超时/无人应答返回 deny */
  requestAuth: (request: AuthRequest) => Promise<AuthAnswer>
  /** 「始终允许」白名单：key = `${tool}::${target}` */
  isRemembered: (key: string) => boolean
  remember: (key: string, request: AuthRequest) => void
  /** 统一审计入口 */
  record: (entry: Omit<RecordEntry, 'id' | 'ts'>) => void
  /** 演练模式：判定照走，但不真正执行（评测里验证拦截用） */
  dryRun?: boolean
}

const KIND_BY_EFFECT: Record<string, RecordKind> = {
  read: 'read',
  ui: 'ui',
  write: 'write',
  destroy: 'destroy',
  // 安装归 write 档审计（改动系统但非销毁）；弹卡要求与销毁一致
  install: 'write'
}

export function rememberKey(tool: string, target: string): string {
  return `${tool}::${target}`
}

/**
 * 数据外泄闸：本轮读过私密内容之后，任何会把数据发出去的动作都要先问一次。
 *
 * 为什么必须有这道闸：read 档是自动放行的，于是「读邮件」和「发请求」各自都合法，
 * 合起来却能拼成一条外泄链——网页正文里写一句指令，模型照做，把邮件原文塞进
 * web_fetch 的 URL，全程没有任何一次弹卡。
 *
 * 这道闸不做内容检查（那既查不准也拦不住混淆），只做一件事：
 * 在"有私密数据"和"要往外发"同时成立时，把决定权交回用户。
 */
export async function confirmDataEgress(
  hooks: GateHooks,
  request: { title: string; target: string; impact: string; paramsPreview: string }
): Promise<boolean> {
  const authRequest: AuthRequest = {
    id: `egress_${randomUUID().slice(0, 8)}`,
    tool: 'data_egress',
    effect: 'destroy',
    title: request.title,
    target: request.target,
    impact: request.impact,
    undoHint: '拒绝就什么都不会发出去',
    paramsPreview: request.paramsPreview.slice(0, 300),
    requestedAt: new Date().toISOString(),
    // 「始终允许」在这里没有意义：谁能保证以后每次要发的东西都该发
    allowAlways: false
  }
  const answer = normalizeAnswer(await hooks.requestAuth(authRequest))
  const allowed = answer === 'once' || answer === 'always'
  hooks.record({
    kind: 'refuse',
    title: allowed ? `放行数据外发：${request.title}` : `拦下数据外发：${request.title}`,
    sub: allowed
      ? `${request.target}（本轮读过私密内容，用户确认后发出）`
      : `${request.target}（本轮读过私密内容，用户${answer === 'expired' ? '超时未答复' : '拒绝'}）`,
    result: allowed ? 'ok' : 'rejected',
    reversible: false,
    effect: 'destroy',
    target: request.target,
    authz: answer === 'expired' ? 'expired' : allowed ? 'user_once' : 'denied'
  })
  return allowed
}

const KNOWN_EFFECTS = new Set(['read', 'ui', 'write', 'destroy', 'install'])

/**
 * 授权卡的答案只认这两个「通过」值，其余一律按拒绝处理。
 *
 * 类型在运行时不存在：渲染层可能传 undefined、以后可能加个 dismiss 按钮、
 * 或者 IPC 被别的调用方塞进任意字符串。这里要是写成「只拦 deny」，
 * 一个畸形参数就会变成「用户已授权执行」。
 */
function normalizeAnswer(raw: unknown): AuthAnswer {
  // expired 只由主进程超时产生，不在用户可点的答案里；其余畸形值一律 fail-closed
  return raw === 'once' || raw === 'always' || raw === 'expired' ? raw : 'deny'
}

function fallbackTarget(def: ToolDef, args: Record<string, any>): ToolTarget {
  const preview = JSON.stringify(args ?? {}).slice(0, 120)
  return {
    title: def.label,
    target: preview || def.label,
    impact: '未声明影响范围'
  }
}

function trim(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

export async function executeThroughGate(
  def: ToolDef,
  args: Record<string, any>,
  ctx: ToolContext,
  hooks: GateHooks
): Promise<ToolResult> {
  // 分档没声明、或声明了不认识的值 → 不做。宁可少做一次，也不猜它算不算危险
  if (!KNOWN_EFFECTS.has(def.effect)) {
    hooks.record({
      kind: 'refuse',
      title: `拒绝：${def.name} 没有声明合法的效果分档`,
      sub: `effect=${String(def.effect)}`,
      result: 'rejected',
      reversible: false
    })
    return { ok: false, blocked: true, summary: `没有执行：${def.name} 没有声明合法的效果分档` }
  }

  // 解析一次：卡片上写的目标 与 实际执行的动作，必须出自同一份结果（K7）
  let target: ToolTarget
  let execute: () => Promise<ToolResult>
  if (def.plan) {
    let planned: ToolPlan
    try {
      planned = await def.plan(args, ctx)
    } catch (err) {
      planned = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (!planned.ok) {
      // 解析不出唯一目标 → 不弹卡、不执行。让用户批准一个"还没确定的东西"没有意义
      hooks.record({
        kind: 'refuse',
        title: `没有执行：${def.label}`,
        sub: trim(planned.reason),
        result: 'rejected',
        reversible: false,
        effect: def.effect,
        target: trim(planned.reason)
      })
      return { ok: false, blocked: true, summary: `没有执行：${planned.reason}` }
    }
    target = planned.target
    execute = planned.execute
  } else {
    target = def.describeTarget?.(args) ?? fallbackTarget(def, args)
    execute = () => def.run(args, ctx)
  }

  const kind = def.auditKind ?? KIND_BY_EFFECT[def.effect] ?? 'read'

  const audit = (
    result: ToolResult,
    authz: AuthzDecision,
    resultKind: RecordEntry['result'],
    extra: Partial<RecordEntry> = {}
  ): void => {
    hooks.record({
      kind,
      title: target.title,
      sub: trim(result.summary),
      result: resultKind,
      reversible: Boolean(result.undo),
      effect: def.effect,
      target: target.target,
      undo: result.undo ?? target.undoHint,
      authz,
      snapshot: result.snapshotId,
      sourceUrl: result.sourceUrl,
      installedName: result.installedName,
      ...extra
    })
  }

  // ---- 读 / 界面：直接做 ----
  if (def.effect === 'read' || def.effect === 'ui') {
    const result = await execute()
    audit(result, 'auto', result.ok ? 'ok' : 'partial')
    return result
  }

  /**
   * 备份 → 执行。备份失败就当没发生过：write 和 destroy 共用这一段，
   * 否则「可还原」只是一句口号。
   */
  const backupThenRun = async (authz: AuthzDecision): Promise<ToolResult> => {
    let backupUndo: string | undefined
    if (def.backup) {
      const backup = await def.backup(args, ctx)
      if (!backup.ok) {
        const blocked: ToolResult = {
          ok: false,
          blocked: true,
          summary: `备份失败，为了不留下改坏的东西，这次没有执行：${backup.detail ?? '原因未知'}`
        }
        audit(blocked, authz, 'rejected', { before: backup.detail })
        return blocked
      }
      backupUndo = backup.undo
    }
    const result = await execute()
    audit(
      { ...result, undo: result.undo ?? backupUndo },
      authz,
      result.ok ? 'ok' : 'partial'
    )
    return result
  }

  // ---- 写：先备份，备份不成就不写 ----
  if (def.effect === 'write') {
    return backupThenRun('auto')
  }

  // ---- 销毁 / 安装：必须过卡（改动机器且不可静默）----
  const key = rememberKey(def.name, target.target)
  let answer: AuthAnswer
  let authz: AuthzDecision

  // 「始终允许」只对明确允许记忆的工具生效：销毁类即使被写进记忆也必须每次弹卡
  if (def.allowAlways === true && hooks.isRemembered(key)) {
    answer = 'always'
    authz = 'user_always'
  } else {
    const request: AuthRequest = {
      id: `auth_${randomUUID().slice(0, 8)}`,
      tool: def.name,
      effect: def.effect,
      title: target.title,
      target: target.target,
      impact: target.impact,
      undoHint: target.undoHint,
      reinstallHint: target.reinstallHint,
      paramsPreview: JSON.stringify(args ?? {}).slice(0, 300),
      requestedAt: new Date().toISOString(),
      allowAlways: def.allowAlways === true
    }
    answer = normalizeAnswer(await hooks.requestAuth(request))
    if (answer === 'deny') {
      authz = 'denied'
    } else if (answer === 'expired') {
      // 60 秒没响应：等同拒绝，但审计里单独标出来，和用户主动拒绝区分
      authz = 'expired'
    } else if (answer === 'always' && def.allowAlways === true) {
      hooks.remember(key, request)
      authz = 'user_always'
    } else {
      authz = 'user_once'
    }
  }

  if (answer === 'deny' || answer === 'expired') {
    const blocked: ToolResult = {
      ok: false,
      blocked: true,
      // 这句话模型和用户都会看到：既要提醒模型别改口，也不能读起来像内部指令
      summary:
        answer === 'expired'
          ? '授权卡超过 60 秒没有响应，已按拒绝处理，什么都没有改动。要继续的话再发起一次，并提醒用户及时点卡。'
          : '用户拒绝了这次操作，什么都没有改动；如实说明是用户取消的，不要说成「没有权限」。'
    }
    audit(blocked, authz, 'rejected')
    return blocked
  }

  if (hooks.dryRun) {
    const dry: ToolResult = {
      ok: true,
      summary: `演练模式：已通过授权（${authz}），但没有真正执行`
    }
    audit(dry, authz, 'ok')
    return dry
  }

  return backupThenRun(authz)
}
