import path from 'node:path'

/**
 * 编排页「能看哪些目录」的边界。
 *
 * 这一页拿到的是**渲染层传来的路径**：核对验收、在资源管理器里定位产出文件，
 * 都要拿它去读磁盘、去指挥系统。而渲染层的东西一律按不可信输入对待——
 * 「传个任意路径就能让资源管理器定位它」等于把本机文件系统交给对方点名。
 *
 * 所以只认两类根：
 * 1. 应用自己的编排目录（`userData/orchestrator`），写死在代码里
 * 2. 用户亲手在系统目录选择框里挑过的目录，记在 config.orchestrationRoots
 *
 * 第 2 类是「用户自己说过这条路可以」——不是模型说的，也不是页面上拼出来的。
 * 除此之外一律拒绝，包括看起来很像的兄弟目录。
 */

export const ORCH_META = '.orchestrator'

/** target 是否在 root 之内（root 自身也算在内） */
export function isInsideRoot(root: string, target: string): boolean {
  const base = path.resolve(String(root ?? ''))
  const abs = path.resolve(String(target ?? ''))
  if (!base || !abs) return false
  const rel = path.relative(base, abs)
  if (rel === '') return true
  // 用 path.relative 而不是 startsWith：`C:\编排2` 与 `C:\编排` 前缀相同却不是一个目录
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** target 是否落在任一允许的根里 */
export function isInsideAnyRoot(roots: string[], target: string): boolean {
  return roots.some((root) => isInsideRoot(root, target))
}

/**
 * 把用户挑的目录规整成一个「扫描根」。
 *
 * 挑的是项目目录本身时，扫描根要退到它的上一层吗？**不退**：
 * 退上去会把兄弟目录也一并放开，而用户只点了这一个。上层目录那种选法
 * 由 listProjects 自己认（它会把根本身和子目录都看一遍）。
 */
export function normalizeRoot(dir: string): string {
  return path.resolve(String(dir ?? ''))
}
