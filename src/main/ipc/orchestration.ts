import { ipcMain } from 'electron'
import path from 'node:path'
import { app } from 'electron'
import { listProjects, recheckProject } from '../orchestrator/view'
import type { IpcContext } from './app'

/**
 * 编排项目的只读接口。
 *
 * 只读是刻意的：这一页回答"现在到哪了、过没过"，不提供"改状态"的按钮。
 * 想改就回对话里重新派一次——那样每次改动都有一张授权卡和一条审计记录。
 */
export function registerOrchestrationIpc(_ctx: IpcContext): void {
  const rootDir = (): string => path.join(app.getPath('userData'), 'orchestrator')

  ipcMain.handle('orchestration:list', () => listProjects(rootDir()))

  ipcMain.handle('orchestration:recheck', (_e, dirKey: string) => recheckProject(rootDir(), String(dirKey ?? '')))

  /** 用系统默认程序打开产出文件（界面上点文件名时用） */
  ipcMain.handle('orchestration:reveal', async (_e, filePath: string) => {
    const { shell } = await import('electron')
    const resolved = path.resolve(String(filePath ?? ''))
    // 只允许打开编排目录里的文件：界面传来的路径属于不可信输入
    if (!resolved.startsWith(path.resolve(rootDir()) + path.sep)) {
      throw new Error('只能打开编排目录里的文件')
    }
    shell.showItemInFolder(resolved)
    return true
  })
}
