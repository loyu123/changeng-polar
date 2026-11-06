import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  BriefDef,
  ChatSession,
  PlanDef,
  ProjectDef,
  TaskDef,
  TodoDef
} from '../../shared/types'
import type { IpcContext } from './app'

/** 定时任务 / 项目 / 待办 / 会话：都是"本地数据增删改"，放一处便于对照 */
export function registerWorkIpc(ctx: IpcContext): void {
  registerTaskIpc(ctx)
  registerProjectIpc(ctx)
  registerTodoIpc(ctx)
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

function registerProjectIpc(ctx: IpcContext): void {
  ipcMain.handle('projects:list', () => ctx.store.listProjects())

  ipcMain.handle('projects:save', async (_e, raw: Partial<ProjectDef>) => {
    const name = String(raw?.name ?? '').trim().slice(0, 40)
    if (!name) throw new Error('项目名不能为空')
    const id = typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()

    // 读-改-写整段交给 Store 排队：对话页「存为方案」和项目页自动保存撞在一起时，
    // 谁后写就把谁整条覆盖，这是读取留在队列外造成的
    return ctx.store.mutateProjects((list) => {
      const existing = list.find((p) => p.id === id)

      // 未传 prompts / plans 时保留原值，避免旧界面（或半截 patch）把方案冲掉
      const prompts = Array.isArray(raw?.prompts)
        ? raw.prompts.map((p) => String(p).trim().slice(0, 300)).filter(Boolean).slice(0, 12)
        : (existing?.prompts ?? [])

      const plans: PlanDef[] = Array.isArray(raw?.plans)
        ? raw.plans
            .map((p) => ({
              id: typeof p?.id === 'string' && p.id ? p.id : randomUUID(),
              title: String(p?.title ?? '').trim().slice(0, 60) || '未命名方案',
              body: String(p?.body ?? '').slice(0, 40000),
              createdAt: typeof p?.createdAt === 'string' && p.createdAt ? p.createdAt : new Date().toISOString(),
              prompt: typeof p?.prompt === 'string' && p.prompt ? p.prompt.slice(0, 4000) : undefined,
              decision:
                typeof p?.decision === 'string' && p.decision.trim() ? p.decision.trim().slice(0, 300) : undefined,
              options: Array.isArray(p?.options)
                ? p.options.map((o) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 5)
                : undefined,
              recommended:
                typeof p?.recommended === 'string' && p.recommended.trim()
                  ? p.recommended.trim().slice(0, 300)
                  : undefined,
              estimate:
                typeof p?.estimate === 'string' && p.estimate.trim() ? p.estimate.trim().slice(0, 120) : undefined,
              firstStep:
                typeof p?.firstStep === 'string' && p.firstStep.trim() ? p.firstStep.trim().slice(0, 300) : undefined,
              source:
                p?.source && typeof p.source.sessionId === 'string' && typeof p.source.messageId === 'string'
                  ? { sessionId: p.source.sessionId, messageId: p.source.messageId }
                  : undefined
            }))
            .slice(0, 30)
        : (existing?.plans ?? [])

      const briefs: BriefDef[] = Array.isArray(raw?.briefs)
        ? raw.briefs
            .map((b) => ({
              id: typeof b?.id === 'string' && b.id ? b.id : randomUUID(),
              createdAt: typeof b?.createdAt === 'string' && b.createdAt ? b.createdAt : new Date().toISOString(),
              body: String(b?.body ?? '').slice(0, 40000),
              snapshot: b?.snapshot
                ? {
                    total: Number(b.snapshot.total) || 0,
                    done: Number(b.snapshot.done) || 0,
                    doing: Number(b.snapshot.doing) || 0,
                    blocked: Number(b.snapshot.blocked) || 0,
                    todo: Number(b.snapshot.todo) || 0
                  }
                : undefined,
              byModel: Boolean(b?.byModel)
            }))
            .filter((b) => b.body.trim().length > 0)
            .slice(0, 20)
        : (existing?.briefs ?? [])

      const proj: ProjectDef = {
        id,
        name,
        goal: typeof raw?.goal === 'string' && raw.goal.trim() ? raw.goal.trim().slice(0, 200) : undefined,
        context:
          typeof raw?.context === 'string' && raw.context.trim() ? raw.context.trim().slice(0, 2000) : undefined,
        constraints:
          typeof raw?.constraints === 'string' && raw.constraints.trim()
            ? raw.constraints.trim().slice(0, 1000)
            : undefined,
        status:
          raw?.status === 'paused' || raw?.status === 'done' || raw?.status === 'active'
            ? raw.status
            : (existing?.status ?? 'active'),
        prompts,
        plans,
        briefs,
        createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }

      const next = [...list]
      const idx = next.findIndex((p) => p.id === proj.id)
      if (idx >= 0) next[idx] = proj
      else next.push(proj)
      return { list: next, result: next }
    })
  })

  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const list = await ctx.store.mutateProjects((current) => {
      const next = current.filter((p) => p.id !== id)
      return { list: next, result: next }
    })
    // 项目删了，挂在它下面的派发任务一起清掉，避免留下找不到归属的孤儿任务
    await ctx.store.mutateTodos((current) => {
      const next = current.filter((t) => t.projectId !== id)
      return { list: next, result: next }
    })
    return list
  })
}

function registerTodoIpc(ctx: IpcContext): void {
  ipcMain.handle('todos:list', () => ctx.store.listTodos())

  ipcMain.handle('todos:save', async (_e, raw: Partial<TodoDef>) => {
    const title = String(raw?.title ?? '').trim().slice(0, 140)
    if (!title) throw new Error('任务标题不能为空')
    const status: TodoDef['status'] =
      raw?.status === 'doing' || raw?.status === 'blocked' || raw?.status === 'done' || raw?.status === 'dropped'
        ? raw.status
        : 'todo'
    const priority: TodoDef['priority'] = raw?.priority === 'high' || raw?.priority === 'low' ? raw.priority : 'normal'
    const todo: TodoDef = {
      id: typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID(),
      projectId: typeof raw?.projectId === 'string' && raw.projectId ? raw.projectId : undefined,
      title,
      detail: typeof raw?.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 1000) : undefined,
      option: typeof raw?.option === 'string' && raw.option.trim() ? raw.option.trim().slice(0, 60) : undefined,
      source:
        raw?.source && typeof raw.source.sessionId === 'string' && typeof raw.source.messageId === 'string'
          ? { sessionId: raw.source.sessionId, messageId: raw.source.messageId }
          : undefined,
      status,
      priority,
      due: typeof raw?.due === 'string' && raw.due ? raw.due : undefined,
      createdAt: typeof raw?.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
      doneAt:
        status === 'done'
          ? typeof raw?.doneAt === 'string' && raw.doneAt
            ? raw.doneAt
            : new Date().toISOString()
          : undefined
    }

    await ctx.store.mutateTodos((current) => {
      const next = [...current]
      const idx = next.findIndex((t) => t.id === todo.id)
      if (idx >= 0) next[idx] = todo
      else next.push(todo)
      return { list: next, result: next }
    })
    return todo
  })

  ipcMain.handle('todos:delete', (_e, id: string) =>
    ctx.store.mutateTodos((current) => {
      const next = current.filter((t) => t.id !== id)
      return { list: next, result: next }
    })
  )
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
