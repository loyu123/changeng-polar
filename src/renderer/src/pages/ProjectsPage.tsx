import { useEffect, useRef, useState } from 'react'
import type { BriefDef, PlanDef, ProjectDef, ProjectStatus, TodoDef, TodoPriority, TodoStatus } from '../../../shared/types'
import { MarkdownText } from '../components/MarkdownText'

interface Props {
  onAsk: (text: string) => void
  /** 跳转目标：选中项目，可选展开某份简报或某个方案（nonce 变化即重新执行） */
  focusProject?: { id: string; nonce: number; briefId?: string; planId?: string } | null
  /** 点「出自对话」：跳回对话页并定位那条回答 */
  onOpenChat?: (sessionId: string, messageId: string) => void
}

const STATUS_TEXT: Record<ProjectStatus, string> = { active: '进行中', paused: '暂停', done: '已完成' }
const TODO_TEXT: Record<TodoStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '卡住',
  done: '完成',
  dropped: '已放弃'
}
const PRI_TEXT: Record<TodoPriority, string> = { high: '高', normal: '中', low: '低' }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 项目有增删改时通知其它页（首页中栏的项目分组、标题栏计数） */
function notifyProjects(): void {
  window.dispatchEvent(new Event('polar:projects-changed'))
}

/** 从方案末尾的元信息块取结构化字段，并把该块从正文里去掉（解析不到就留空，不猜） */
function splitMeta(raw: string): { body: string; meta: Partial<PlanDef> } {
  const match = raw.match(/\n?[-]{3,}[ \t]*\r?\n([\s\S]*?)\r?\n[-]{3,}[ \t]*(?:\r?\n|$)/)
  if (!match) return { body: raw.trim(), meta: {} }
  const block = match[1]
  // 只有真的含元信息键时才认这个块，避免把正文里的两条分隔线当成元信息删掉
  if (!/^(PATHS|RECOMMEND|ESTIMATE|FIRST)\s*[:：]/im.test(block)) return { body: raw.trim(), meta: {} }
  const get = (key: string): string | undefined => {
    const hit = block.match(new RegExp(`^${key}\\s*[:：]\\s*(.+)$`, 'im'))
    const value = hit?.[1]?.trim()
    return value || undefined
  }
  const paths = get('PATHS')
    ?.split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5)
  return {
    body: raw.replace(match[0], '').trim(),
    meta: {
      options: paths && paths.length > 0 ? paths : undefined,
      recommended: get('RECOMMEND'),
      estimate: get('ESTIMATE'),
      firstStep: get('FIRST')
    }
  }
}

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，跨时区会差一天） */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 把一个项目拼成一份可带走的 Markdown（目标/方案/任务/最近简报/常用指令） */
function buildMarkdown(project: ProjectDef, todos: TodoDef[]): string {
  const out: string[] = []
  out.push(`# ${project.name}`, '')
  out.push(`> ${STATUS_TEXT[project.status ?? 'active']} · 导出时间 ${new Date().toLocaleString('zh-CN')}`, '')
  out.push('## 目标', '', project.goal || '_未填写_', '')
  if (project.context) out.push('## 背景', '', project.context, '')
  if (project.constraints) out.push('## 约束', '', project.constraints, '')

  const plans = project.plans ?? []
  if (plans.length > 0) {
    out.push('## 方案', '')
    for (const plan of plans) {
      out.push(`### ${plan.title}`, '')
      if (plan.options?.length) out.push(`- 路径：${plan.options.join(' / ')}`)
      if (plan.recommended) out.push(`- 推荐：${plan.recommended}`)
      if (plan.estimate) out.push(`- 工期：${plan.estimate}`)
      if (plan.firstStep) out.push(`- 第一步：${plan.firstStep}`)
      if (plan.decision) out.push(`- **已采纳：${plan.decision}**`)
      if (plan.source) out.push(`- 出处：对话 ${plan.source.sessionId.slice(0, 8)} · 消息 ${plan.source.messageId.slice(0, 8)}`)
      out.push('', plan.body.trim(), '')
    }
  }

  const alive = todos.filter((t) => t.status !== 'dropped')
  const dropped = todos.filter((t) => t.status === 'dropped')
  out.push('## 任务', '')
  if (alive.length === 0) out.push('_还没有任务_', '')
  for (const todo of alive) {
    const meta = [
      TODO_TEXT[todo.status],
      todo.option ? `路径：${todo.option}` : '',
      `优先级：${PRI_TEXT[todo.priority]}`,
      todo.due ? `截止：${todo.due}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
    out.push(`- ${todo.status === 'done' ? '[x]' : '[ ]'} ${todo.title}  `, `  <sub>${meta}</sub>`)
  }
  if (dropped.length > 0) {
    out.push('', '### 已放弃（路径收敛时归档，可恢复）', '')
    for (const todo of dropped) {
      out.push(`- ~~${todo.title}~~${todo.option ? ` · 路径：${todo.option}` : ''}`)
    }
  }
  out.push('')

  const briefs = project.briefs ?? []
  if (briefs.length > 0) {
    const latest = briefs[0]
    out.push(`## 最近简报（${new Date(latest.createdAt).toLocaleString('zh-CN')}）`, '', latest.body.trim(), '')
  }
  if (project.prompts.length > 0) {
    out.push('## 常用指令', '')
    for (const prompt of project.prompts) out.push(`- ${prompt}`)
    out.push('')
  }
  return out.join('\n')
}

/** 把方案正文里像"步骤"的行抽出来，作为拆任务的初稿 */
function draftSteps(body: string): string {
  return body
    .split('\n')
    .filter((line) => /^\s*([-*+]|\d+[.)、])\s+/.test(line))
    .map((line) => line.replace(/^\s*([-*+]|\d+[.)、])\s+/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line.length > 3)
    .slice(0, 12)
    .join('\n')
}

/** 项目：目标 / 方案 / 派发任务 / 常用指令。只做决策与跟踪，不自动执行 */
export default function ProjectsPage({ onAsk, focusProject, onOpenChat }: Props) {
  const [projects, setProjects] = useState<ProjectDef[]>([])
  const [todos, setTodos] = useState<TodoDef[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ name: string; goal: string } | null>(null)
  const [promptInput, setPromptInput] = useState<Record<string, string>>({})
  const [todoInput, setTodoInput] = useState('')
  const [openPlan, setOpenPlan] = useState<string | null>(null)
  /** 正在编辑决策摘要的方案 */
  const [editingPlan, setEditingPlan] = useState<string | null>(null)
  const [splitting, setSplitting] = useState<{ planId: string; text: string; option?: string } | null>(null)
  /** 按方案路径筛选任务（null = 全部） */
  const [filterOption, setFilterOption] = useState<string | null>(null)
  /** 是否显示路径收敛时被放弃的任务（默认隐藏） */
  const [showDropped, setShowDropped] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [openBrief, setOpenBrief] = useState<string | null>(null)
  const [generatingBrief, setGeneratingBrief] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async (): Promise<void> => {
    const [list, todoList] = await Promise.all([window.butler.projects.list(), window.butler.todos.list()])
    setProjects(list)
    setTodos(todoList)
    setActiveId((prev) => (prev && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null)))
  }

  useEffect(() => {
    void load()
  }, [])

  // 从总览/搜索跳过来：选中项目，并展开指定的简报或方案
  useEffect(() => {
    if (!focusProject?.id) return
    setActiveId(focusProject.id)
    if (focusProject.briefId) setOpenBrief(focusProject.briefId)
    if (focusProject.planId) setOpenPlan(focusProject.planId)
  }, [focusProject])

  // 换项目时清掉路径筛选，避免沿用到另一个项目
  useEffect(() => {
    setFilterOption(null)
  }, [activeId])

  // 连续两次失焦保存时，闭包里的 active 可能是旧的：始终用最新一份做底
  const latestRef = useRef<ProjectDef[]>(projects)
  latestRef.current = projects

  const active = projects.find((p) => p.id === activeId) ?? null
  const plans = active?.plans ?? []
  const briefs = active?.briefs ?? []
  const projectTodos = todos.filter((t) => t.projectId === active?.id)
  const shownTodos = filterOption ? projectTodos.filter((t) => t.option === filterOption) : projectTodos
  /** 被放弃的任务默认不显示，但仍保留可回看 */
  const droppedCount = shownTodos.filter((t) => t.status === 'dropped').length
  const visibleTodos = showDropped ? shownTodos : shownTodos.filter((t) => t.status !== 'dropped')
  /** 进度分母不含已放弃的任务 */
  const activeCount = projectTodos.filter((t) => t.status !== 'dropped').length
  const doneCount = projectTodos.filter((t) => t.status === 'done').length
  /** 当前项目所有方案里出现过的路径名（并集），给任务归属下拉用 */
  const optionNames = Array.from(new Set(plans.flatMap((p) => p.options ?? [])))

  const saveProject = async (patch: Partial<ProjectDef>): Promise<void> => {
    if (!active) return
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    try {
      const list = await window.butler.projects.save({ ...current, ...patch })
      setProjects(list)
      notifyProjects()
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    }
  }

  const createProject = async (): Promise<void> => {
    const name = adding?.name.trim()
    if (!name) return
    try {
      const list = await window.butler.projects.save({
        name,
        goal: adding?.goal.trim() || undefined,
        status: 'active',
        prompts: []
      })
      setProjects(list)
      setActiveId(list.find((p) => p.name === name)?.id ?? list[list.length - 1]?.id ?? null)
      setAdding(null)
      setStatus(null)
      notifyProjects()
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    }
  }

  const removeProject = async (): Promise<void> => {
    if (!active) return
    if (!window.confirm(`删除项目「${active.name}」？项目下的方案与任务会一起删除，不能恢复。`)) return
    const list = await window.butler.projects.delete(active.id)
    setProjects(list)
    setTodos(await window.butler.todos.list())
    setActiveId(list[0]?.id ?? null)
    setStatus(null)
    notifyProjects()
  }

  /** 导出当前项目档案（目标/方案/任务/最近简报/指令）为 Markdown */
  const exportProject = async (): Promise<void> => {
    if (!active) return
    const markdown = buildMarkdown({ ...active, plans, briefs }, projectTodos)
    try {
      const res = await window.butler.projects.exportMarkdown({ name: active.name, markdown })
      if (res.canceled) return
      setStatus(res.ok ? { ok: true, text: `已导出：${res.path ?? ''}` } : { ok: false, text: '导出失败' })
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    }
  }

  const addPrompt = async (): Promise<void> => {
    if (!active) return
    const text = (promptInput[active.id] ?? '').trim()
    if (!text) return
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    await saveProject({ prompts: [...current.prompts, text] })
    setPromptInput((prev) => ({ ...prev, [active.id]: '' }))
  }

  const removePrompt = async (index: number): Promise<void> => {
    if (!active) return
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    await saveProject({ prompts: current.prompts.filter((_, i) => i !== index) })
  }

  /** 生成方案：只跑一轮纯思考（不落进对话页），结果作为方案实体保存 */
  const generatePlan = async (): Promise<void> => {
    if (!active || generating) return
    setGenerating(true)
    setStatus(null)
    const prompt = [
      `请为下面这个项目出一份可执行的可行性方案。直接给结论，不要客套。`,
      `项目：${active.name}`,
      active.goal ? `目标：${active.goal}` : '目标：（我还没写，请先帮我判断该定成什么）',
      active.context ? `背景：${active.context}` : '',
      active.constraints ? `约束：${active.constraints}` : '',
      '',
      '按这个结构用 Markdown 写：',
      '1. 一句话复述目标；',
      '2. 2–3 条可选路径，每条写清代价与风险；',
      '3. 推荐哪一条，为什么；',
      '4. 需要哪些资源（应用 / 文件 / 账号 / 时间）；',
      '5. 现实的时间估计；',
      '6. 第一步的具体动作（可以直接派给别人的粒度）。',
      '',
      '最后另起一段，给一个元信息块，严格用下面的格式（三条横线包裹，不要加别的解释）：',
      '---',
      'PATHS: 路径一的名字 | 路径二的名字 | 路径三的名字',
      'RECOMMEND: 推荐哪条 + 半句理由',
      'ESTIMATE: 工期估计',
      'FIRST: 第一步动作',
      '---',
      '',
      '关于本机的事实，查不到就写「未查证」，不要编。这份方案不会自动执行任何操作。'
    ]
      .filter(Boolean)
      .join('\n')

    try {
      // 纯写字：不走 chat.send，模型拿不到工具，也就不会在生成过程中申请授权
      const result = await window.butler.llm.complete({ messages: [{ role: 'user', content: prompt }] })
      if (!result.ok) {
        setStatus({ ok: false, text: `生成失败：${result.error}` })
        return
      }
      if (!result.text) {
        setStatus({ ok: false, text: '生成失败：模型没有返回内容' })
        return
      }
      const parsed = splitMeta(result.text)
      const plan: PlanDef = {
        id: crypto.randomUUID(),
        title: `方案 · ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        body: parsed.body || result.text,
        prompt,
        createdAt: new Date().toISOString(),
        ...parsed.meta
      }
      const list = await window.butler.projects.save({ ...active, plans: [plan, ...plans] })
      setProjects(list)
      setOpenPlan(plan.id)
      setStatus({ ok: true, text: `方案已保存（${plan.body.length} 字），可以拆成任务` })
    } catch (err) {
      setStatus({ ok: false, text: `生成失败：${errorText(err)}` })
    } finally {
      setGenerating(false)
    }
  }

  const deletePlan = async (planId: string): Promise<void> => {
    if (!active) return
    await saveProject({ plans: plans.filter((p) => p.id !== planId) })
    if (openPlan === planId) setOpenPlan(null)
  }

  const saveDecision = async (planId: string, decision: string): Promise<void> => {
    if (!active) return
    await saveProject({
      plans: plans.map((p) => (p.id === planId ? { ...p, decision: decision.trim() || undefined } : p))
    })
  }

  /** 手改方案的结构化字段（路径/推荐/工期/第一步） */
  const savePlanMeta = async (planId: string, patch: Partial<PlanDef>): Promise<void> => {
    if (!active) return
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    const list = current.plans ?? []
    await saveProject({ plans: list.map((p) => (p.id === planId ? { ...p, ...patch } : p)) })
  }

  /** 改路径名时，把挂在旧名下的任务一起迁到新名（只有条数没变、纯改名才迁） */
  const applyOptions = async (planId: string, next: string[]): Promise<void> => {
    if (!active) return
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    const prev = (current.plans ?? []).find((p) => p.id === planId)?.options ?? []
    await savePlanMeta(planId, { options: next })
    if (next.length !== prev.length) return
    const renames = next
      .map((to, i) => ({ from: prev[i], to }))
      .filter((r) => Boolean(r.from) && Boolean(r.to) && r.from !== r.to)
    if (renames.length === 0) return
    const all = await window.butler.todos.list()
    for (const rename of renames) {
      for (const todo of all.filter((t) => t.projectId === active.id && t.option === rename.from)) {
        await window.butler.todos.save({ ...todo, option: rename.to })
      }
    }
    setTodos(await window.butler.todos.list())
    // 筛选器还停在旧路径名上时跟着改名，否则任务列表会突然变空
    if (filterOption) {
      const hit = renames.find((r) => r.from === filterOption)
      if (hit) setFilterOption(hit.to)
    }
    notifyProjects()
  }

  /** 决策收敛：选定一条路径，其他路径下未完成的任务标为「已放弃」（不删除，可恢复） */
  const adoptOption = async (plan: PlanDef, option: string): Promise<void> => {
    if (!active) return
    const others = (plan.options ?? []).filter((o) => o !== option)
    const dropList = projectTodos.filter(
      (t) =>
        t.option && t.option !== option && others.includes(t.option) && t.status !== 'done' && t.status !== 'dropped'
    )
    if (
      dropList.length > 0 &&
      !window.confirm(
        `按「${option}」推进？\n其他路径下 ${dropList.length} 条未完成任务会标为「已放弃」——不删除，可随时恢复。`
      )
    ) {
      return
    }
    await savePlanMeta(plan.id, { decision: option })
    for (const todo of dropList) {
      await window.butler.todos.save({ ...todo, status: 'dropped' })
    }
    setTodos(await window.butler.todos.list())
    setFilterOption(option)
    setStatus({
      ok: true,
      text: `已按「${option}」推进${dropList.length > 0 ? `，${dropList.length} 条其他路径的任务已归档` : ''}`
    })
    notifyProjects()
  }

  /** 生成项目简报：先算出事实块，再让模型写成判断；模型不可用时直接给事实版 */
  const generateBrief = async (): Promise<void> => {
    if (!active || generatingBrief) return
    setGeneratingBrief(true)
    setStatus(null)
    const current = latestRef.current.find((p) => p.id === active.id) ?? active
    const list = todos.filter((t) => t.projectId === current.id)
    const by = (s: TodoStatus): TodoDef[] => list.filter((t) => t.status === s)
    const droppedNow = by('dropped').length
    const overdueNow = list.filter(
      (t) => t.due && t.due < todayStr() && t.status !== 'done' && t.status !== 'dropped'
    ).length
    const snapshot = {
      // 已放弃的不进分母，否则进度会被已收敛掉的路线拖低
      total: list.length - droppedNow,
      done: by('done').length,
      doing: by('doing').length,
      blocked: by('blocked').length,
      todo: by('todo').length
    }
    const lines = (arr: TodoDef[]): string => (arr.length > 0 ? arr.map((t) => `- ${t.title}`).join('\n') : '- 无')
    const latestPlan = (current.plans ?? [])[0]
    const prevBrief = (current.briefs ?? [])[0]

    const facts = [
      `项目：${current.name}`,
      `目标：${current.goal || '未写'}`,
      `背景：${current.context || '未写'}`,
      `约束：${current.constraints || '未写'}`,
      `进度：共 ${snapshot.total} 条任务，已完成 ${snapshot.done}，进行中 ${snapshot.doing}，卡住 ${snapshot.blocked}，待办 ${snapshot.todo}`,
      `进行中：\n${lines(by('doing'))}`,
      `卡住：\n${lines(by('blocked'))}`,
      `待办：\n${lines(by('todo'))}`,
      `已完成：\n${lines(by('done'))}`,
      current.plans?.length
        ? `方案：共 ${current.plans.length} 份，最近一份《${latestPlan?.title ?? ''}》；推荐：${latestPlan?.recommended ?? '未标注'}；工期：${latestPlan?.estimate ?? '未标注'}；已采纳：${latestPlan?.decision ?? '未标注'}`
        : '方案：还没有方案',
      ...(latestPlan?.options ?? []).map((opt) => {
        const optTasks = list.filter((t) => t.option === opt && t.status !== 'dropped')
        return `路径「${opt}」：${optTasks.length} 条任务，完成 ${optTasks.filter((t) => t.status === 'done').length}`
      }),
      droppedNow > 0 ? `已放弃：${droppedNow} 条（路径收敛时归档，不在进度内）` : '',
      overdueNow > 0 ? `逾期：${overdueNow} 条（截止日期已过）` : '',
      prevBrief?.snapshot
        ? `上次简报（${new Date(prevBrief.createdAt).toLocaleString('zh-CN')}）：完成 ${prevBrief.snapshot.done}/${prevBrief.snapshot.total}，卡住 ${prevBrief.snapshot.blocked}`
        : '上次简报：无',
      `最近改动：${current.updatedAt ? new Date(current.updatedAt).toLocaleString('zh-CN') : '未知'}`
    ].join('\n\n')

    const prompt = [
      '你是我的项目副手。根据下面的事实，写一份项目简报。Markdown，不要客套，不要标题党。',
      '',
      '结构：',
      '1. 一句话：现在到哪了；',
      '2. 三个数字：完成/总数、卡住数、最该动的一条；',
      '3. 变化：如果给了上次简报的进度，说明这次推进了什么（完成数、卡点数）；没有上次就写「首次简报」；',
      '4. 卡在哪：有卡住的任务就说它可能卡在哪、需要什么才能解开；没有就写「没有卡点」；',
      '5. 下一步：给 1–3 条具体动作，按优先级排序，每条一行；',
      '6. 提醒：如果目标或约束为空、或者任务全停在待办，直接指出来。',
      '',
      '只使用下面的事实，不要编造进度、数字或任务名。',
      '',
      '=== 事实 ===',
      facts
    ].join('\n')

    let body = ''
    let byModel = false
    try {
      // 同上：纯写字补全，不经过工具链路
      const result = await window.butler.llm.complete({ messages: [{ role: 'user', content: prompt }] })
      if (result.ok && result.text) {
        body = result.text
        byModel = true
      } else if (!result.ok) {
        setStatus({ ok: false, text: `模型不可用（${result.error}），已生成事实版简报` })
      }
    } catch (err) {
      setStatus({ ok: false, text: `模型不可用（${errorText(err)}），已生成事实版简报` })
    }

    if (!body) {
      const nextUp = (by('doing').length > 0 ? by('doing') : by('todo')).slice(0, 3)
      body = [
        `**${current.name}** · ${new Date().toLocaleDateString('zh-CN')}`,
        '',
        `进度：${snapshot.done}/${snapshot.total} 完成，${snapshot.doing} 进行中，${snapshot.blocked} 卡住，${snapshot.todo} 待办。`,
        prevBrief?.snapshot
          ? `较上次：完成 ${snapshot.done - prevBrief.snapshot.done >= 0 ? '+' : ''}${snapshot.done - prevBrief.snapshot.done}，卡住 ${snapshot.blocked - prevBrief.snapshot.blocked >= 0 ? '+' : ''}${snapshot.blocked - prevBrief.snapshot.blocked}。`
          : '',
        '',
        '### 卡在哪',
        by('blocked').length > 0 ? by('blocked').map((t) => `- ${t.title}`).join('\n') : '没有卡点。',
        '',
        '### 下一步',
        nextUp.length > 0 ? nextUp.map((t) => `- ${t.title}`).join('\n') : '- 还没有任务，先在方案里拆几条。'
      ].join('\n')
    }

    const brief: BriefDef = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      body,
      snapshot,
      byModel
    }
    try {
      const next = await window.butler.projects.save({ ...current, briefs: [brief, ...(current.briefs ?? [])] })
      setProjects(next)
      setOpenBrief(brief.id)
      notifyProjects()
    } catch (err) {
      setStatus({ ok: false, text: errorText(err) })
    } finally {
      setGeneratingBrief(false)
    }
  }

  const deleteBrief = async (briefId: string): Promise<void> => {
    if (!active) return
    await saveProject({ briefs: briefs.filter((b) => b.id !== briefId) })
    if (openBrief === briefId) setOpenBrief(null)
  }

  const addTodo = async (title: string, priority: TodoPriority = 'normal'): Promise<void> => {
    if (!active || !title.trim()) return
    await window.butler.todos.save({
      projectId: active.id,
      title: title.trim(),
      status: 'todo',
      priority,
      option: filterOption ?? undefined
    })
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  const cycleTodo = async (todo: TodoDef): Promise<void> => {
    // 四态循环：待办 → 进行中 → 卡住 → 完成 → 待办
    const next: TodoStatus =
      todo.status === 'todo'
        ? 'doing'
        : todo.status === 'doing'
          ? 'blocked'
          : todo.status === 'blocked'
            ? 'done'
            : 'todo'
    await window.butler.todos.save({ ...todo, status: next })
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  const cyclePriority = async (todo: TodoDef): Promise<void> => {
    const next: TodoPriority = todo.priority === 'normal' ? 'high' : todo.priority === 'high' ? 'low' : 'normal'
    await window.butler.todos.save({ ...todo, priority: next })
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  /** 直接改一条任务的路径归属（空 = 不归属） */
  const setTodoOption = async (todo: TodoDef, option?: string): Promise<void> => {
    await window.butler.todos.save({ ...todo, option })
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  /** 改截止日期（空 = 清除） */
  const setTodoDue = async (todo: TodoDef, due?: string): Promise<void> => {
    await window.butler.todos.save({ ...todo, due })
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  const removeTodo = async (id: string): Promise<void> => {
    await window.butler.todos.delete(id)
    setTodos(await window.butler.todos.list())
    notifyProjects()
  }

  /** 把方案正文里的步骤批量派发成任务 */
  const splitPlan = async (): Promise<void> => {
    if (!splitting || !active) return
    const lines = splitting.text
      .split('\n')
      .map((line) => line.replace(/^\s*([-*+]|\d+[.)、])\s+/, '').trim())
      .filter((line) => line.length > 1)
      .slice(0, 20)
    for (const line of lines) {
      await window.butler.todos.save({
        projectId: active.id,
        title: line.slice(0, 140),
        status: 'todo',
        priority: 'normal',
        option: splitting.option || undefined
      })
    }
    setTodos(await window.butler.todos.list())
    notifyProjects()
    setSplitting(null)
    setStatus({ ok: true, text: lines.length > 0 ? `已派发 ${lines.length} 条任务` : '没有可拆的行' })
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <aside className="mid">
        <div className="mid-h">
          <h2>项目</h2>
        </div>
        <button className="newchat" onClick={() => setAdding({ name: '', goal: '' })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建项目
        </button>
        <div className="seclabel">
          全部项目<span className="cnt">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <div className="empty-mid">
            <b>还没有项目</b>
            一个项目 = 一个目标 + 它的方案和任务
          </div>
        ) : (
          projects.map((p) => {
            const planCount = p.plans?.length ?? 0
            const todoCount = todos.filter(
              (t) => t.projectId === p.id && t.status !== 'done' && t.status !== 'dropped'
            ).length
            return (
              <button key={p.id} className={`item two${p.id === activeId ? ' sel' : ''}`} onClick={() => setActiveId(p.id)}>
                <span className="t">
                  {p.name}
                  <span className="sub">
                    {(p.status ?? 'active') === 'done' ? '已完成' : (p.status ?? 'active') === 'paused' ? '暂停' : '进行中'} · 方案 {planCount} · 未完成 {todoCount}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </aside>

      <main className="content" style={{ padding: 0 }}>
        <div className="acc-wrap">
          {adding ? (
            <div className="card form" style={{ maxWidth: 640 }}>
              <div className="form-row">
                <label>项目名</label>
                <input
                  className="input"
                  autoFocus
                  value={adding.name}
                  placeholder="比如：把家里的照片整理成册"
                  maxLength={40}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>目标（一句话：做成什么样算完成）</label>
                <textarea
                  className="input"
                  style={{ height: 66, padding: '8px 10px', resize: 'vertical' }}
                  value={adding.goal}
                  placeholder="比如：三年内所有照片按年份分类，每类一个相册，能随时找到"
                  maxLength={200}
                  onChange={(e) => setAdding({ ...adding, goal: e.target.value })}
                />
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" disabled={!adding.name.trim()} onClick={() => void createProject()}>
                  创建项目
                </button>
                <button className="btn btn-ghost" onClick={() => setAdding(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : !active ? (
            <div className="taskwrap">
              <div className="task">
                <svg className="gauge" width="106" height="94" viewBox="0 0 72 64" fill="none">
                  <circle cx="36" cy="34" r="24" stroke="#CFE0EE" strokeWidth="1.5" strokeDasharray="105 46" strokeLinecap="round" transform="rotate(-90 36 34)" />
                  <path d="M36 34V19" stroke="#B9D0E4" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M36 34l9.5 5.5" stroke="#B9D0E4" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="36" cy="34" r="2.3" fill="#A8C8E8" />
                  <circle cx="57" cy="16" r="2.2" fill="#D8B87A" />
                </svg>
                <h3>还没有项目</h3>
                <p>
                  一个项目 = 一个目标 + 一份方案 + 一串派发出去的任务。
                  <br />
                  先写目标，再让长庚出方案，最后拆成能做的活。
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="blkbtn"
                    onClick={() => setAdding({ name: '', goal: '' })}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    新建项目
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="acc-h">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1>{active.name}</h1>
                  <p>{active.goal || '还没写目标。目标写清楚了，方案才有判断依据。'}</p>
                </div>
                <span className="sp" />
                <div className="pstat-group">
                  {(['active', 'paused', 'done'] as ProjectStatus[]).map((s) => (
                    <button
                      key={s}
                      className={`pstat${(active.status ?? 'active') === s ? ' on' : ''}`}
                      onClick={() => void saveProject({ status: s })}
                    >
                      {STATUS_TEXT[s]}
                    </button>
                  ))}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => void exportProject()} title="导出为 Markdown，可带离本应用">
                  导出 Markdown
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => void removeProject()}>
                  删除项目
                </button>
              </div>

              <div className="cardbox">
                <div className="ch">目标与背景</div>
                <div className="row">
                  <div className="rl">
                    <b>目标</b>
                    <span>做成什么样算完成，一句话</span>
                  </div>
                  <input
                    className="input"
                    style={{ maxWidth: 360 }}
                    key={`goal-${active.id}`}
                    defaultValue={active.goal ?? ''}
                    maxLength={200}
                    placeholder="三年内照片按年份分好，随时能找到"
                    onBlur={(e) => {
                      if (e.target.value.trim() !== (active.goal ?? '')) void saveProject({ goal: e.target.value.trim() || undefined })
                    }}
                  />
                </div>
                <div className="row">
                  <div className="rl">
                    <b>背景</b>
                    <span>现状、已经有什么、卡在哪</span>
                  </div>
                  <input
                    className="input"
                    style={{ maxWidth: 360 }}
                    key={`ctx-${active.id}`}
                    defaultValue={active.context ?? ''}
                    maxLength={2000}
                    placeholder="硬盘里约 2 万张，散在六个目录"
                    onBlur={(e) => {
                      if (e.target.value.trim() !== (active.context ?? ''))
                        void saveProject({ context: e.target.value.trim() || undefined })
                    }}
                  />
                </div>
                <div className="row">
                  <div className="rl">
                    <b>约束</b>
                    <span>时间、预算、不能碰的东西</span>
                  </div>
                  <input
                    className="input"
                    style={{ maxWidth: 360 }}
                    key={`cst-${active.id}`}
                    defaultValue={active.constraints ?? ''}
                    maxLength={1000}
                    placeholder="不能删原图；每周最多花 2 小时"
                    onBlur={(e) => {
                      if (e.target.value.trim() !== (active.constraints ?? ''))
                        void saveProject({ constraints: e.target.value.trim() || undefined })
                    }}
                  />
                </div>
              </div>

              <div className="cardbox">
                <div className="ch">方案</div>
                <div className="row">
                  <div className="rl">
                    <b>可行性方案</b>
                    <span>只生成文本、只存本地；不会自动执行任何操作</span>
                  </div>
                  <button className="btn btn-ghost btn-sm" disabled={generating} onClick={() => void generatePlan()}>
                    {generating ? '生成中…' : '生成方案'}
                  </button>
                </div>
                {plans.length === 0 && (
                  <div className="row">
                    <div className="rl">
                      <span>还没有方案。点上面「生成方案」，长庚会按目标/背景/约束给 2–3 条路径、风险和第一步。</span>
                    </div>
                  </div>
                )}
                {plans.map((plan) => (
                  <div className="plan" key={plan.id}>
                    <button className="plan-h" onClick={() => setOpenPlan(openPlan === plan.id ? null : plan.id)}>
                      <span className="pt">{plan.title}</span>
                      {plan.decision && <span className="pdec">已选：{plan.decision}</span>}
                      <span className="pd">{new Date(plan.createdAt).toLocaleDateString('zh-CN')}</span>
                      <span className={`chev${openPlan === plan.id ? '' : ' closed'}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                          <path d="M7 10l5 5 5-5" />
                        </svg>
                      </span>
                    </button>
                    {openPlan === plan.id && (
                      <div className="plan-b">
                        {editingPlan === plan.id ? (
                          <div className="plan-deck">
                            <div className="deck-row">
                              <span className="dk">路径</span>
                              <input
                                className="input"
                                defaultValue={(plan.options ?? []).join(' | ')}
                                placeholder="路径一 | 路径二（用竖线分隔）"
                                onBlur={(e) =>
                                  void applyOptions(
                                    plan.id,
                                    e.target.value
                                      .split('|')
                                      .map((s) => s.trim())
                                      .filter(Boolean)
                                      .slice(0, 5)
                                  )
                                }
                              />
                            </div>
                            <div className="deck-row">
                              <span className="dk">推荐</span>
                              <input
                                className="input"
                                defaultValue={plan.recommended ?? ''}
                                placeholder="推荐哪条，为什么"
                                onBlur={(e) => void savePlanMeta(plan.id, { recommended: e.target.value.trim() || undefined })}
                              />
                            </div>
                            <div className="deck-row">
                              <span className="dk">工期</span>
                              <input
                                className="input"
                                defaultValue={plan.estimate ?? ''}
                                placeholder="比如 2 周"
                                onBlur={(e) => void savePlanMeta(plan.id, { estimate: e.target.value.trim() || undefined })}
                              />
                            </div>
                            <div className="deck-row">
                              <span className="dk">第一步</span>
                              <input
                                className="input"
                                defaultValue={plan.firstStep ?? ''}
                                placeholder="第一步做什么"
                                onBlur={(e) => void savePlanMeta(plan.id, { firstStep: e.target.value.trim() || undefined })}
                              />
                            </div>
                            <div className="deck-foot">
                              <button className="btn btn-primary btn-sm" onClick={() => setEditingPlan(null)}>
                                完成
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="plan-deck">
                            <div className="deck-row">
                              <span className="dk">路径</span>
                              <span className="deck-chips">
                                {(plan.options ?? []).length > 0 ? (
                                  (plan.options ?? []).map((opt) => (
                                    <span className="dchip" key={opt}>
                                      {opt}
                                    </span>
                                  ))
                                ) : (
                                  <span className="dv">未解析</span>
                                )}
                              </span>
                            </div>
                            <div className="deck-row">
                              <span className="dk">推荐</span>
                              <span className="dv">{plan.recommended ?? '未标注'}</span>
                            </div>
                            <div className="deck-row">
                              <span className="dk">工期</span>
                              <span className="dv">{plan.estimate ?? '未标注'}</span>
                            </div>
                            <div className="deck-row">
                              <span className="dk">第一步</span>
                              <span className="dv">{plan.firstStep ?? '未标注'}</span>
                            </div>
                          </div>
                        )}
                        {(plan.options ?? []).length > 0 && (
                          <div className="opt-cmp">
                            {(plan.options ?? []).map((opt) => {
                              const list = projectTodos.filter((t) => t.option === opt && t.status !== 'dropped')
                              const done = list.filter((t) => t.status === 'done').length
                              const adopted = plan.decision === opt
                              return (
                                <span className="optwrap" key={opt}>
                                  <button
                                    className={`optrow${filterOption === opt ? ' on' : ''}`}
                                    onClick={() => setFilterOption(filterOption === opt ? null : opt)}
                                    title="按这条路径筛选下面的任务"
                                  >
                                    <span className="oname">{opt}</span>
                                    <span className="ocnt">
                                      {done}/{list.length}
                                    </span>
                                  </button>
                                  {adopted ? (
                                    <span className="optadopt">已选定</span>
                                  ) : (
                                    <button
                                      className="optgo"
                                      title="就按这条走：其他路径的未完成任务标为已放弃（可恢复）"
                                      onClick={() => void adoptOption(plan, opt)}
                                    >
                                      按这条走
                                    </button>
                                  )}
                                </span>
                              )
                            })}
                            {filterOption && (
                              <button className="linkbtn" onClick={() => setFilterOption(null)}>
                                显示全部
                              </button>
                            )}
                          </div>
                        )}
                        <div className="plan-body">
                          <MarkdownText text={plan.body} />
                        </div>
                        <div className="plan-foot">
                          <input
                            className="input"
                            style={{ height: 28, fontSize: 12, maxWidth: 220 }}
                            defaultValue={plan.decision ?? ''}
                            placeholder="采纳哪条路径（一句话）"
                            maxLength={300}
                            onBlur={(e) => void saveDecision(plan.id, e.target.value)}
                          />
                          {plan.source && (
                            <button
                              className="linkbtn"
                              title="回到产出这份方案的那条回答"
                              onClick={() =>
                                plan.source && onOpenChat?.(plan.source.sessionId, plan.source.messageId)
                              }
                            >
                              出自对话
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setEditingPlan(editingPlan === plan.id ? null : plan.id)}
                          >
                            {editingPlan === plan.id ? '收起编辑' : '编辑摘要'}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setSplitting({ planId: plan.id, text: draftSteps(plan.body) })}
                          >
                            拆成任务
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', color: 'var(--red)' }} onClick={() => void deletePlan(plan.id)}>
                            删除方案
                          </button>
                        </div>
                        {splitting?.planId === plan.id && (
                          <div className="plan-split">
                            <div className="hint" style={{ marginBottom: 6 }}>
                              每行一条任务；确认后写入「派发任务」，不会自动执行。
                            </div>
                            {(plan.options ?? []).length > 0 && (
                              <div className="form-actions" style={{ marginBottom: 8, justifyContent: 'flex-start' }}>
                                <span className="hint">挂到路径</span>
                                <select
                                  className="input"
                                  style={{ width: 220, height: 28 }}
                                  value={splitting.option ?? ''}
                                  onChange={(e) => setSplitting({ ...splitting, option: e.target.value || undefined })}
                                >
                                  <option value="">不归属路径</option>
                                  {(plan.options ?? []).map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <textarea
                              className="input"
                              style={{ height: 96, padding: '8px 10px', resize: 'vertical' }}
                              value={splitting.text}
                              onChange={(e) => setSplitting({ ...splitting, text: e.target.value })}
                            />
                            <div className="form-actions" style={{ marginTop: 8 }}>
                              <button className="btn btn-primary btn-sm" onClick={() => void splitPlan()}>
                                派发
                              </button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setSplitting(null)}>
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="cardbox">
                <div className="ch">派发任务</div>
                <div className="row">
                  <div className="rl">
                    <b>{filterOption ? `待办 · ${filterOption}` : '待办'}</b>
                    <span>
                      {doneCount}/{activeCount} 完成 · 点状态循环：待办 → 进行中 → 卡住 → 完成
                      {filterOption ? ` · 这条路径 ${visibleTodos.length} 条` : ''}
                    </span>
                  </div>
                  {droppedCount > 0 && (
                    <button className="linkbtn" onClick={() => setShowDropped((v) => !v)}>
                      {showDropped ? '隐藏已放弃' : `显示已放弃 ${droppedCount}`}
                    </button>
                  )}
                  {filterOption && (
                    <button className="linkbtn" onClick={() => setFilterOption(null)}>
                      显示全部路径
                    </button>
                  )}
                </div>
                {visibleTodos.length === 0 && (
                  <div className="row">
                    <div className="rl">
                      <span>
                        {filterOption
                          ? '这条路径下还没有任务。在方案里拆任务时选择它，或在下面直接加一条（会自动挂到这条路径）。'
                          : '还没有任务。在方案里点「拆成任务」，或在下面直接加一条。'}
                      </span>
                    </div>
                  </div>
                )}
                {visibleTodos.map((todo) => (
                  <div className="todo" key={todo.id}>
                    <button className={`tstat ${todo.status}`} onClick={() => void cycleTodo(todo)} title="切换状态">
                      {TODO_TEXT[todo.status]}
                    </button>
                    <span className={`ttext${todo.status === 'done' || todo.status === 'dropped' ? ' done' : ''}`}>
                      {todo.title}
                    </span>
                    {todo.source && (
                      <button
                        className="tsrc"
                        title="出自对话：回到产出这条任务的那条回答"
                        onClick={() =>
                          todo.source && onOpenChat?.(todo.source.sessionId, todo.source.messageId)
                        }
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                          <path d="M9.6 14.4a3.6 3.6 0 0 0 5.1 0l2.2-2.2a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2" />
                          <path d="M14.4 9.6a3.6 3.6 0 0 0-5.1 0l-2.2 2.2a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2" />
                        </svg>
                      </button>
                    )}
                    {(optionNames.length > 0 || todo.option) && (
                      <select
                        className="topt-sel"
                        value={todo.option ?? ''}
                        title="所属路径（可改）"
                        onChange={(e) => void setTodoOption(todo, e.target.value || undefined)}
                      >
                        <option value="">不归属</option>
                        {(todo.option && !optionNames.includes(todo.option)
                          ? [...optionNames, todo.option]
                          : optionNames
                        ).map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    )}
                    <button className={`tpri ${todo.priority}`} onClick={() => void cyclePriority(todo)} title="切换优先级">
                      {PRI_TEXT[todo.priority]}
                    </button>
                    <input
                      type="date"
                      className={`tdue${
                        todo.due && todo.due < todayStr() && todo.status !== 'done' ? ' overdue' : ''
                      }`}
                      value={todo.due ?? ''}
                      title="截止日期"
                      onChange={(e) => void setTodoDue(todo, e.target.value || undefined)}
                    />
                    <button className="todo-del" onClick={() => void removeTodo(todo.id)} title="删除任务">
                      删除
                    </button>
                  </div>
                ))}
                <div className="row">
                  <input
                    className="input"
                    placeholder="加一条待办，回车提交"
                    maxLength={140}
                    value={todoInput}
                    onChange={(e) => setTodoInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && todoInput.trim()) {
                        void addTodo(todoInput).then(() => setTodoInput(''))
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!todoInput.trim()}
                    onClick={() => void addTodo(todoInput).then(() => setTodoInput(''))}
                  >
                    添加
                  </button>
                </div>
              </div>

              <div className="cardbox">
                <div className="ch">项目简报</div>
                <div className="row">
                  <div className="rl">
                    <b>当前进度</b>
                    <span>把任务进度、卡点、方案采纳情况汇总成一段；只读快照，不改任务</span>
                  </div>
                  <button className="btn btn-ghost btn-sm" disabled={generatingBrief} onClick={() => void generateBrief()}>
                    {generatingBrief ? '生成中…' : '生成简报'}
                  </button>
                </div>
                {briefs.length === 0 && (
                  <div className="row">
                    <div className="rl">
                      <span>还没有简报。点「生成简报」出一份带判断的进度报告，不需要每天打开也能回看当时到哪了。</span>
                    </div>
                  </div>
                )}
                {briefs.map((brief, index) => (
                  <div className="plan" key={brief.id}>
                    <button className="plan-h" onClick={() => setOpenBrief(openBrief === brief.id ? null : brief.id)}>
                      <span className="pt">
                        {new Date(brief.createdAt).toLocaleString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                      {brief.snapshot && (
                        <span className="pdec">
                          {brief.snapshot.done}/{brief.snapshot.total} 完成
                          {brief.snapshot.blocked > 0 ? ` · ${brief.snapshot.blocked} 卡住` : ''}
                        </span>
                      )}
                      {(() => {
                        const prev = briefs[index + 1]
                        if (!prev?.snapshot || !brief.snapshot) return null
                        const delta = brief.snapshot.done - prev.snapshot.done
                        if (delta === 0) return null
                        return (
                          <span className={`pdec${delta > 0 ? ' up' : ''}`}>
                            {delta > 0 ? `+${delta}` : delta} 完成
                          </span>
                        )
                      })()}
                      <span className="pd">{brief.byModel ? '副手撰写' : '本地统计'}</span>
                      <span className={`chev${openBrief === brief.id ? '' : ' closed'}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
                          <path d="M7 10l5 5 5-5" />
                        </svg>
                      </span>
                    </button>
                    {openBrief === brief.id && (
                      <div className="plan-b">
                        <div className="plan-body">
                          <MarkdownText text={brief.body} />
                        </div>
                        <div className="plan-foot">
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() =>
                              onAsk(
                                `围绕项目「${active.name}」，基于这份简报继续讨论下一步怎么推进：\n\n${brief.body.slice(0, 1200)}`
                              )
                            }
                          >
                            发到对话里讨论
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ marginLeft: 'auto', color: 'var(--red)' }}
                            onClick={() => void deleteBrief(brief.id)}
                          >
                            删除简报
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="cardbox">
                <div className="ch">常用指令</div>
                {active.prompts.length === 0 && (
                  <div className="row">
                    <div className="rl">
                      <span>这个项目常问的问题可以存成指令，点一下就发给长庚。</span>
                    </div>
                  </div>
                )}
                {active.prompts.map((prompt, index) => (
                  <div className="row" key={`${active.id}-${index}`}>
                    <div className="rl">
                      <b style={{ fontWeight: 400, fontSize: 12.6 }}>{prompt}</b>
                    </div>
                    <button className="mngbtn" onClick={() => onAsk(prompt)}>
                      发送
                    </button>
                    <button className="mngbtn" onClick={() => void removePrompt(index)}>
                      移除
                    </button>
                  </div>
                ))}
                <div className="row">
                  <input
                    className="input"
                    placeholder="添加一条常用指令，回车提交"
                    maxLength={300}
                    value={promptInput[active.id] ?? ''}
                    onChange={(e) => setPromptInput((prev) => ({ ...prev, [active.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addPrompt()
                    }}
                  />
                  <button className="btn btn-primary btn-sm" disabled={!promptInput[active.id]?.trim()} onClick={() => void addPrompt()}>
                    添加
                  </button>
                </div>
              </div>

              <div className="setfoot">
                <span>项目与方案只存在本机 projects.json / todos.json</span>
                <span>·</span>
                <span>不自动执行任何操作</span>
              </div>
              {status && <div className={`result-line ${status.ok ? 'ok' : 'bad'}`}>{status.text}</div>}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
