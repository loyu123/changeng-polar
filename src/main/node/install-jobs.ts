import { randomUUID } from 'node:crypto'
import type { InstallJobView } from '../../shared/types'

/**
 * 正在后台跑的安装。
 *
 * 为什么需要这个：安装器一开就是好几分钟（`install.ts` 给的上限是 30 分钟），
 * 而这几分钟里 `chat:send` 一直不返回——用户发不出下一条消息，界面上只有一条
 * 静止的"正在安装软件（需授权）…"。装个软件不该占住整轮对话。
 *
 * 所以安装从"一轮对话里的一步"变成"一个任务"：工具拉起来就返回，
 * 干完再由任务自己收尾（核对、写审计、通知）。这里只管三件事：
 * 记着有哪些在跑、让界面能列出/取消、状态变了广播出去。
 *
 * **这里不管权限**。授权卡仍然在安装开始之前由闸门弹、由用户点——
 * 后台化的只是"装完之后的事"，不是"要不要装"。
 */

export interface InstallJobSpec {
  name: string
  pkgId: string
  version: string
}

/** 交给发起方的那一份句柄：一个能被打断的信号，一个结束时必须调用的收尾 */
export interface InstallJobHandle {
  id: string
  signal: AbortSignal
  /** 结束（成功 / 失败 / 取消都要调，否则这条任务会永远显示"正在安装"） */
  finish: (status: InstallJobView['status'], detail: string) => void
}

interface Job {
  view: InstallJobView
  controller: AbortController
}

/**
 * 任务清单。
 *
 * 不用全局单例：主进程里只有一份，但测试要能各自造一份，
 * 否则一条测试跑完留下的任务会污染下一条。
 */
export class InstallJobs {
  private jobs = new Map<string, Job>()

  /** 状态变了（开始 / 结束 / 被取消）就通知一声，主进程据此广播到渲染层 */
  onChange?: (jobs: InstallJobView[]) => void

  /** 跑完通知一句：装好了还是没装上，用户得知道，而且他可能不在看窗口 */
  onFinish?: (view: InstallJobView) => void

  list(): InstallJobView[] {
    // 正在跑的排前面：用户点开是为了看"还在装什么"，已经结束的往后放
    return [...this.jobs.values()]
      .map((j) => j.view)
      .sort((a, b) => {
        const running = Number(b.status === 'running') - Number(a.status === 'running')
        return running !== 0 ? running : b.startedAt.localeCompare(a.startedAt)
      })
      .map((view) => ({ ...view }))
  }

  /** 还占着安装器的有几个（用来判断"能不能退出应用"这类话） */
  runningCount(): number {
    let n = 0
    for (const job of this.jobs.values()) if (job.view.status === 'running') n++
    return n
  }

  start(spec: InstallJobSpec): InstallJobHandle {
    const id = `install_${randomUUID().slice(0, 8)}`
    const controller = new AbortController()
    const view: InstallJobView = {
      id,
      name: spec.name,
      pkgId: spec.pkgId,
      version: spec.version,
      startedAt: new Date().toISOString(),
      status: 'running'
    }
    this.jobs.set(id, { view, controller })
    this.emit()

    return {
      id,
      signal: controller.signal,
      finish: (status, detail) => this.settle(id, status, detail)
    }
  }

  /**
   * 取消一个还在跑的安装。
   *
   * 返回 false = 这个 id 不在跑（已经结束或从来不存在），界面据此说"它已经装完了"，
   * 而不是让用户以为点了没反应。
   *
   * 取消做的只有一件事：**不再等它**。状态仍然是 running，直到 `finish` 说出
   * 安装器到底干了什么——因为"我按了不等了"和"机器上到底装没装"是两个事实，
   * 而这里必须以后者为准。抢在这时候把状态写成「已取消」，万一安装器其实装好了，
   * 用户和台账就都会以为什么都没发生。
   *
   * 只能打断我们拉起来的那个 winget。**厂商安装器是它的子进程，杀不掉**——
   * 所以界面上的措辞是"不再等它"，不是"中止安装"。
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.view.status !== 'running') return false
    job.controller.abort()
    return true
  }

  /** 清掉已经结束的那些（用户点了"知道了"，或者重启后不再需要看旧任务） */
  clearFinished(): void {
    for (const [id, job] of this.jobs) if (job.view.status !== 'running') this.jobs.delete(id)
    this.emit()
  }

  private settle(id: string, status: InstallJobView['status'], detail: string): void {
    const job = this.jobs.get(id)
    // 已经结束过就不再改：取消之后安装器又正常退出，不能把"已取消"翻成"装好了"
    if (!job || job.view.status !== 'running') return
    job.view = { ...job.view, status, detail, finishedAt: new Date().toISOString() }
    this.emit()
    this.onFinish?.({ ...job.view })
  }

  private emit(): void {
    this.onChange?.(this.list())
  }
}
