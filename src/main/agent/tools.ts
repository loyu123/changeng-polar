import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AppNote, AppSnapshot, Evidence, MemoryEntry, SearchHit, VerifyResult } from '../../shared/types'
import { listInstalledApps, listStartupItems } from '../node/registry'
import { deleteToRecycle, listSandbox, SANDBOX_ROOT } from '../node/sandbox'
import { captureSnapshot } from '../node/snapshot'
import { listRecentMail, readMailBody } from '../node/mail'
import { installWinget, searchWinget, wingetAvailable, type WingetPackage } from '../node/install'
import { launchUninstaller, planUninstall } from '../node/uninstall'
import { fetchPage, searchWeb } from '../node/web'
import { MEMORY_MAX_TEXT, mergeMemory, removeMemory } from '../node/memory'
import type { ToolDef, ToolPlan, ToolResult } from './tool-types'

export interface ToolDeps {
  /** 打开系统设置页（由主进程注入，评测脚本里为空实现） */
  openSettings?: (page: string) => Promise<void>
  /** 查已查证的官网地址：注册表没登记下载来源时的兜底（重装入口） */
  officialSite?: (appName: string) => Promise<string | undefined>
  /** 卸载前的快照落盘（主进程注入 Store；评测脚本可不注入，只跳过存档） */
  saveSnapshot?: (snapshot: AppSnapshot) => Promise<void>
  /** 应用功能说明的手写备注（主进程注入 Store；没有就只报查证结果） */
  appNotes?: () => Promise<Record<string, AppNote>>
  /** 查证结果（含官网 sentence）：台账的另一半，与手写备注一起构成"功能说明" */
  appVerify?: () => Promise<Record<string, VerifyResult>>
  /** 跨会话记忆的读写（主进程注入 Store） */
  memory?: {
    list: () => Promise<MemoryEntry[]>
    save: (list: MemoryEntry[]) => Promise<void>
  }
}

function ev(partial: Omit<Evidence, 'id' | 'at'>): Evidence {
  return { id: `ev_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), ...partial }
}

/**
 * prompt 的能力段：由工具注册表生成，单一事实源。
 * 只列「能真正改动机器」的工具（destroy / install / write）；
 * 新增或删除这类工具时，模型的自述自动跟着变，不再手写第二份。
 */
export function capabilityBrief(tools: ToolDef[]): string {
  const mutating = tools.filter((t) => t.effect === 'destroy' || t.effect === 'install' || t.effect === 'write')
  if (mutating.length === 0) return '   （当前版本没有能改动机器的工具，一切真实文件都不动。）'
  return mutating
    .map((t) => {
      const first = t.description.split(/[。；]/)[0].replace(/\*\*/g, '')
      return `   - **${t.label}**（${t.name}）：${first.slice(0, 110)}。都必须用户点授权卡才会真正执行`
    })
    .join('\n')
}

const SETTINGS_PAGES: Record<string, string> = {
  apps: 'ms-settings:appsfeatures',
  startup: 'ms-settings:startupapps',
  privacy: 'ms-settings:privacy',
  storage: 'ms-settings:storagesense'
}

export function createTools(deps: ToolDeps = {}): ToolDef[] {
  const listApps: ToolDef = {
    name: 'list_installed_apps',
    label: '读取已安装程序清单',
    description:
      '读取本机已安装程序清单（来自注册表 Uninstall 键，只读）。可回答"装了什么、版本、发布者、装在哪"。用户给程序写过功能备注时，行里会带 note 字段——那是用户自己的记录，回答"这个程序是干什么的"时优先引用它；没有 note 就如实说没有登记说明。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按名称或发布者做包含匹配，留空返回全部' },
        include_system: { type: 'boolean', description: '是否包含系统组件，默认 false' },
        limit: { type: 'number', description: '最多返回多少条，默认 40' }
      }
    },
    describeTarget: (args) => {
      const query = String(args.query ?? '').trim()
      return {
        title: query ? `读取程序清单（筛选：${query}）` : '读取已安装程序清单',
        target: query || '全部已安装程序',
        impact: '只读注册表，不改动任何东西'
      }
    },
    run: async (args): Promise<ToolResult> => {
      const { apps, durationMs } = await listInstalledApps()
      // 手写备注并入结果行：模型答"这个程序是干什么的/能不能删"时才有台账依据
      let notes: Record<string, AppNote> = {}
      try {
        notes = (await deps.appNotes?.()) ?? {}
      } catch {
        notes = {}
      }
      let verifies: Record<string, { sentence: string; sourceUrl: string; status: string }> = {}
      try {
        verifies = (await deps.appVerify?.()) ?? {}
      } catch {
        verifies = {}
      }
      const query = String(args.query ?? '').trim().toLowerCase()
      const includeSystem = args.include_system === true
      const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 200)
      const filtered = apps.filter((a) => {
        if (!includeSystem && a.systemComponent === 1) return false
        if (!query) return true
        return a.name.toLowerCase().includes(query) || a.publisher.toLowerCase().includes(query)
      })
      return {
        ok: true,
        summary: `共 ${apps.length} 个程序，其中系统组件 ${apps.filter((a) => a.systemComponent === 1).length} 个；本次返回 ${Math.min(filtered.length, limit)} 条`,
        data: filtered.slice(0, limit).map((a) => ({
          name: a.name,
          version: a.version,
          publisher: a.publisher,
          installLocation: a.installLocation,
          sizeMB: a.sizeKB ? Math.round((a.sizeKB / 1024) * 10) / 10 : null,
          note: notes[a.name]?.text ?? null,
          description: verifies[a.name]?.status === 'verified' ? verifies[a.name].sentence : null,
          officialUrl: verifies[a.name]?.status === 'verified' ? verifies[a.name].sourceUrl : null
        })),
        evidence: [
          ev({
            type: 'local',
            title: `本机程序清单（${apps.length} 条）`,
            detail: `注册表 Uninstall 键 · 只读 · 耗时 ${durationMs || '<1'} ms`
          })
        ]
      }
    }
  }

  const listStartup: ToolDef = {
    name: 'list_startup_items',
    label: '读取开机启动项',
    description:
      '读取本机开机自启项（注册表 Run/RunOnce、启动文件夹、非微软计划任务，只读）。可回答"开机会自己起来什么"。返回不含"是否应当关闭"的判断。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'registry / startup-folder / scheduled-task，留空返回全部' },
        limit: { type: 'number', description: '最多返回多少条，默认 20（清单可能很长，超过部分需要分页）' },
        offset: { type: 'number', description: '从第几条开始，默认 0' }
      }
    },
    describeTarget: () => ({
      title: '读取开机启动项清单',
      target: '注册表 Run 键 + 启动文件夹 + 计划任务',
      impact: '只读，不改动任何启动项'
    }),
    run: async (args): Promise<ToolResult> => {
      const { items, durationMs } = await listStartupItems()
      const kind = String(args.kind ?? '').trim()
      const filtered = kind ? items.filter((i) => i.kind === kind) : items
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100)
      const offset = Math.max(Number(args.offset ?? 0), 0)
      const page = filtered.slice(offset, offset + limit)
      const group = (k: string) => items.filter((i) => i.kind === k).length
      return {
        ok: true,
        summary: `共 ${items.length} 个启动项（注册表 ${group('registry')} / 启动文件夹 ${group('startup-folder')} / 计划任务 ${group('scheduled-task')}）；本次返回第 ${offset + 1}–${offset + page.length} 条${offset + page.length < filtered.length ? '，还有更多可继续分页' : ''}`,
        data: page.map((i) => ({ name: i.name, command: i.command, source: i.source, kind: i.kind })),
        evidence: [
          ev({
            type: 'local',
            title: `本机启动项清单（${items.length} 条）`,
            detail: `注册表 Run 键 + 启动文件夹 + 计划任务 · 只读 · 耗时 ${durationMs || '<1'} ms`
          })
        ]
      }
    }
  }

  const webSearch: ToolDef = {
    name: 'web_search',
    label: '联网检索',
    description:
      '联网检索公开网页，返回标题、地址与摘要。凡是需要外部信息（软件是做什么的、有没有现成开源项目、某事实是否成立）都必须先调用它；不要用记忆里的知识代替检索。',
    effect: 'read',
    auditKind: 'web',
    // 检索词会发到本机之外：本轮读过邮件之后，这类调用要先让用户确认
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，可用 site: 限定站点' },
        max: { type: 'number', description: '返回条数，默认 5，最多 8' }
      },
      required: ['query']
    },
    describeTarget: (args) => ({
      title: `联网检索：${String(args.query ?? '').slice(0, 40)}`,
      target: String(args.query ?? ''),
      impact: '只读联网，不提交任何本机数据'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, summary: '检索词为空' }
      const max = Math.min(Math.max(Number(args.max ?? 5), 1), 8)
      const outcome = await searchWeb(query, ctx.config, ctx.signal)
      if (!outcome.ok) {
        return {
          ok: false,
          summary: `检索失败，没有拿到任何结果：${outcome.error ?? '无结果'}。此时应当向用户说明「查不到」，不要凭记忆补全。`
        }
      }
      const hits = outcome.hits.slice(0, max)
      return {
        ok: true,
        summary: `检索到 ${outcome.hits.length} 条结果（来源：${outcome.provider}）。摘要可能不完整，结论前建议对关键页面调用 web_fetch 核对。`,
        data: hits.map((h: SearchHit) => ({ title: h.title, url: h.url, snippet: h.snippet.slice(0, 260) })),
        evidence: hits.slice(0, 3).map((h) =>
          ev({
            type: 'web',
            title: h.title || h.url,
            url: h.url,
            detail: `检索命中 · ${outcome.provider} · 未读全文`
          })
        )
      }
    }
  }

  const webFetch: ToolDef = {
    name: 'web_fetch',
    label: '打开网页核对',
    description:
      '打开一个具体网页并提取正文（只读，最多 4000 字）。用于核对检索摘要、读官方文档原文。网页打不开或内容为空时，如实报告失败。',
    effect: 'read',
    auditKind: 'web',
    // URL 本身就是外发通道：把邮件原文拼进查询串就能带走，必须过确认
    sendsDataOut: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 http/https 地址' } },
      required: ['url']
    },
    describeTarget: (args) => ({
      title: `打开网页：${String(args.url ?? '').slice(0, 60)}`,
      target: String(args.url ?? ''),
      impact: '只读抓取正文'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, summary: '地址无效，只支持 http/https' }
      try {
        const page = await fetchPage(url, ctx.signal)
        return {
          ok: true,
          summary: `已读取 ${new URL(page.finalUrl).host} 的正文 ${page.text.length} 字（标题：${page.title}）`,
          data: { title: page.title, url: page.finalUrl, text: page.text },
          evidence: [
            ev({
              type: 'web',
              title: page.title,
              url: page.finalUrl,
              detail: `已读取正文 · ${page.text.length} 字`
            })
          ]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, summary: `网页打不开：${message}。不要猜测页面内容。` }
      }
    }
  }

  const openSettings: ToolDef = {
    name: 'open_settings_page',
    label: '打开系统设置页',
    description:
      '在系统里打开一个设置页面，让用户自己点开关（apps=已安装应用 / startup=启动应用 / privacy=隐私 / storage=存储）。这是"只打开页面、不替你改设置"的做法。',
    effect: 'ui',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'apps / startup / privacy / storage' },
        reason: { type: 'string', description: '为什么打开这个页面，一句话' }
      },
      required: ['page']
    },
    describeTarget: (args) => ({
      title: `打开「设置 → ${String(args.page ?? '')}」`,
      target: String(args.page ?? ''),
      impact: '只打开页面，不改任何设置'
    }),
    run: async (args): Promise<ToolResult> => {
      const key = String(args.page ?? '').toLowerCase()
      const target = SETTINGS_PAGES[key]
      if (!target) return { ok: false, summary: `未知设置页：${key}` }
      const reason = String(args.reason ?? '').slice(0, 80)
      if (!deps.openSettings) return { ok: false, summary: '当前环境不能打开系统设置页' }
      await deps.openSettings(target)
      return {
        ok: true,
        summary: `已打开系统设置页（${key}）。管家没有改动任何设置。`
      }
    }
  }

  // ---- 授权闸门演练用的沙箱工具（作用域写死在 %TEMP%\butler-sandbox） ----

  const listSandboxTool: ToolDef = {
    name: 'list_sandbox_files',
    label: '查看演示沙箱',
    description:
      '列出演示沙箱目录里的文件（只读）。沙箱是给"删除能力"做演示用的隔离目录，路径固定在系统临时目录下。',
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    describeTarget: () => ({
      title: '查看演示沙箱文件',
      target: SANDBOX_ROOT,
      impact: '只读列目录'
    }),
    run: async (): Promise<ToolResult> => {
      const files = await listSandbox()
      return {
        ok: true,
        summary: `演示沙箱里有 ${files.length} 个文件（${SANDBOX_ROOT}）`,
        data: files.map((f) => ({ name: f.name, path: f.path, sizeKB: f.sizeKB })),
        evidence: [
          ev({ type: 'local', title: `演示沙箱清单（${files.length} 个文件）`, detail: SANDBOX_ROOT })
        ]
      }
    }
  }

  const deleteToRecycleTool: ToolDef = {
    name: 'delete_to_recycle',
    label: '删除到回收站（需授权）',
    description:
      '把**演示沙箱**里的一个文件移到系统回收站（可还原）。这是销毁类操作，必须先经用户授权，授权卡没点通过就不会执行；沙箱外的路径一律拒绝。用户没有明确同意前不要调用。',
    effect: 'destroy',
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱内文件的完整路径（先用 list_sandbox_files 查）' },
        reason: { type: 'string', description: '为什么要删，一句话' }
      },
      required: ['path']
    },
    describeTarget: (args) => {
      const name = path.basename(String(args.path ?? '(未指定)'))
      return {
        title: `删除到回收站：${name}`,
        target: String(args.path ?? ''),
        impact: '从演示沙箱移到系统回收站；可以从回收站还原，但不会留在原处',
        undoHint: '回收站还原'
      }
    },
    run: async (args): Promise<ToolResult> => {
      const target = String(args.path ?? '').trim()
      if (!target) return { ok: false, summary: '没有给出要删除的文件路径' }
      try {
        const outcome = await deleteToRecycle(target)
        if (!outcome.ok) {
          return { ok: false, summary: `删除没有生效：${outcome.error ?? '原因未知'}，文件应该还在原处` }
        }
        return {
          ok: true,
          summary: `已把「${outcome.name}」（${outcome.sizeKB} KB）移入系统回收站，可以从回收站还原`,
          undo: '回收站还原',
          data: { name: outcome.name, sizeKB: outcome.sizeKB, recycled: true },
          evidence: [
            ev({
              type: 'local',
              title: `删除到回收站：${outcome.name}`,
              detail: `${outcome.sizeKB} KB · 用户授权后执行 · 可还原`
            })
          ]
        }
      } catch (err) {
        return {
          ok: false,
          summary: `没有执行：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  }

  const readEmailTool: ToolDef = {
    name: 'read_email',
    label: '读取邮件（只读）',
    description:
      '读取用户邮箱：mode=list 拉最近的邮件列表（谁发的、主题、时间、200 字摘要、是否已读、来自哪个账号）；mode=read 用列表返回的 uid 拉单封正文。IMAP 只读——不标记已读、不删信、不发信。支持多个邮箱账号（设置里配置）：account 参数传账号显示名或地址，不传用默认账号；列表返回里有 account 字段标明来源，回答多账号问题时必须区分。涉及"谁发来的 / 要不要紧 / 邮件说了什么"的问题用它；没配置邮箱时如实说去设置里配。',
    effect: 'read',
    // 邮件正文是用户私密内容：读过之后本轮就算被污染，后续外发一律要确认
    readsPrivateData: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'list=最近邮件列表（默认）；read=读单封正文' },
        uid: { type: 'number', description: 'mode=read 时必填，来自列表返回的 uid' },
        limit: { type: 'number', description: 'mode=list 时返回几封，默认 10，最多 30' },
        account: { type: 'string', description: '邮箱账号（显示名或地址），不传用默认账号' }
      }
    },
    describeTarget: (args) => ({
      title: String(args?.mode ?? 'list') === 'read' ? `读取邮件正文（uid ${args?.uid ?? '?'}）` : '读取最近邮件列表',
      target: args?.account ? `收件箱（IMAP 只读 · 账号 ${args.account}）` : '收件箱（IMAP 只读）',
      impact: '只读：不标记已读、不删除、不发信'
    }),
    run: async (args, ctx): Promise<ToolResult> => {
      const mode = String(args.mode ?? 'list')
      const accountRef = typeof args.account === 'string' && args.account.trim() ? args.account.trim() : undefined
      try {
        if (mode === 'read') {
          const uid = Number(args.uid)
          if (!Number.isFinite(uid) || uid <= 0) {
            return { ok: false, summary: 'mode=read 需要有效的 uid：先调 read_email(mode=list) 拿到再读单封' }
          }
          const mail = await readMailBody(ctx.config, uid, accountRef)
          return {
            ok: true,
            summary: `已读取「${mail.subject}」（来自 ${mail.from} · 账号 ${mail.account}，IMAP 只读）`,
            data: mail,
            evidence: [
              ev({
                type: 'local',
                title: `读取邮件：${mail.subject}`,
                detail: `IMAP 只读 · 来自 ${mail.fromAddress} · ${new Date(mail.date).toLocaleString('zh-CN')}`
              })
            ]
          }
        }
        const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 30)
        const mails = await listRecentMail(ctx.config, limit, accountRef)
        if (mails.length === 0) return { ok: true, summary: '收件箱是空的（或最近没有邮件）', data: [] }
        const accountNames = [...new Set(mails.map((m) => m.account))]
        return {
          ok: true,
          summary: `读取了最近 ${mails.length} 封邮件（账号 ${accountNames.join('、')}，IMAP 只读）`,
          data: mails,
          evidence: [
            ev({
              type: 'local',
              title: '读取邮件列表',
              detail: `IMAP 只读 · 账号 ${accountNames.join('、')} · 最近 ${mails.length} 封 · 未读 ${
                mails.filter((m) => !m.seen).length
              } 封`
            })
          ]
        }
      } catch (err) {
        return { ok: false, summary: `读取邮件失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }

  const installAppTool: ToolDef = {
    name: 'install_app',
    label: '安装软件（需授权）',
    description:
      '通过 winget（Windows 官方包管理器）安装一个软件：先在 winget 仓库检索，唯一匹配才出授权卡，静默安装。来源与哈希校验由 winget 负责，不在桌面留安装包；安装不可撤回，装完可在「设置 → 应用」卸载。授权卡上用户可以点「始终允许」：只对同一个包的同一版本生效（换个包/换版本仍要重新授权），并可在「设置 → 授权记忆」里撤销。用户没有明确同意前不要调用；winget 里没有或有多条匹配时会拒绝，此时如实转述。',
    effect: 'install',
    // 全注册表唯一开「始终允许」的档位：安装是系统改动但非销毁，key 含包名+版本，
    // 换目标即失效；删除/卸载（销毁类）永远逐次弹卡，不允许记忆
    allowAlways: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '软件名，尽量用官方名称；winget 里的 Id 也接受' },
        reason: { type: 'string', description: '为什么要装，一句话' }
      },
      required: ['name']
    },
    plan: async (args, ctx): Promise<ToolPlan> => {
      const name = String(args.name ?? '').trim()
      if (!name) return { ok: false, reason: '没有给出要安装的软件名' }
      if (!(await wingetAvailable(ctx.signal))) {
        return { ok: false, reason: '这台机器上没有可用的 winget，只能由用户自己去官网下载安装' }
      }
      let candidates: WingetPackage[]
      try {
        candidates = await searchWinget(name, ctx.signal)
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      if (candidates.length === 0) {
        return { ok: false, reason: `winget 仓库里没有找到「${name}」。让它去官网下载安装包自己装，或确认名称后重试` }
      }
      const exact = candidates.find((p) => p.id.toLowerCase() === name.toLowerCase())
      const chosen = exact ?? null
      if (!chosen) {
        const list = candidates
          .slice(0, 5)
          .map((p) => `${p.name}（Id: ${p.id} · ${p.version}）`)
          .join('；')
        return {
          ok: false,
          reason: `winget 里有多条匹配，不能猜：${list}。让用户确认要哪个（报 Id），或用更精确的名称重试`
        }
      }
      return {
        ok: true,
        target: {
          title: `安装：${chosen.name}`,
          target: `${chosen.id} ${chosen.version} · 来源 winget 官方仓库`,
          impact: `通过 winget 静默安装到系统（${chosen.id}）；来源与哈希校验由 winget 负责，不在桌面留安装包`,
          undoHint: '安装不可撤回；装完可在「设置 → 应用」里卸载',
          reinstallHint: `安装源：winget（Id: ${chosen.id}）`
        },
        execute: async (): Promise<ToolResult> => {
          const outcome = await installWinget(chosen.id, ctx.signal)
          if (!outcome.ok) {
            return { ok: false, summary: `没能安装「${chosen.name}」：${outcome.detail}` }
          }
          return {
            ok: true,
            summary: `已通过 winget 静默安装「${chosen.name}」（${chosen.id}）。可以用 list_installed_apps 确认，或去「设置 → 应用」查看`,
            undo: '安装不可撤回（卸载可再找管家）',
            sourceUrl: outcome.sourceUrl,
            data: { id: chosen.id, version: chosen.version, source: 'winget', sourceUrl: outcome.sourceUrl },
            evidence: [
              ev({
                type: 'local',
                title: `安装：${chosen.name}`,
                detail: `winget 静默安装 · Id ${chosen.id} · 用户授权后执行${outcome.sourceUrl ? ` · 安装包来源 ${outcome.sourceUrl}` : ''}`
              })
            ]
          }
        }
      }
    },
    run: async (): Promise<ToolResult> => {
      return { ok: false, summary: 'install_app 必须先解析出唯一目标（plan），直接 run 不会被放行' }
    }
  }

  const uninstallAppTool: ToolDef = {
    name: 'uninstall_app',
    label: '卸载程序（需授权）',
    description:
      '卸载一个**已安装的程序**：校验注册表里的卸载入口，然后启动该程序自己的卸载程序，由用户在窗口里确认完成。这是销毁类操作，必须过授权卡；不做静默卸载、不删安装目录、不碰它没登记的文件。名字必须与「已安装程序」里的名称完全一致；同名多条或没有卸载入口时会拒绝执行。用户没有明确同意前不要调用。',
    effect: 'destroy',
    allowAlways: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '程序名，必须与 list_installed_apps 返回的 name 完全一致' },
        reason: { type: 'string', description: '为什么要卸载，一句话' }
      },
      required: ['name']
    },
    plan: async (args) => {
      const requested = String(args.name ?? '').trim()
      const planned = await planUninstall(requested)
      if (!planned.ok) return planned

      const { entry, command } = planned
      const exeName = path.basename(command.exe)

      // 快照在 plan 阶段抓一次：卡片上的"会动掉多少东西"和 execute 落盘的
      // 是同一份（K7 同源）。抓失败不拦流程——快照是加分项，不是闸门
      let snapshot: AppSnapshot | null = null
      try {
        const { items } = await listStartupItems()
        snapshot = await captureSnapshot(entry.name, { entry, startupItems: items })
      } catch {
        snapshot = null
      }
      const snapshotText = snapshot
        ? `快照已记下：安装目录${snapshot.summary.files > 0 ? `约 ${snapshot.summary.sizeMB} MB / ${snapshot.summary.files} 个文件` : '为空或不可读'}${
            snapshot.summary.startupCount > 0 ? `，${snapshot.summary.startupCount} 个关联自启项` : ''
          }`
        : ''
      const registrySource = entry.installSource.trim() || entry.urlInfoAbout.trim()
      // 注册表没登记下载来源时，用「应用」页已经查证过的官网兜底；两处都没有就如实说没有
      const verifiedSite = registrySource ? '' : ((await deps.officialSite?.(entry.name)) ?? '')
      const source = registrySource || verifiedSite
      const sourceLabel = registrySource ? '注册表登记' : verifiedSite ? '官网（已查证）' : ''
      const reinstallHint = source
        ? `下载/官网：${source}（${sourceLabel}）`
        : '注册表没有记录下载来源，重装只能自己找官网'
      const scopeText = entry.scope === 'machine' ? '本机安装' : '仅为当前用户安装'

      return {
        ok: true,
        target: {
          title: `卸载：${entry.name}`,
          target: `${entry.name}${entry.version ? ` ${entry.version}` : ''}｜${scopeText} · ${entry.arch} 位 · 注册表项 ${entry.key}`,
          impact: `会启动它自己的卸载程序（${exeName}${
            command.args.length ? ` ${command.args.join(' ')}` : ''
          }）；程序文件与注册表项由那个窗口删除，不可撤回${snapshotText ? `。${snapshotText}` : ''}`,
          undoHint: '不可撤回（要回来只能重装）',
          reinstallHint
        },
        execute: async (): Promise<ToolResult> => {
          const launched = launchUninstaller(command.exe, command.args)
          if (!launched.ok) {
            return {
              ok: false,
              summary: `没能启动「${entry.name}」的卸载程序：${launched.detail ?? '原因未知'}，程序应该还在`
            }
          }
          // 卸载程序已拉起才落盘快照：被拒绝或启动失败时只抓不存，不留垃圾
          if (snapshot) {
            try {
              await deps.saveSnapshot?.(snapshot)
            } catch {
              /* 落盘失败不影响卸载本身，只是"卸完少了什么"这张卡没了 */
            }
          }
          return {
            ok: true,
            summary: `已启动「${entry.name}」自己的卸载程序（${exeName}）。卸载要等那个窗口里的确认，我无法确认你有没有点完；点完后回「记录」页点「卸载对比」，或直接问我「卸干净了没」。重装入口：${reinstallHint}`,
            undo: '不可撤回',
            snapshotId: snapshot?.id,
            data: {
              name: entry.name,
              version: entry.version,
              publisher: entry.publisher,
              exe: command.exe,
              args: command.args,
              registryKey: entry.key,
              reinstallHint,
              snapshotId: snapshot?.id
            },
            evidence: [
              ev({
                type: 'local',
                title: `卸载：${entry.name}`,
                detail: `注册表卸载入口 ${entry.key} · 用户授权后启动 · 安装来源：${source || '未登记'}${
                  snapshotText ? ` · ${snapshotText}` : ''
                }`
              })
            ]
          }
        }
      }
    },
    // plan 提供了执行体；run 不会被调用，仅用于满足类型
    run: async (): Promise<ToolResult> => ({ ok: false, summary: '这个工具必须先解析目标，直接执行被拒绝' })
  }

  // ---- 跨会话记忆 ----

  const memoryTools: ToolDef[] = [
    {
      name: 'save_memory',
      label: '记住一件事（需确认）',
      description:
        '把一件"以后还用得上"的事记下来，下次对话还能想起来。适合：用户让你记住的偏好和习惯、正在做的项目与进度、约定的规则。不适合：一次性的问答内容、从工具读到的会变的事实（装了什么、有什么文件）、你自己的推测。同一件事重复保存只会刷新时间，不会重复记录。',
      effect: 'write',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: `记忆类型：user=关于用户本人 / preference=偏好与习惯 / project=正在做的事 / fact=约定与规则。默认 fact`
          },
          text: { type: 'string', description: `一句话，最长 ${MEMORY_MAX_TEXT} 字` }
        },
        required: ['text']
      },
      describeTarget: (args) => ({
        title: '记住一件事',
        target: String(args.text ?? '').slice(0, 80),
        impact: '只在本地记一条笔记，不改动系统；可在设置里删除',
        undoHint: '设置 → 记忆'
      }),
      // write 档会先备份：这里存的是整个记忆列表的快照，撤销时据此还原
      backup: async () => {
        if (!deps.memory) return { ok: false, detail: '当前环境不能保存记忆' }
        try {
          const list = await deps.memory.list()
          return { ok: true, undo: `备份了 ${list.length} 条记忆` }
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) }
        }
      },
      run: async (args): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境不能保存记忆' }
        const list = await deps.memory.list()
        const outcome = mergeMemory(list, { kind: args.kind, text: args.text })
        if (!outcome.ok) return { ok: false, summary: `没有保存：${outcome.reason}` }
        await deps.memory.save(outcome.list)
        return {
          ok: true,
          summary: outcome.replaced
            ? `这条之前记过，已刷新时间：「${outcome.entry.text}」`
            : `已记住：「${outcome.entry.text}」（以后对话可以用上，可在设置里删除）`,
          undo: '设置 → 记忆',
          data: { id: outcome.entry.id, kind: outcome.entry.kind, text: outcome.entry.text },
          evidence: [
            ev({
              type: 'local',
              title: `记忆已更新（共 ${outcome.list.length} 条）`,
              detail: '本地 memory.json · 只存在这台机器上'
            })
          ]
        }
      }
    },
    {
      name: 'forget_memory',
      label: '忘掉一条记忆（需确认）',
      description:
        '删掉一条之前记下的内容。用户说"忘记这个""记错了""删掉那条记忆"时用它。参数可以是记忆的 id，也可以直接给原文（会按内容匹配）。删之前建议先 list_memory 核对是哪一条。',
      effect: 'write',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '记忆的 id，或要删除的那句话' }
        },
        required: ['ref']
      },
      describeTarget: (args) => ({
        title: '忘掉一条记忆',
        target: String(args.ref ?? '').slice(0, 80),
        impact: '从本地记忆里删掉这条；其他数据不受影响',
        undoHint: '设置 → 记忆（删除前有备份，可重新添加）'
      }),
      backup: async () => {
        if (!deps.memory) return { ok: false, detail: '当前环境不能修改记忆' }
        try {
          const list = await deps.memory.list()
          return { ok: true, undo: `备份了 ${list.length} 条记忆` }
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message : String(err) }
        }
      },
      run: async (args): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境不能修改记忆' }
        const list = await deps.memory.list()
        const { list: next, removed } = removeMemory(list, String(args.ref ?? ''))
        if (!removed) return { ok: false, summary: `没有找到要删除的记忆：${String(args.ref ?? '').slice(0, 60)}` }
        await deps.memory.save(next)
        return {
          ok: true,
          summary: `已删掉：「${removed.text}」`,
          undo: '设置 → 记忆',
          data: { removed: removed.text, remaining: next.length }
        }
      }
    },
    {
      name: 'list_memory',
      label: '看看自己记得什么',
      description:
        '列出之前记下的所有内容（只读）。用户问"你记得我什么""你记住了哪些东西"，或者删除前需要核对是哪一条时用它。',
      effect: 'read',
      parameters: { type: 'object', properties: {} },
      describeTarget: () => ({
        title: '读取记忆清单',
        target: '本地 memory.json',
        impact: '只读，不改动任何东西'
      }),
      run: async (): Promise<ToolResult> => {
        if (!deps.memory) return { ok: false, summary: '当前环境没有记忆存储' }
        const list = await deps.memory.list()
        if (list.length === 0) return { ok: true, summary: '还没有记下任何东西', data: [] }
        return {
          ok: true,
          summary: `共 ${list.length} 条记忆`,
          data: list.map((item) => ({ id: item.id, kind: item.kind, text: item.text, updatedAt: item.updatedAt })),
          evidence: [
            ev({ type: 'local', title: `本地记忆清单（${list.length} 条）`, detail: 'memory.json · 只读' })
          ]
        }
      }
    }
  ]

  return [
    listApps,
    listStartup,
    webSearch,
    webFetch,
    openSettings,
    listSandboxTool,
    deleteToRecycleTool,
    readEmailTool,
    installAppTool,
    uninstallAppTool,
    ...memoryTools
  ]
}
