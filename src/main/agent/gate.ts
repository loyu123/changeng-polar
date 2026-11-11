import { randomUUID } from 'node:crypto'
import type {
  AuthAnswer,
  AuthRequest,
  AuthzDecision,
  FactCheck,
  RecordEntry,
  RecordKind,
  ToolChoiceRequest
} from '../../shared/types'
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
  /**
   * 名称有歧义时请用户在候选里挑一个；返回 null = 用户取消或超时。
   *
   * 不提供这个钩子的环境（评测、离线验收）会退回旧行为：当作解析失败拒绝。
   * 这样 eval 的判据不用跟着改，也不会因为"没人能点"而卡住。
   */
  requestChoice?: (choice: ToolChoiceRequest) => Promise<string | null>
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

/** 会改动机器的那三档：只有它们才有"事后核对"这回事 */
const MUTATING_EFFECTS: ReadonlySet<string> = new Set(['write', 'destroy', 'install'])

/**
 * 写操作之后重新查一遍事实。
 *
 * 存在的理由：在此之前，"装好了/删干净了/传上去了"全靠模型自己读工具返回的那句话，
 * 于是它照着念就成了"事实"。而失败恰恰是沉默的——winget 说成功、
 * 注册表里却没有；回收站那次调用返回了、文件还在原处。
 *
 * 三条规则：
 * 1. 只在动作本身成功时核对（失败时没有可核对的东西）
 * 2. 工具自己在执行过程中已经查过的（`result.verify`）优先，不重复查一遍
 * 3. 没法当场核对的（比如卸载要等用户点完卸载窗口）必须说成 unavailable，
 *    不许当成"通过"——"查不到"和"查了没问题"是两件事，混淆它们就是这套机制的意义所在
 *
 * 核对本身抛异常也不放行：降级成 unavailable 并带上原始错误，宁可显得没查成，
 * 也不能因为核对炸了就把这一步当成没问题。
 */
async function factCheck(
  def: ToolDef,
  args: Record<string, any>,
  ctx: ToolContext,
  result: ToolResult
): Promise<FactCheck | null> {
  if (!MUTATING_EFFECTS.has(def.effect) || !result.ok) return null
  if (result.verify) return result.verify
  if (!def.verify) {
    return { state: 'unavailable', fact: `「${def.label}」没有实现事后核对，这次只能按工具自己的回执转述` }
  }
  try {
    return await def.verify(args, ctx, result)
  } catch (err) {
    return {
      state: 'unavailable',
      fact: `核对没能跑完：${err instanceof Error ? err.message : String(err)}`
    }
  }
}

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

/** plan 抛异常一律当作解析失败，不让它冒到闸门外面 */
async function safePlan(def: ToolDef, args: Record<string, any>, ctx: ToolContext): Promise<ToolPlan> {
  if (!def.plan) return { ok: false, reason: `${def.name} 没有声明解析方式` }
  try {
    return await def.plan(args, ctx)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
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
    let planned = await safePlan(def, args, ctx)
    /**
     * 语义有歧义：先把选择权交给用户，再拿他选的那个值**重新解析一次**。
     *
     * order 很重要：不是"用户选完就直接装"，而是"用户选完 → 重新 plan → 再走授权卡"。
     * 用户批准的仍然是那张写着「安装：哔哩哔哩 / Bilibili.Bilibili 1.20.0」的卡，
     * 安装的代价（会弹安装器、要他自己点完）那一段他也照样看得到——选候选不等于同意安装。
     */
    if (!planned.ok && planned.choice && hooks.requestChoice) {
      const choice = planned.choice
      const picked = await hooks.requestChoice({
        id: `choice_${randomUUID().slice(0, 8)}`,
        tool: def.name,
        title: choice.title,
        hint: choice.hint,
        options: choice.options,
        requestedAt: new Date().toISOString()
      })
      if (!picked) {
        hooks.record({
          kind: 'refuse',
          title: `没有执行：${def.label}`,
          sub: '用户取消了候选选择，什么都没有改动',
          result: 'rejected',
          reversible: false,
          effect: def.effect,
          target: trim(choice.title)
        })
        return { ok: false, blocked: true, summary: '用户取消了候选选择，什么都没有改动；如实说明是用户取消的，不要猜他要装哪个。' }
      }
      const nextArgs = { ...args, [choice.pickInto]: picked }
      planned = await safePlan(def, nextArgs, ctx)
      /**
       * 选完之后必须还能解析出目标，而且解析出的目标里得带用户选的那个值。
       * 拿不出目标就是工具实现错了（或仓库刚好变了），这时拒绝比执行安全——
       * 否则就成了「用户选的是 A、实际装的是 B」，正是 K7 要堵的那条缝。
       *
       * 措辞不替工具猜原因：这里既可能是"还是不确定选哪个"，也可能是工具
       * 明确拒绝（比如选完才发现那个软件已经装着了）。一律写成"仍解析不出
       * 唯一目标"会把后者说成我们没搞清，而真话就在 reason 里。
       */
      if (!planned.ok) {
        hooks.record({
          kind: 'refuse',
          title: `没有执行：${def.label}`,
          sub: `选了 ${picked} 之后没有继续：${trim(planned.reason)}`,
          result: 'rejected',
          reversible: false,
          effect: def.effect,
          target: trim(picked)
        })
        return { ok: false, blocked: true, summary: `选了 ${picked} 之后没有继续：${planned.reason}` }
      }
      if (!planned.target.target.includes(picked)) {
        hooks.record({
          kind: 'refuse',
          title: `没有执行：${def.label}`,
          sub: `解析结果与你的选择不一致（选的是 ${picked}，解析成 ${trim(planned.target.target)}）`,
          result: 'rejected',
          reversible: false,
          effect: def.effect,
          target: trim(picked)
        })
        return {
          ok: false,
          blocked: true,
          summary: `解析结果和你选的 ${picked} 对不上，为免装错东西，这次没有继续。`
        }
      }
      hooks.record({
        kind: 'ui',
        title: `选择：${choice.title}`,
        sub: `${picked}（你从 ${choice.options.length} 个候选里选的，选定后还会再确认一次）`,
        result: 'ok',
        reversible: false,
        target: trim(picked)
      })
      args = nextArgs
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
      // 工具名单独记：title 是给人看的文案，渲染层拿它做判断迟早对不上
      tool: def.name,
      target: target.target,
      undo: result.undo ?? target.undoHint,
      authz,
      snapshot: result.snapshotId,
      sourceUrl: result.sourceUrl,
      installedName: result.installedName,
      verified: result.verify?.state,
      verifyFact: result.verify?.fact,
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
    // 核对一次：拿到的事实跟着结果一起回给模型和记录页，不让它自己圆
    const verify = await factCheck(def, args, ctx, result)
    const checked = verify ? { ...result, verify } : result
    audit({ ...checked, undo: result.undo ?? backupUndo }, authz, result.ok ? 'ok' : 'partial')
    return checked
  }

  // ---- 写：先备份，备份不成就不写 ----
  // 唯一例外是 requiresConfirmation 的工具（委派给外部智能体）：它必须过卡，
  // 不能因为"effect 是 write"就自动放行。放过这一条等于没人同意过就把活派出去了。
  if (def.effect === 'write' && def.requiresConfirmation !== true) {
    return backupThenRun('auto')
  }

  // ---- 销毁 / 安装：必须过卡（改动机器且不可静默）----
  // 用 def.effect 构造卡，所以 write 档的强制卡会如实显示成"写入"档，
  // 不会伪装成删除或安装。
  const key = rememberKey(def.name, target.target)
  let answer: AuthAnswer
  let authz: AuthzDecision

  // 「始终允许」只对明确允许记忆的工具生效：销毁类即使被写进记忆也必须每次弹卡。
  // requiresConfirmation 的工具同样永不允许"始终允许"。
  const memorizable = def.allowAlways === true && def.requiresConfirmation !== true
  if (memorizable && hooks.isRemembered(key)) {
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
      allowAlways: memorizable
    }
    answer = normalizeAnswer(await hooks.requestAuth(request))
    if (answer === 'deny') {
      authz = 'denied'
    } else if (answer === 'expired') {
      // 60 秒没响应：等同拒绝，但审计里单独标出来，和用户主动拒绝区分
      authz = 'expired'
    } else if (answer === 'always' && memorizable) {
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
