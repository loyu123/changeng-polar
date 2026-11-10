import type { OrchestrationProject, OrchestrationTask } from './types'

/**
 * 计划校验与调度顺序。纯函数，不碰文件系统——这样这部分能单测，也不受进程状态影响。
 *
 * 为什么校验要这么严：昨天定的口径是「能并行的并行、有依赖的排队、产出落隔离目录、
 * 验收后合并」。这几件事全依赖 `dependsOn` 是真的有向无环图。图错了，并行就会
 * 拿上游还没产出的文件去跑下游，最后交上来一份"结构完整但内容空泛"的报告——
 * 这种报告最危险，因为看起来像成品。
 */

export interface PlanError {
  taskId?: string
  message: string
}

export interface PlanValidation {
  ok: boolean
  errors: PlanError[]
}

/** 校验一份任务列表能否安全派发 */
export function validatePlan(tasks: OrchestrationTask[]): PlanValidation {
  const errors: PlanError[] = []
  if (tasks.length === 0) {
    errors.push({ message: '计划是空的：至少要有一个任务' })
    return { ok: false, errors }
  }

  const byId = new Map<string, OrchestrationTask>()
  for (const t of tasks) {
    if (!t.id.trim()) errors.push({ message: '任务缺少 id' })
    if (byId.has(t.id)) errors.push({ taskId: t.id, message: `任务 id 重复：${t.id}` })
    byId.set(t.id, t)
    if (!t.title.trim()) errors.push({ taskId: t.id, message: `${t.id} 没有标题` })
    if (!t.prompt.trim()) errors.push({ taskId: t.id, message: `${t.id} 没有提示词，派出去也只能空转` })
    // 验收是硬门：任务没有可执行的验收，等于交上来什么算什么都由它自己说
    if (t.acceptance.length === 0) {
      errors.push({ taskId: t.id, message: `${t.id} 没有验收项：判断"做完了"不能靠自述` })
    }
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) errors.push({ taskId: t.id, message: `${t.id} 依赖了自己` })
      else if (!byId.has(dep)) errors.push({ taskId: t.id, message: `${t.id} 依赖了不存在的任务 ${dep}` })
    }
  }

  const cycle = findCycle(tasks)
  if (cycle) {
    errors.push({ message: `依赖成环：${cycle.join(' → ')}。有环就永远没有可派发的任务` })
  }

  return { ok: errors.length === 0, errors }
}

/** 找一条环（找到了就返回经过的 id），没有环返回 null */
export function findCycle(tasks: OrchestrationTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 0 | 1 | 2>() // 0 未访问 1 在栈上 2 已出栈
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const s = state.get(id) ?? 0
    if (s === 2) return null
    if (s === 1) {
      const at = stack.indexOf(id)
      return [...stack.slice(at), id]
    }
    state.set(id, 1)
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }

  for (const t of tasks) {
    const found = visit(t.id)
    if (found) return found
  }
  return null
}

/**
 * 按依赖分层：第 0 层是没有依赖的，第 N 层要等第 N-1 层全完。
 * P2 的并行就是"同层同时起进程"；P1 只做层内串行。
 */
export function topoLayers(tasks: OrchestrationTask[]): string[][] {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn.filter((d) => tasks.some((x) => x.id === d)))]))
  const layers: string[][] = []
  const placed = new Set<string>()

  while (placed.size < remaining.size) {
    const layer: string[] = []
    for (const [id, deps] of remaining) {
      if (placed.has(id)) continue
      if ([...deps].every((d) => placed.has(d))) layer.push(id)
    }
    // 剩下的一起有环（validatePlan 会先报）。这里不死循环，直接兜底收尾
    if (layer.length === 0) {
      layers.push([...remaining.keys()].filter((id) => !placed.has(id)))
      break
    }
    layer.sort() // 顺序稳定，评测和汇报才对得上
    for (const id of layer) placed.add(id)
    layers.push(layer)
  }
  return layers
}

/**
 * 现在能派发的任务：pending 且依赖全部 done。
 *
 * 依赖里有 failed / blocked / unknown 的，永远进不来——上游没产出就等于没原料，
 * 硬跑只会产出看起来完整的空壳。
 */
export function readyTasks(project: OrchestrationProject): OrchestrationTask[] {
  const status = new Map(project.tasks.map((t) => [t.id, t.status]))
  return project.tasks.filter(
    (t) => t.status === 'pending' && t.dependsOn.every((d) => status.get(d) === 'done')
  )
}

/** 被上游卡住的任务：状态仍是 pending，但依赖里有非 done 的 */
export function blockedTasks(project: OrchestrationProject): OrchestrationTask[] {
  const status = new Map(project.tasks.map((t) => [t.id, t.status]))
  return project.tasks.filter(
    (t) => t.status === 'pending' && t.dependsOn.some((d) => status.get(d) !== 'done')
  )
}

export interface ProjectProgress {
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

export function projectProgress(project: OrchestrationProject): ProjectProgress {
  const counts = { done: 0, failed: 0, running: 0, pending: 0, blocked: 0, unknown: 0 }
  const blockedIds = new Set(blockedTasks(project).map((t) => t.id))
  for (const t of project.tasks) {
    if (t.status === 'pending' && blockedIds.has(t.id)) counts.blocked += 1
    else counts[t.status] += 1
  }
  return {
    total: project.tasks.length,
    ...counts,
    ratio: project.tasks.length === 0 ? 0 : counts.done / project.tasks.length
  }
}

/**
 * 派发前的预览：给候选卡算「值不值得并行」。
 *
 * 为什么要算而不是直接问用户"要不要并行"：并行只在**同一层里有多个任务**时才有意义。
 * 串成一条链的计划（A→B→C）无论开多少路都只能一个一个跑，这时把并行选项摆上去
 * 是骗人的——用户点了也不会快。
 */
export interface DispatchPreview {
  total: number
  /** 每层有几个任务，按依赖顺序 */
  layerWidths: number[]
  /** 最宽那一层有几个（这是并行的上限） */
  maxWidth: number
  /** 真的存在同层多任务（否则并行没有意义） */
  parallelizable: boolean
}

export function previewDispatch(tasks: OrchestrationTask[]): DispatchPreview {
  const layers = topoLayers(tasks)
  const layerWidths = layers.map((l) => l.length)
  const maxWidth = layerWidths.length > 0 ? Math.max(...layerWidths) : 0
  return {
    total: tasks.length,
    layerWidths,
    maxWidth,
    parallelizable: maxWidth >= 2 && tasks.length >= 2
  }
}
