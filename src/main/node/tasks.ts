import type { TaskDef, TaskSchedule } from '../../shared/types'

/**
 * 定时任务调度器：主进程里的单线程循环。
 *
 * 边界（改之前先看这几条）：
 * - 到点把 prompt 作为用户消息跑一轮对话；无人在场，需要授权的操作会被当场拒绝并留痕
 * - 只用 setTimeout 单链调度，同一时刻最多一个任务在跑，绝不堆积
 * - 应用关了任务就不跑。所以主进程默认「关窗收进托盘」（见 tray.ts），
 *   让用户关掉窗口时任务不至于一起停；真退出仍然会停，这一点不假装能后台级运行
 */

/** 计算某任务下一次该跑的时间（ms 时间戳） */
function nextRunAt(schedule: TaskSchedule, lastRun?: string): number {
  const now = Date.now()
  const last = lastRun ? Date.parse(lastRun) : NaN
  if (schedule.kind === 'interval') {
    const step = Math.max(1, Math.min(schedule.minutes, 60 * 24)) * 60_000
    if (Number.isFinite(last) && now - last < step) return last + step
    return now
  }
  // daily HH:mm：下一个出现的时间点；今天这次还没跑过就补跑
  const [h, m] = schedule.time.split(':').map((x) => Number.parseInt(x, 10))
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return now // 非法时间：立即跑一次让结果暴露问题，而不是静默不跑
  }
  const at = new Date()
  at.setHours(h, m, 0, 0)
  const todayAt = at.getTime()
  const tomorrowAt = todayAt + 24 * 60 * 60_000
  if (Number.isFinite(last) && last >= todayAt) return tomorrowAt // 今天已经跑过
  if (todayAt <= now) return todayAt // 今天这次错过了，补跑
  return todayAt
}

export interface TaskRunnerOptions {
  getTasks: () => Promise<TaskDef[]>
  /**
   * 按 id 只改一条任务。
   * 之前这里是「读全表 → 改 → 写回」，后台任务回写 lastRun 的同时用户在界面上
   * 保存，两边各读到一份旧表，后写的会把先写的整条覆盖。改走 Store 的串行队列。
   */
  updateTask: (id: string, patch: Partial<TaskDef>) => Promise<TaskDef | null>
  /** 跑一轮任务：由 index.ts 注入（复用对话执行链路），返回结果摘要 */
  execute: (task: TaskDef) => Promise<string>
  /** 任务跑完/失败后通知渲染层刷新 */
  onTaskUpdated: (task: TaskDef) => void
  /**
   * 一轮跑完的回调（成败都调）。
   * 与 onTaskUpdated 分开：那个只负责让界面刷新，这个给「用户不在看窗口」时的系统通知用。
   */
  onFinish?: (task: TaskDef, summary: string, ok: boolean) => void
}

export class TaskRunner {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly opts: TaskRunnerOptions) {}

  start(): void {
    if (this.timer) clearTimeout(this.timer)
    void this.scheduleNext()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** 重新排程（任务增删改后调用） */
  reschedule(): void {
    this.start()
  }

  private async scheduleNext(): Promise<void> {
    try {
      const tasks = (await this.opts.getTasks()).filter((t) => t.enabled && t.prompt.trim())
      if (tasks.length === 0) return
      let nearest: TaskDef | null = null
      let nearestAt = Number.POSITIVE_INFINITY
      for (const task of tasks) {
        const at = nextRunAt(task.schedule, task.lastRun)
        if (at < nearestAt) {
          nearestAt = at
          nearest = task
        }
      }
      if (!nearest) return
      const delay = Math.min(Math.max(nearestAt - Date.now(), 1_000), 24 * 60 * 60_000)
      const t = nearest
      this.timer = setTimeout(() => {
        void this.fire(t)
      }, delay)
      this.timer.unref?.()
    } catch {
      /* 排程失败静默：任务更新时会重新 start */
    }
  }

  private async fire(task: TaskDef): Promise<void> {
    if (this.running) {
      // 上一轮还没完：延后 30 秒再试，不堆积并发
      this.timer = setTimeout(() => {
        void this.fire(task)
      }, 30_000)
      this.timer.unref?.()
      return
    }
    this.running = true
    try {
      const summary = await this.opts.execute(task)
      await this.mark(task, summary)
      this.opts.onFinish?.(task, summary, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.mark(task, `失败：${message.slice(0, 140)}`)
      this.opts.onFinish?.(task, message, false)
    } finally {
      this.running = false
      void this.scheduleNext()
    }
  }

  private async mark(task: TaskDef, result: string): Promise<void> {
    try {
      const updated = await this.opts.updateTask(task.id, {
        lastRun: new Date().toISOString(),
        lastResult: result.slice(0, 160)
      })
      if (updated) this.opts.onTaskUpdated(updated)
    } catch {
      /* 标记失败不影响下一轮 */
    }
  }
}
