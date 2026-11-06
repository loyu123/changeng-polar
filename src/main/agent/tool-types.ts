import type {
  AuthzDecision,
  ButlerConfig,
  Evidence,
  RecordEntry,
  RecordKind,
  ToolEffect
} from '../../shared/types'

export interface ToolContext {
  config: ButlerConfig
  signal?: AbortSignal
  /** 记录入口（现在由闸门统一写审计，工具一般不再自己写） */
  record: (entry: Omit<RecordEntry, 'id' | 'ts'>) => RecordEntry
}

export interface ToolResult {
  ok: boolean
  summary: string
  data?: unknown
  evidence?: Evidence[]
  /** 被授权闸门拦下（不是执行失败） */
  blocked?: boolean
  /** 怎么撤回（回收站 / 备份路径 / 无） */
  undo?: string
  /** 卸载前抓的状态快照 id（卸载类工具写入，审计记录与对比卡片据此回查） */
  snapshotId?: string
  /** 安装来源的真实下载地址（安装类工具写入，审计台账据此可查"从哪装的"） */
  sourceUrl?: string
}

/** 授权卡上的文案：给人看，模型看不懂也没关系 */
export interface ToolTarget {
  title: string
  target: string
  impact: string
  undoHint?: string
  reinstallHint?: string
}

/**
 * 预解析结果：卡片上写的目标，与真正要执行的动作，出自同一次解析。
 *
 * 这是补 K7 的那一半：如果卡片用 describeTarget(args)、执行用 run(args) 各自算一遍，
 * 两次解析之间任何一点差异（简化展示名、回退默认值、注册表刚好变了）
 * 都会变成「用户批准的是 A，实际动的是 B」。
 */
export type ToolPlan =
  | { ok: true; target: ToolTarget; execute: () => Promise<ToolResult> }
  | { ok: false; reason: string }

export interface ToolDef {
  name: string
  /** 人类可读名称，用于状态栏与记录页 */
  label: string
  description: string
  effect: ToolEffect
  /** 审计归类：默认按 effect 映射，联网类工具显式标 web */
  auditKind?: RecordKind
  /** 是否允许"始终允许"（删除/卸载类固定 false） */
  allowAlways?: boolean
  parameters: Record<string, unknown>
  /** 自报"这次要动什么"，缺省时闸门用 label 兜底（只用于展示，不做解析） */
  describeTarget?: (args: Record<string, any>) => ToolTarget
  /**
   * 需要「先解析、再展示、再执行」的工具用这个：解析只做一次，
   * 卡片展示的 target 和最终 execute 用的是同一份结果（见 ToolPlan 注释）。
   * 解析失败就返回 { ok: false }，闸门不会弹卡，也不会执行。
   */
  plan?: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolPlan>
  /** write 档专用：执行前备份，返回撤销句柄 */
  backup?: (args: Record<string, any>, ctx: ToolContext) => Promise<{ ok: boolean; undo?: string; detail?: string }>
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>
}

export interface GateDecisionLog {
  authz: AuthzDecision
  decision: 'allow' | 'deny'
}
