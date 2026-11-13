import { statSync } from 'node:fs'
import type { ProjectEntry } from '../../shared/types'
import type { ProjectProbe } from './projects'

/**
 * 「这个路径现在还在不在」。
 *
 * 抽成唯一一处是因为有两个地方要问：档案列表（保存后逐条显示红的/绿的）
 * 和填表时的「再查一下」按钮。各写一遍很容易变成两套判据——一处把权限不足
 * 当成"不存在"，一处不当，用户会看到两个互相矛盾的结论。
 */
export function existsNow(p: string): boolean {
  const text = String(p ?? '').trim()
  if (!text) return false
  try {
    statSync(text)
    return true
  } catch {
    return false
  }
}

/**
 * 档案里的各个路径现在还在不在。
 *
 * 为什么值得单列一个函数：档案存的是**用户声明的坐标**，项目可能挪走了、
 * 可能在没插的移动硬盘上。设置页要能一眼看出哪条失效了，而不是等模型读失败
 * 再让用户去猜。但它**不进提示词**——那里每轮都跑，碰磁盘不合适，而且
 * 把"某某目录不存在"写进提示词会让模型把一次移动硬盘没插当成项目取消了。
 */
export function probeProject(entry: ProjectEntry): ProjectProbe {
  return {
    id: entry.id,
    // 盘上的形状不可信（见 projectsBlock 的注释）：root 可能缺失或不是字符串，
    // 那样 existsNow 会拿到 undefined——归一成空串就是"找不到"，不是崩溃
    rootExists: existsNow(String(entry.root ?? '')),
    logExists: entry.logPath ? existsNow(String(entry.logPath)) : null
  }
}
