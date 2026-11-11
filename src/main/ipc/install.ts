import { ipcMain } from 'electron'
import type { InstallJobView } from '../../shared/types'
import type { InstallJobs } from '../node/install-jobs'

/**
 * 后台安装的列表与取消。
 *
 * 只有这两个动作，而且都是**没有参数校验压力**的那种：一个读清单、一个按 id 取消。
 * 这里不提供"启动一次安装"的入口——安装只能由模型提出来、由用户过授权卡之后由
 * 工具拉起。给渲染层一个"直接装 X"的接口，就等于绕开了整条授权链。
 */
export function registerInstallIpc(jobs: InstallJobs): void {
  ipcMain.handle('install:list', (): InstallJobView[] => jobs.list())

  /**
   * 取消。返回 false 表示它已经不在跑了（装完了、或者本来就是别人的 id）。
   *
   * 措辞上要小心：能打断的只是我们拉起来的那个 winget，**厂商安装器是它的子进程，
   * 杀不掉**。所以取消的语义是"不再等它了"，不是"把安装中止了"。
   */
  ipcMain.handle('install:cancel', (_e, id: string): boolean =>
    typeof id === 'string' ? jobs.cancel(id) : false
  )

  /** 用户点了"知道了"：清掉已经结束的那些，正在跑的留着 */
  ipcMain.handle('install:clear', (): InstallJobView[] => {
    jobs.clearFinished()
    return jobs.list()
  })
}
