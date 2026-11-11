/**
 * 编排页看到的项目形状（主进程算好，渲染层只画）。
 *
 * 放在 shared 而不是 orchestrator/view.ts：preload 要给渲染层声明这些类型，
 * 而 preload 引用主进程模块会把 `node:fs` 那一串拽进类型图里。纯类型放这里，
 * 两边都只依赖 shared，跟 `shared/desktop.ts` 同一个道理。
 */

export interface OrchestrationTaskView {
  id: string
  title: string
  status: string
  dependsOn: string[]
  attempts: number
  failureReason?: string
  startedAt?: string
  endedAt?: string
  /** 验收项的原始描述，展开时显示 */
  acceptance: string[]
  /** 产出文件（绝对路径），只列真实存在的 */
  artifacts: string[]
}

export interface OrchestrationProgressView {
  total: number
  done: number
  failed: number
  running: number
  pending: number
  blocked: number
  unknown: number
  /** 0~1，按已完成任务数算。有 failed/unknown 时不冒充 100% */
  ratio: number
}

export interface OrchestrationProjectView {
  /** 项目目录的绝对路径：界面上用它当唯一标识（跨根也不会撞） */
  projectDir: string
  id: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
  rootDir: string
  progress: OrchestrationProgressView
  tasks: OrchestrationTaskView[]
  /** 最近一次派发时间（runs.jsonl 最后一条） */
  lastRunAt?: string
  /** 派发次数 */
  runCount: number
  /** 这个项目是在哪个根里找到的（界面用来标"它从哪来"） */
  scanRoot: string
}

/** 编排页一次能拿到的东西：项目、允许扫描的根、应用自己的根 */
export interface OrchestrationListView {
  projects: OrchestrationProjectView[]
  roots: string[]
  appRoot: string
}
