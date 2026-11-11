import { useEffect, useState } from 'react'
import type { InstallJobView } from '../../../shared/types'

/**
 * 正在后台装的软件。
 *
 * 为什么要单独一条横条，而不是留在对话里：安装器一开就是好几分钟，装配好的
 * 行为是这一轮对话早早结束、用户可以接着问别的事。那些"正在安装…"的对话
 * 气泡已经不在了（新消息会把它们挤上去），所以"还在装什么"必须有个常驻的地方。
 *
 * 抽成组件是因为主窗口和悬浮面板两处都要它——安装是在主进程跑的，
 * 两个窗口看的是同一份任务清单，画法不一致就成"同一个装在两个地方说得不一样"。
 *
 * 只有真在跑（或刚跑完还没被点掉）的时候才出现，平常不占位置。
 *
 * `compact` 给悬浮面板用：那里只有 380px 宽，话说短一点、提示折行。
 */
export function InstallStrip({ compact = false }: { compact?: boolean }): React.ReactNode {
  const [jobs, setJobs] = useState<InstallJobView[]>([])

  useEffect(() => {
    let alive = true
    void window.butler.install.list().then((list) => {
      if (alive) setJobs(list)
    })
    // 装完的通知来的时候，那一轮对话早就结束了（chat.onEvent 的监听器已经摘了），
    // 所以这条订阅必须挂在组件上常驻，而不是跟在某次发送里
    const off = window.butler.install.onChanged((list) => setJobs(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (jobs.length === 0) return null
  const running = jobs.filter((j) => j.status === 'running')

  const noteOf = (job: InstallJobView): string => {
    if (job.status === 'running') return compact ? '正在装（窗口里点完就行）' : '正在装（安装器窗口里由你点完，装完告诉你）'
    if (job.status === 'ok') return job.detail ?? '装好了'
    // 取消不是失败：用户自己按的，就别写成"没装成"
    if (job.status === 'cancelled') return compact ? '没再等它' : '已经取消了，没再等它'
    return job.detail ?? '没装成'
  }

  return (
    <div className={`install-strip${compact ? ' compact' : ''}`}>
      {jobs.map((job) => (
        <div className="install-row" key={job.id}>
          <span className={`install-dot ${job.status}`} />
          <span className="install-name">{job.name}</span>
          <span className="install-note">{noteOf(job)}</span>
          {job.status === 'running' ? (
            <button
              className="install-act"
              title="不再等它（只能停止长庚这边的等待，安装器自己的窗口得你手动关）"
              onClick={() => {
                void window.butler.install.cancel(job.id).then((ok) => {
                  // 返回 false = 它已经不在跑了：如实说"已经结束了"，别让用户以为点了没反应
                  if (!ok) void window.butler.install.list().then(setJobs)
                })
              }}
            >
              不等了
            </button>
          ) : (
            <button
              className="install-act"
              title="从这条清单里去掉"
              onClick={() => void window.butler.install.clear().then(setJobs)}
            >
              知道了
            </button>
          )}
        </div>
      ))}
      {running.length > 0 && (
        <div className="install-hint">
          {compact ? '装的时候不用等，装完通知你。' : '装的时候不用等，可以接着问别的事。装完会通知你，记录页也能查。'}
        </div>
      )}
    </div>
  )
}
