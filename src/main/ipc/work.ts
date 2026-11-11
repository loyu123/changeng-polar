import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ChatSession, TaskDef } from '../../shared/types'
import type { IpcContext } from './app'

/** 定时任务 / 会话：都是"本地数据增删改"，放一处便于对照 */
export function registerWorkIpc(ctx: IpcContext): void {
  registerTaskIpc(ctx)
  registerSessionIpc(ctx)
}

function normalizeTask(raw: Partial<TaskDef> | undefined): TaskDef {
  const name = String(raw?.name ?? '').trim().slice(0, 40) || '未命名任务'
  const prompt = String(raw?.prompt ?? '').trim().slice(0, 500)
  const schedule =
    raw?.schedule?.kind === 'daily'
      ? { kind: 'daily' as const, time: /^\d{1,2}:\d{2}$/.test(raw.schedule.time ?? '') ? raw.schedule.time : '09:00' }
      : { kind: 'interval' as const, minutes: Math.max(1, Math.min(Number(raw?.schedule?.minutes) || 30, 1440)) }
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
    name,
    prompt,
    schedule,
    enabled: raw?.enabled !== false && Boolean(prompt),
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    lastRun: raw?.lastRun,
    lastResult: raw?.lastResult
  }
}

function registerTaskIpc(ctx: IpcContext): void {
  ipcMain.handle('tasks:list', () => ctx.store.listTasks())

  ipcMain.handle('tasks:save', async (_e, raw: Partial<TaskDef>) => {
    const task = normalizeTask(raw)
    if (!task.prompt) throw new Error('任务指令不能为空')
    await ctx.store.upsertTask(task)
    ctx.tasks.reschedule()
    ctx.tasks.broadcast()
    return task
  })

  ipcMain.handle('tasks:delete', async (_e, id: string) => {
    const list = await ctx.store.deleteTask(id)
    ctx.tasks.reschedule()
    ctx.tasks.broadcast()
    return list
  })

  ipcMain.handle('tasks:run', (_e, id: string) => ctx.tasks.runOnce(id))
}

function registerSessionIpc(ctx: IpcContext): void {
  ipcMain.handle('sessions:list', () => ctx.store.listSessions())

  ipcMain.handle('sessions:save', async (_e, raw: Partial<ChatSession>) => {
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()
    const entry: ChatSession = {
      id,
      ts: Number(raw?.ts) || Date.now(),
      title: String(raw?.title ?? '未命名').slice(0, 80),
      messages: Array.isArray(raw?.messages) ? raw.messages.slice(0, 200) : []
    }
    await ctx.store.mutateSessions((current) => {
      const list = current.filter((s) => s.id !== id)
      list.unshift(entry)
      return { list: list.sort((a, b) => b.ts - a.ts).slice(0, 300), result: [] }
    })
    return entry
  })

  ipcMain.handle('sessions:delete', (_e, id: string) =>
    ctx.store.mutateSessions((current) => {
      const next = current.filter((s) => s.id !== id)
      return { list: next, result: next }
    })
  )

  ipcMain.handle('sessions:clear', async () => {
    await ctx.store.saveSessions([])
    return []
  })
}
