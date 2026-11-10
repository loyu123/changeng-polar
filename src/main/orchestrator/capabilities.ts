import type { WorkerBackendKind } from './backends/types'

/**
 * 工具名的跨后端映射。
 *
 * 为什么要这一层：四家的工具名叫法完全不同，而任务是**与后端无关**的——
 * 用户写"能读能写"，不该关心派给 claude 时叫 `Read` 还是派给 pi 时叫 `read`。
 * 不映射的话，同一份计划换个后端就会"工具全被禁用"，而且不报错，
 * 表现为"模型说什么都做不了"——这种静默失败最难查。
 *
 * 用**能力词**做中间层：read / write / edit / bash。
 * 这是长庚自己的词汇，映射到各家时再翻译成它们认的名字。
 */

/** 长庚内部的能力词 */
export type ToolCapability = 'read' | 'write' | 'edit' | 'bash'

export const ALL_CAPABILITIES: ToolCapability[] = ['read', 'write', 'edit', 'bash']

/**
 * 能力词 → 各家工具名。
 *
 * 只收实测确认能用的。没确认的一律不写——写错了会变成
 * "传了个不存在的工具名，一个工具都用不了"，比不传还糟。
 */
const NATIVE_NAMES: Record<WorkerBackendKind, Partial<Record<ToolCapability, string[]>>> = {
  pi: {
    read: ['read'],
    write: ['write'],
    edit: ['edit'],
    bash: ['bash']
  },
  // 实测 pi 之外的三家都用首字母大写的工具名（claude 已验：Read/Write 可用，
  // 小写会一个工具都用不了）
  claude: {
    read: ['Read'],
    write: ['Write'],
    edit: ['Edit'],
    bash: ['Bash']
  },
  codebuddy: {
    read: ['Read'],
    write: ['Write'],
    edit: ['Edit'],
    bash: ['Bash']
  },
  codex: {
    // codex 不用工具名白名单：它靠 -s 沙箱档位控制能写不能写，
    // 所以这里的映射只用来判断"要不要开 workspace-write"
    read: ['read'],
    write: ['write'],
    edit: ['edit'],
    bash: ['bash']
  }
}

/** 把长庚的能力词转成某个后端认的工具名。认不出的能力词直接丢掉 */
export function nativeTools(backend: WorkerBackendKind, caps: string[]): string[] {
  const map = NATIVE_NAMES[backend] ?? {}
  const out: string[] = []
  for (const raw of caps) {
    const cap = normalizeCapability(raw)
    if (!cap) continue
    for (const name of map[cap] ?? []) {
      if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

/**
 * 把各种写法归一到能力词。
 *
 * 要宽容：用户/模型可能写 `read`、`Read`、`ReadFile`、`filesystem.read`、
 * `write_file`。认不出就返回 null（丢掉），**不猜**——猜错会变成
 * "给了一个不存在的工具名，结果一个工具都用不了"。
 */
export function normalizeCapability(raw: string): ToolCapability | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  // 去掉命名空间前缀和常见分隔符：filesystem.read / write_file / WriteFile
  const tail = s.includes('.') ? s.slice(s.lastIndexOf('.') + 1) : s
  if (/^(read|readfile|read_file|fileread|cat|view)$/.test(tail)) return 'read'
  if (/^(write|writefile|write_file|filewrite|create)$/.test(tail)) return 'write'
  if (/^(edit|editfile|edit_file|replace|patch|apply_patch)$/.test(tail)) return 'edit'
  if (/^(bash|shell|exec|run|command|terminal)$/.test(tail)) return 'bash'
  return null
}

/**
 * 某个后端配了这个能力词，等于"允许它干这类事"。
 * 只读任务给 ['read']，要出报告给 ['read','write']。
 */
export function describeCapabilities(caps: string[]): string {
  const norm = [...new Set(caps.map(normalizeCapability).filter(Boolean))] as ToolCapability[]
  if (norm.length === 0) return '不给任何工具'
  return norm.map((c) => ({ read: '读', write: '写', edit: '改', bash: '执行命令' })[c]).join('、')
}
