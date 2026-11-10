/**
 * 项目编排的数据形状（P1）。
 *
 * 为什么要有这一层：长庚本来是**会话式**的——一次对话、一个结论。
 * 派发任务给外部工作体要求它是**项目式**的：状态跨天存在、进程死了能续、
 * 页面关掉再打开还在。中间缺的就是这份结构。
 *
 * 三条硬约束（改之前先看）：
 * 1. 智能体之间互相看不见，唯一的通信总线是长庚本身（物理事实，不是设计选择）。
 *    所以任务之间只能用 `dependsOn` 表达先后，不存在"两个工作体互相商量"。
 * 2. 每个任务必须带**可执行的**验收，不接受"报告写得好"这种口径。
 * 3. 任务各自落在 `tasks/<id>/` 隔离目录里，合并是长庚的事，工作体不许越界。
 */

/** 一个任务的状态。unknown 是「进程没了、结果未知」，既不能算成功也不能算失败 */
export type OrchestrationTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'unknown'

/**
 * 确定性验收的一条。全部满足才算任务完成。
 *
 * 只用文件系统能查的东西，不调模型——判断性验收（"这份报告答到题了吗"）
 * 只用来排序哪个版本更好，不用来判定通过与否，理由是它本身会偏。
 */
export type AcceptanceCheck =
  | { kind: 'file-exists'; path: string; note?: string }
  | { kind: 'min-bytes'; path: string; bytes: number; note?: string }
  | { kind: 'contains'; path: string; text: string; note?: string }
  | { kind: 'not-contains'; path: string; text: string; note?: string }

/**
 * 派发给哪个工作体。
 *
 * 留空表示"用配置里的默认后端"，不在代码里写死任何模型名或后端名。
 * 任务可以单独指定 backend：这样同一个项目里可以按活的性质分配——
 * 比如整理资料的给 codebuddy，跑代码的给 pi。
 */
export interface WorkerSpec {
  /** 这一件给哪家做。留空 = 用配置的默认后端 */
  backend?: 'pi' | 'codex' | 'codebuddy' | 'claude'
  provider?: string
  model?: string
  /**
   * 允许工作体干哪几类事，用**长庚的能力词**：read / write / edit / bash。
   * 不是各家自己的工具名（claude 的 Read、pi 的 read）——那一层映射在 capabilities.ts，
   * 因为同一个任务换后端时不该跟着改。
   */
  tools?: string[]
}

export interface OrchestrationTask {
  id: string
  title: string
  /** 交给工作体的提示词。长庚负责把上游产出拼进来，工作体自己不跨任务取件 */
  prompt: string
  /** 依赖的任务 id：全部 done 之后这个任务才可派发 */
  dependsOn: string[]
  status: OrchestrationTaskStatus
  acceptance: AcceptanceCheck[]
  worker?: WorkerSpec
  /** 相对项目根的工作目录，缺省 `tasks/<id>` */
  workDir?: string
  attempts: number
  startedAt?: string
  endedAt?: string
  lastRunId?: string
  failureReason?: string
  /** 工作体的原文回答（成功时落盘，汇报与下游提示词都用它） */
  outputFile?: string
}

export interface OrchestrationProject {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  status: 'planning' | 'running' | 'done' | 'failed'
  /** 项目根目录（绝对路径）。所有相对路径都以它为基准 */
  rootDir: string
  tasks: OrchestrationTask[]
}

/** 一次派发的落盘记录（runs.jsonl 的一行）。汇报与"谁在什么时候跑了什么"都读它 */
export interface WorkerRunRecord {
  runId: string
  projectId: string
  taskId: string
  startedAt: string
  endedAt: string
  ok: boolean
  exitCode: number | null
  /** 从事件流里数出来的，不是工作体自报 */
  toolCalls: { name: string; args?: unknown; ok?: boolean; durationMs?: number }[]
  /** 工作体回答的字符数。全文落 tasks/<id>/output.txt，不塞进 jsonl */
  outputChars: number
  /** 模型报告的 token 用量（有就记，没有留空，不编） */
  usage?: Record<string, unknown>
  failureReason?: string
}
