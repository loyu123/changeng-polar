import { registerAppIpc, type IpcContext } from './app'
import { registerChatIpc } from './chat'
import { registerConfigIpc } from './config'
import { registerOrbIpc } from './orb'
import { registerOrchestrationIpc } from './orchestration'
import { registerWorkIpc } from './work'

export type { IpcContext } from './app'

/** 按领域注册全部 IPC：主进程入口只调这一个函数 */
export function registerIpc(ctx: IpcContext): void {
  registerAppIpc(ctx)
  registerConfigIpc(ctx)
  registerChatIpc(ctx)
  registerWorkIpc(ctx)
  registerOrbIpc(ctx)
  registerOrchestrationIpc(ctx)
}
