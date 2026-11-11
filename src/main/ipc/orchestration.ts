import { dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { listProjects, recheckProject } from '../orchestrator/view'
import { isInsideAnyRoot, normalizeRoot, ORCH_META } from '../orchestrator/roots'
import type { OrchestrationListView } from '../../shared/orchestration'
import type { IpcContext } from './app'

/**
 * 编排项目的只读接口。
 *
 * 只读是刻意的：这一页回答"现在到哪了、过没过"，不提供"改状态"的按钮。
 * 想改就回对话里重新派一次——那样每次改动都有一张授权卡和一条审计记录。
 *
 * 「能看哪些目录」是这一页的安全边界，见 orchestrator/roots.ts：应用自己的
 * 编排目录，加上用户亲手挑过的目录。别处一律拒绝。
 */
export function registerOrchestrationIpc(ctx: IpcContext): void {
  const appRoot = (): string => path.join(app.getPath('userData'), 'orchestrator')

  /** 允许扫描 / 定位的根：应用自己的 + 用户挑过的 */
  const allowedRoots = async (): Promise<string[]> => {
    const config = await ctx.store.getConfig()
    const extra = (config.orchestrationRoots ?? []).map(normalizeRoot).filter(Boolean)
    return [appRoot(), ...extra]
  }

  const listAll = async (): Promise<OrchestrationListView> => {
    const roots = await allowedRoots()
    return { projects: await listProjects(roots), roots, appRoot: appRoot() }
  }

  ipcMain.handle('orchestration:list', () => listAll())

  /**
   * 让用户自己挑一个项目目录打开。
   *
   * 用系统目录选择框而不是让渲染层传路径字符串：这不是「输入框少做一步」的事，
   * 而是把「哪个目录可以看」的决定权交回给用户本人。挑完才记进配置，页面据此
   * 放开扫描与定位。
   */
  ipcMain.handle('orchestration:pickRoot', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择编排项目目录（里面应有 .orchestrator 文件夹）',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false as const, canceled: true as const }

    const dir = normalizeRoot(picked.filePaths[0])
    // 挑错了目录要当场说，而不是记进配置之后让页面一直空着。
    // listProjects 同时认「本身是项目」和「下面是项目」，所以这里只问一次就够
    const found = await listProjects([dir])
    if (found.length === 0) {
      return {
        ok: false as const,
        canceled: false as const,
        reason: `这个目录里没有编排项目：没找到 ${ORCH_META}${path.sep}project.json，子目录里也没有。`
      }
    }

    const config = await ctx.store.getConfig()
    const existing = (config.orchestrationRoots ?? []).map(normalizeRoot)
    if (!existing.includes(dir)) {
      await ctx.store.saveConfig({ orchestrationRoots: [...existing, dir] })
    }
    return {
      ok: true as const,
      canceled: false as const,
      root: dir,
      projectCount: found.length,
      ...(await listAll())
    }
  })

  /** 从「打开的目录」里移除一个（只是不再扫它，磁盘上的东西一个字节都不动） */
  ipcMain.handle('orchestration:removeRoot', async (_e, dir: string) => {
    const target = normalizeRoot(String(dir ?? ''))
    // 应用自己的编排目录不是用户加的，也就不能移除
    if (target === normalizeRoot(appRoot())) {
      return { ok: false as const, reason: '这是应用自己的编排目录，不能移除', ...(await listAll()) }
    }
    const config = await ctx.store.getConfig()
    const next = (config.orchestrationRoots ?? []).map(normalizeRoot).filter((r) => r !== target)
    await ctx.store.saveConfig({ orchestrationRoots: next })
    return { ok: true as const, ...(await listAll()) }
  })

  ipcMain.handle('orchestration:recheck', async (_e, projectDir: string) => {
    const target = String(projectDir ?? '')
    const roots = await allowedRoots()
    // 界面传来的路径属于不可信输入：只认允许的根里的项目
    if (!isInsideAnyRoot(roots, target)) return []
    return recheckProject(normalizeRoot(target))
  })

  /** 在资源管理器里定位产出文件（界面上点文件名时用） */
  ipcMain.handle('orchestration:reveal', async (_e, filePath: string) => {
    const resolved = path.resolve(String(filePath ?? ''))
    const roots = await allowedRoots()
    if (!isInsideAnyRoot(roots, resolved)) {
      // 说清是哪一步不允许，而不是只说"失败了"
      throw new Error('只能定位允许的编排目录里的文件')
    }
    // 文件可能已经被移走：点一个不存在的路径不该静默返回成功
    try {
      await fs.access(resolved)
    } catch {
      return false
    }
    shell.showItemInFolder(resolved)
    return true
  })
}
