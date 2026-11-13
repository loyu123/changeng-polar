import path from 'node:path'
import {
  PROJECT_MAX_ENTRIES,
  PROJECT_NAME_MAX,
  PROJECT_NOTE_MAX,
  type ProjectEntry
} from '../../shared/types'

/**
 * 项目档案的校验与提示词生成。
 *
 * 这一层只做**纯函数**：磁盘、时钟、id 由调用方给。理由和 memory.ts 一样——
 * 「这个路径该不该收」是可以断言的事，掺进 fs 就没法在测试里精确地驱动。
 *
 * 边界（改之前先看）：
 * - **只收本机绝对路径**。UNC 一律拒：连共享目录是一次 SMB 登录，会把本机凭据
 *   交出去，而"看一眼项目"用不着付这个代价（和 open_folder / read_file 同一口径）
 * - **不做存在性检查**。档案是"用户说它在这"，不是"程序确认它在这"——
 *   项目可能在移动硬盘上、可能暂时没插。存下来，等真正要用的时候再查，
 *   查不到就如实说查不到（见 probeProject）
 * - **不猜项目**。程序不扫描磁盘去找"可能的项目"，猜错了会让模型去读一个
 *   不相干的目录，而用户看不出它为什么读那里
 */

export type ProjectInput = {
  name?: unknown
  root?: unknown
  logPath?: unknown
  note?: unknown
}

export type NormalizeResult =
  | { ok: true; value: { name: string; root: string; logPath?: string; note?: string } }
  | { ok: false; reason: string }

/**
 * 路径能不能收。
 *
 * `allowEmpty` 给 logPath 用——日志位置是可选的，不填就是没有。
 * 空字符串与"没填"等价，都在这里归一化掉，免得档案里出现一个 logPath: ""。
 */
export function validateProjectPath(raw: unknown, field: '根目录' | '日志位置', allowEmpty: boolean): { ok: true; value: string } | { ok: false; reason: string } {
  const text = String(raw ?? '').trim()
  if (!text) {
    if (allowEmpty) return { ok: true, value: '' }
    return { ok: false, reason: `请填${field}` }
  }
  // UNC：\\server\share 或 //server/share
  if (/^[\\/]{2}/.test(text)) {
    return {
      ok: false,
      reason: `「${text}」是网络路径，不接受。连共享目录会向对方提交本机登录凭据，而看一个项目用不着付这个代价。请填本机磁盘上的路径`
    }
  }
  if (!/^[a-zA-Z]:[\\/]/.test(text)) {
    return {
      ok: false,
      reason: `「${text}」不是本机绝对路径。要形如 D:\\工作\\我的项目`
    }
  }
  // 归一化：统一反斜杠、去掉末尾分隔符（D:\ 这种根目录除外）
  const resolved = path.resolve(text)
  const trimmed = resolved.length > 3 ? resolved.replace(/[\\/]+$/, '') : resolved
  return { ok: true, value: trimmed }
}

export function normalizeProject(raw: ProjectInput): NormalizeResult {
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, reason: '请给项目起个名字——之后你就是用这个名字叫它的' }
  if (name.length > PROJECT_NAME_MAX) {
    return { ok: false, reason: `项目名最多 ${PROJECT_NAME_MAX} 字（现在是 ${name.length} 字）` }
  }

  const root = validateProjectPath(raw.root, '根目录', false)
  if (!root.ok) return root

  const logPath = validateProjectPath(raw.logPath, '日志位置', true)
  if (!logPath.ok) return logPath

  const note = String(raw.note ?? '').replace(/\r\n/g, '\n').trim()
  if (note.length > PROJECT_NOTE_MAX) {
    return { ok: false, reason: `说明最多 ${PROJECT_NOTE_MAX} 字（现在是 ${note.length} 字）` }
  }

  return {
    ok: true,
    value: {
      name,
      root: root.value,
      ...(logPath.value ? { logPath: logPath.value } : {}),
      ...(note ? { note } : {})
    }
  }
}

/**
 * Windows 路径比较不区分大小写。用来判断"这条是不是同一个项目"。
 * 只比路径不比名字：同名不同路径是两个项目，同路径改名是一个项目。
 */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export type UpsertResult =
  | { ok: true; list: ProjectEntry[]; entry: ProjectEntry; replaced: boolean }
  | { ok: false; reason: string }

/**
 * 新增或更新一条。
 *
 * 判据是**根目录相同**，不是名字相同：用户把"报告"改叫"开题报告"是改名，
 * 不该变成两条——那会让模型拿到两个指向同一目录的档案，汇报时说两遍。
 */
export function upsertProject(
  list: ProjectEntry[],
  input: ProjectInput,
  ctx: { id: string; now: string }
): UpsertResult {
  const normalized = normalizeProject(input)
  if (!normalized.ok) return normalized

  const existing = list.find((p) => sameRoot(p.root, normalized.value.root))
  if (!existing && list.length >= PROJECT_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `档案里已经有 ${PROJECT_MAX_ENTRIES} 个项目了。先删掉做完的那些，或者把它们的说明并进另一条`
    }
  }

  const entry: ProjectEntry = existing
    ? { ...existing, ...normalized.value, updatedAt: ctx.now }
    : { id: ctx.id, ...normalized.value, createdAt: ctx.now, updatedAt: ctx.now }

  const next = existing
    ? list.map((p) => (p.id === existing.id ? entry : p))
    : [...list, entry]

  return { ok: true, list: next, entry, replaced: Boolean(existing) }
}

/**
 * 注入系统提示词的那一段。
 *
 * 和记忆那段的差别在于**这里要给出可操作的位置**，所以路径必须原样出现——
 * 用户问"报告进展"时，模型得能立刻去读那个目录，而不是先说"我不知道它在哪"。
 *
 * 同时要写清楚这是"用户声明的"，不是"程序验证过的"：项目可能已经挪走。
 * 不这么写，模型会把档案当事实汇报（"你的项目在 D:\x，共 8 个文件"），
 * 而它其实一个文件都没看过。
 */
export function projectsBlock(list: ProjectEntry[]): string {
  if (list.length === 0) return ''

  const lines: string[] = []
  for (const p of list) {
    /**
     * 盘上的数据是不可信形状：projects.json 这个位置曾经属于一个已删除的
     * 「项目/方案/待办」功能（它的 ProjectDef 有 name 没有 root）。
     * 档案虽然换了文件名，读回来的东西仍然可能是手改过的、半截的、或从
     * 别处拷来的——路径都拼不出来的条目就别往提示词里塞了。
     *
     * 塞进去的后果是模型看到「根目录 `undefined`」，然后要么去读一个叫
     * undefined 的路径，要么把这句原样复述给用户。两种都比少一条糟。
     */
    if (!p || typeof p.root !== 'string' || !p.root.trim()) continue
    lines.push(`- **${String(p.name ?? '(未命名)')}**：根目录 \`${p.root}\``)
    if (p.logPath && p.logPath.trim()) lines.push(`  - 进度日志：\`${p.logPath}\``)
    if (p.note && p.note.trim()) lines.push(`  - 说明：${p.note}`)
  }
  // 全都拼不出路径 = 这一段没有意义，宁可整段不出现
  if (lines.length === 0) return ''

  return [
    '## 用户登记的项目',
    '下面是用户亲手填的项目位置。用户提到这些名字时，指的就是这些目录。',
    '**这是用户声明的坐标，不是你已经核实过的事实**：目录可能已经挪走或还没插入。',
    '要汇报进展，先真的去读——列目录、读日志尾部、看关键文件。没读过就说"我去看一下"，',
    '不要凭这里的说明复述一遍当成现状。读不到就如实说读不到。',
    ...lines
  ].join('\n')
}

/**
 * 档案里的路径现在还在不在。
 *
 * 单独一个函数是为了让"查"和"用"分开：设置页要能告诉用户哪条失效了，
 * 而这个检查要碰磁盘，不能放进注入提示词的那条路径里（每轮都碰一次磁盘不合适）。
 */
export interface ProjectProbe {
  id: string
  rootExists: boolean
  /** 没登记日志位置时为 null */
  logExists: boolean | null
  error?: string
}
