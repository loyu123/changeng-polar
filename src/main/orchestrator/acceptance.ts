import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AcceptanceCheck, OrchestrationProject, OrchestrationTask, WorkerRunRecord } from './types'

/**
 * 确定性验收：只查文件系统。
 *
 * 一条都不满足就算不通过。这里刻意**不调用模型**——把"做完了吗"交给模型判断，
 * 等于让写报告的那位自己给自己打分。
 */
export interface CheckResult {
  check: AcceptanceCheck
  passed: boolean
  detail: string
}

export interface AcceptanceResult {
  passed: boolean
  results: CheckResult[]
}

export async function runAcceptance(checks: AcceptanceCheck[], workDir: string): Promise<AcceptanceResult> {
  const results: CheckResult[] = []
  for (const check of checks) {
    results.push(await runOne(check, workDir))
  }
  return { passed: results.every((r) => r.passed), results }
}

async function runOne(check: AcceptanceCheck, workDir: string): Promise<CheckResult> {
  // 只允许项目工作目录内的相对路径：验收脚本不该成为越过隔离边界的后门
  const target = path.resolve(workDir, check.path)
  const root = path.resolve(workDir)
  const inside = target === root || target.startsWith(root + path.sep)
  if (!inside) {
    return { check, passed: false, detail: `路径越界：${check.path} 不在工作目录内` }
  }

  if (check.kind === 'file-exists') {
    const ok = await exists(target)
    return { check, passed: ok, detail: ok ? `${check.path} 存在` : `${check.path} 不存在` }
  }

  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { check, passed: false, detail: `${check.path} 不存在` }
  }
  if (!stat.isFile()) return { check, passed: false, detail: `${check.path} 不是文件` }

  if (check.kind === 'min-bytes') {
    const ok = stat.size >= check.bytes
    return {
      check,
      passed: ok,
      detail: `${check.path} ${stat.size} 字节${ok ? '≥' : '<'} ${check.bytes}`
    }
  }

  const text = await fs.readFile(target, 'utf8')
  if (check.kind === 'contains') {
    const ok = text.includes(check.text)
    return { check, passed: ok, detail: ok ? `含「${check.text}」` : `不含「${check.text}」` }
  }
  const ok = !text.includes(check.text)
  return { check, passed: ok, detail: ok ? `不含「${check.text}」` : `意外含「${check.text}」` }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** 任务的输出文件路径（绝对）。工作体的原文回答落这里，不进 jsonl */
export function outputPath(rootDir: string, task: OrchestrationTask): string {
  return path.join(taskWorkDir(rootDir, task), 'output.txt')
}

export function taskWorkDir(rootDir: string, task: OrchestrationTask): string {
  return path.resolve(rootDir, task.workDir ?? path.join('tasks', task.id))
}

/**
 * 派发记录的位置：`<项目根>/.orchestrator/runs.jsonl`。
 *
 * 一个项目根下只有一个项目，所以不再按 id 分一层——分了之后界面读不到
 * （view.ts 读的是 `.orchestrator/runs.jsonl`），"派发了几次"就永远显示 0。
 */
export function runsPath(rootDir: string): string {
  return path.join(rootDir, '.orchestrator', 'runs.jsonl')
}
