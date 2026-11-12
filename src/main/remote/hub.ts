/**
 * 事件扇出：把一轮对话的实时事件同时送给桌面窗口和所有已配对的手机。
 *
 * 为什么要单独一层而不是直接往 SSE 里写：
 * 事件的生产方（executeTurn 的 emit）不认识任何客户端，它只喊一声。
 * 谁在听、听几个、断线重连，都是这一层的事。桌面那条链路由 IPC 自己送，
 * 远程这条由这里送——两边的**判定逻辑仍然是同一份**，这里只搬运。
 */
export type RemoteEventListener = (event: unknown) => void

export class RemoteHub {
  private readonly listeners = new Set<RemoteEventListener>()

  subscribe(fn: RemoteEventListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * 广播。**单个订阅者抛错不能影响其他人**：
   * 一个手机 SSE 连接写失败（用户切后台、网络断了）不该让桌面这一轮跟着中断。
   */
  publish(event: unknown): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* 这一路断了就断了，SSE 自己会在下一次心跳时发现 */
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}
