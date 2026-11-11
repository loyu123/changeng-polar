import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { createTools } from '../src/main/agent/tools'
import { executeThroughGate, rememberKey, type GateHooks } from '../src/main/agent/gate'
import type { ToolContext, ToolDef } from '../src/main/agent/tool-types'
import { DEFAULT_CONFIG, Store } from '../src/main/node/store'
import { prepareSandbox, SANDBOX_ROOT } from '../src/main/node/sandbox'
import { isInsideOutput } from '../src/main/node/document'
import { listInstalledApps } from '../src/main/node/registry'
import { planUninstall } from '../src/main/node/uninstall'
import { findOpenWindow, normalizeAppName } from '../src/main/node/running'
import { isLaunchableShortcut, isLaunchableUrl } from '../src/main/node/launch'
import { listFolderCandidates, matchFolder, planFolder, resetFolderCache, scanFolderIndex, setFolderDesktopRoots, setFolderIndexRoots } from '../src/main/node/folder'
import { resetFileIndex, scanFileIndex, setFileIndexRoots } from '../src/main/node/file'
import type { AuthAnswer, RecordEntry } from '../src/shared/types'

/**
 * 授权闸门的离线验收（不接模型）。
 *
 * 验的是「闸门本身」而不是模型话术：
 *   1. 拒绝 → 什么都不执行、文件还在、留痕为 rejected
 *   2. 沙箱外路径 → 代码层拒绝，与用户是否点通过无关
 *   3. 允许一次 → 真的执行，留痕带 authz=user_once 与 undo
 *   4. 销毁类（delete 工具）不允许「始终允许」
 *   5. 演练模式 → 判定照走、不真执行
 *   6. 只读工具 → 不弹卡、留痕 auto
 *   7. 畸形/缺省授权答案 → 按拒绝（fail-closed）
 *   8. 记忆不能越过 allowAlways：销毁类即便被记忆也必须弹卡
 *   9. write 备份失败 → 不执行
 *  10. destroy 备份失败 → 用户批准了也不执行
 *  11. destroy 备份成功 → 留痕带备份句柄
 *  12. 未声明的 effect → 不执行并记 refuse
 *  13. 卸载解析不出目标 → 不弹卡、不执行，但记 refuse
 *  14. 卸载解析成功 → 弹卡，卡片上的目标就是实际执行的目标（K7）
 *  15. 卸载模糊名字不命中（不做模糊匹配）
 *  16. 安装：空名字 / 非法路径拒绝；install 档允许「始终允许」（唯一开档工具）
 *  17. allowAlways 命中：记忆里有 key 时免弹卡直接执行（authz=user_always）；无记忆照常弹卡
 *  18. 授权记忆能持久化、重启后还在、且能撤销
 *  19. 候选卡：选完重新解析再弹授权卡；取消/无选择能力时不安装也不猜
 *  20. 写操作事后核对：删完自己再查一次；结论进审计；演练模式不核对
 *  21. 写文件：落点被代码写死、同名不覆盖、卡片上的路径就是写下的路径、写完回读核对；
 *      审计带工具名，「打开所在位置」只认产出目录（渲染层拿不到任意路径的定位）
 */

const ctx: ToolContext = {
  config: DEFAULT_CONFIG,
  record: (entry) => ({ ...entry, id: 'ctx', ts: new Date().toISOString() })
}

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

function makeGate(answer: AuthAnswer): { gate: GateHooks; records: RecordEntry[]; seen: string[] } {
  const records: RecordEntry[] = []
  const seen: string[] = []
  const gate: GateHooks = {
    requestAuth: async (request) => {
      seen.push(`${request.tool}|allowAlways=${request.allowAlways}|${request.effect}|${request.target}`)
      return answer
    },
    isRemembered: () => false,
    remember: () => {},
    record: (entry) => {
      records.push({ ...entry, id: `g${records.length}`, ts: new Date().toISOString() })
    }
  }
  return { gate, records, seen }
}

async function main(): Promise<void> {
  console.log(`沙箱：${SANDBOX_ROOT}\n`)
  const files = await prepareSandbox()
  const tools = createTools({})
  const find = (name: string): ToolDef => {
    const def = tools.find((t) => t.name === name)
    if (!def) throw new Error(`工具不存在：${name}`)
    return def
  }
  const removeTool = find('delete_to_recycle')
  const listTool = find('list_sandbox_files')

  console.log(`沙箱初始文件 ${files.length} 个：${files.map((f) => f.name).join('、')}\n`)

  // ---- 1 拒绝：不执行、文件还在、留痕 rejected ----
  const sample = path.join(SANDBOX_ROOT, '会议记录-周会.txt')
  const denied = makeGate('deny')
  const deniedResult = await executeThroughGate(removeTool, { path: sample }, ctx, denied.gate)
  check(
    '拒绝时不执行',
    deniedResult.blocked === true && deniedResult.ok === false && existsSync(sample),
    `blocked=${deniedResult.blocked} 文件仍在=${existsSync(sample)}`
  )
  check(
    '拒绝留痕',
    denied.records.length === 1 && denied.records[0].result === 'rejected' && denied.records[0].authz === 'denied',
    `records=${JSON.stringify(denied.records.map((r) => `${r.kind}:${r.result}:${r.authz}`))}`
  )

  // ---- 1b 授权卡超时：expired 等同拒绝，审计单独标出（与主动拒绝区分） ----
  const expired = makeGate('expired')
  const expiredResult = await executeThroughGate(removeTool, { path: sample }, ctx, expired.gate)
  check(
    '超时按拒绝收口',
    expiredResult.blocked === true && expiredResult.ok === false && existsSync(sample),
    `blocked=${expiredResult.blocked} 文件仍在=${existsSync(sample)}`
  )
  check(
    '超时审计单独标记',
    expired.records.length === 1 && expired.records[0].result === 'rejected' && expired.records[0].authz === 'expired',
    `authz=${expired.records[0].authz}`
  )

  // ---- 2 沙箱外路径：即便用户点通过也拒绝 ----
  const outside = path.join(os.tmpdir(), 'not-in-sandbox.txt')
  const allowed = makeGate('once')
  const outsideResult = await executeThroughGate(removeTool, { path: outside }, ctx, allowed.gate)
  check(
    '沙箱外路径被代码拒绝',
    outsideResult.ok === false && /演示沙箱/.test(outsideResult.summary),
    outsideResult.summary
  )

  // ---- 3 允许一次：真执行 + 留痕带 undo ----
  const target = path.join(SANDBOX_ROOT, '临时导出.csv')
  const once = makeGate('once')
  const onceResult = await executeThroughGate(removeTool, { path: target }, ctx, once.gate)
  check(
    '允许一次时真执行',
    onceResult.ok === true && !existsSync(target),
    `ok=${onceResult.ok} 文件已移走=${!existsSync(target)}`
  )
  check(
    '执行留痕带撤回方式',
    once.records.length === 1 &&
      once.records[0].result === 'ok' &&
      once.records[0].authz === 'user_once' &&
      once.records[0].undo === '回收站还原',
    `authz=${once.records[0]?.authz} undo=${once.records[0]?.undo}`
  )

  // ---- 3b 事后核对：删完之后必须自己再查一次，而不是复述回执 ----
  check(
    '删除后的事后核对是重新查过的',
    onceResult.verify?.state === 'confirmed' && /已经没有/.test(onceResult.verify?.fact ?? ''),
    `verify=${onceResult.verify?.state} · ${onceResult.verify?.fact ?? '（没有核对）'}`
  )
  check(
    '核对结论进审计（能回答「那次到底查没查」）',
    once.records[0]?.verified === 'confirmed' && Boolean(once.records[0]?.verifyFact),
    `verified=${once.records[0]?.verified} fact=${once.records[0]?.verifyFact ?? '（空）'}`
  )

  // ---- 4 销毁类不给「始终允许」（用演练模式，避免测试动作本身破坏演示文件） ----
  const keep = path.join(SANDBOX_ROOT, '月度报销单-2026-10.txt')
  const alwaysAsked = makeGate('always')
  await executeThroughGate(removeTool, { path: keep }, ctx, { ...alwaysAsked.gate, dryRun: true })
  check(
    '销毁类不允许始终允许',
    removeTool.allowAlways !== true && alwaysAsked.seen.length > 0 && alwaysAsked.seen.every((s) => s.includes('allowAlways=false')),
    alwaysAsked.seen.join(' , ') || '(卡片没弹出)'
  )

  // ---- 5 演练模式：判定照走、不真执行 ----
  const dry = makeGate('once')
  const dryResult = await executeThroughGate(removeTool, { path: keep }, ctx, { ...dry.gate, dryRun: true })
  check(
    '演练模式不真执行',
    dryResult.ok === true && existsSync(keep) && dry.records[0]?.result === 'ok',
    `ok=${dryResult.ok} 文件仍在=${existsSync(keep)} 留痕=${dry.records[0]?.result}`
  )

  check(
    '演练模式不做核对（什么都没执行，没有可核对的）',
    dryResult.verify === undefined,
    `verify=${dryResult.verify?.state ?? '（无）'}`
  )

  // ---- 6 只读工具自动放行 ----
  const readRun = makeGate('deny')
  const readResult = await executeThroughGate(listTool, {}, ctx, readRun.gate)
  check(
    '只读工具自动放行',
    readResult.ok === true && readRun.records[0]?.authz === 'auto' && readRun.seen.length === 0,
    `ok=${readResult.ok} authz=${readRun.records[0]?.authz} 弹卡=${readRun.seen.length}`
  )

  // ---- 7 畸形授权答案：只有 once / always 算通过，其余一律按拒绝 ----
  const meeting = path.join(SANDBOX_ROOT, '会议记录-周会.txt')
  const weird = makeGate('approve' as unknown as AuthAnswer)
  const weirdResult = await executeThroughGate(removeTool, { path: meeting }, ctx, weird.gate)
  check(
    '畸形授权答案按拒绝处理',
    weirdResult.blocked === true && existsSync(meeting) && weird.records[0]?.authz === 'denied',
    `blocked=${weirdResult.blocked} 文件仍在=${existsSync(meeting)} authz=${weird.records[0]?.authz}`
  )

  const missing = makeGate(undefined as unknown as AuthAnswer)
  const missingResult = await executeThroughGate(removeTool, { path: meeting }, ctx, missing.gate)
  check(
    '缺省授权答案按拒绝处理',
    missingResult.blocked === true && existsSync(meeting),
    `blocked=${missingResult.blocked} 文件仍在=${existsSync(meeting)}`
  )

  // ---- 8 记忆不能越过 allowAlways：销毁类即便被写进记忆也必须弹卡 ----
  const memo = makeGate('deny')
  const memoResult = await executeThroughGate(removeTool, { path: keep }, ctx, {
    ...memo.gate,
    isRemembered: () => true
  })
  check(
    '记忆不能越过 allowAlways',
    memo.seen.length === 1 && memoResult.blocked === true && existsSync(keep),
    `弹卡=${memo.seen.length} blocked=${memoResult.blocked} 文件仍在=${existsSync(keep)}`
  )

  // ---- 9 write 备份失败 → 不执行 ----
  const writeTool: ToolDef = {
    name: 'synthetic_write',
    label: '合成写入工具',
    description: '仅用于验收备份分支',
    effect: 'write',
    parameters: { type: 'object', properties: {} },
    backup: async () => ({ ok: false, detail: '磁盘已满' }),
    run: async () => ({ ok: true, summary: '不该被调用' })
  }
  const wb = makeGate('deny')
  const wbResult = await executeThroughGate(writeTool, {}, ctx, wb.gate)
  check(
    'write 备份失败则不执行',
    wbResult.ok === false && wbResult.blocked === true && wb.records[0]?.result === 'rejected',
    `ok=${wbResult.ok} blocked=${wbResult.blocked} 留痕=${wb.records[0]?.result}`
  )

  // ---- 10 destroy 备份失败 → 用户批准了也不执行 ----
  const destroyTool: ToolDef = {
    name: 'synthetic_destroy',
    label: '合成销毁工具',
    description: '仅用于验收销毁分支的备份',
    effect: 'destroy',
    allowAlways: false,
    parameters: { type: 'object', properties: {} },
    backup: async () => ({ ok: false, detail: '备份目录不可写' }),
    run: async () => ({ ok: true, summary: '不该被调用' })
  }
  const db = makeGate('once')
  const dbResult = await executeThroughGate(destroyTool, {}, ctx, db.gate)
  check(
    'destroy 备份失败则不执行',
    dbResult.ok === false && dbResult.blocked === true && db.records[0]?.result === 'rejected',
    `ok=${dbResult.ok} blocked=${dbResult.blocked} 留痕=${db.records[0]?.result}`
  )

  // ---- 11 destroy 备份成功 → 执行，并把备份句柄写进留痕 ----
  const backedUp: ToolDef = {
    ...destroyTool,
    name: 'synthetic_destroy_backed',
    backup: async () => ({ ok: true, undo: '备份：backup/程序.zip' }),
    run: async () => ({ ok: true, summary: '合成的卸载已完成' })
  }
  const bu = makeGate('once')
  const buResult = await executeThroughGate(backedUp, {}, ctx, bu.gate)
  check(
    'destroy 备份成功时留痕带备份句柄',
    buResult.ok === true && bu.records[0]?.undo === '备份：backup/程序.zip' && bu.records[0]?.reversible === true,
    `undo=${bu.records[0]?.undo} reversible=${bu.records[0]?.reversible}`
  )

  // ---- 12 未声明 / 非法 effect → 直接拒绝并记 refuse ----
  const badEffect = { ...writeTool, name: 'synthetic_bad_effect', effect: 'nuke' as never, backup: undefined }
  const bad = makeGate('once')
  const badResult = await executeThroughGate(badEffect, {}, ctx, bad.gate)
  check(
    '非法 effect 的工具不会被执行',
    badResult.blocked === true && badResult.ok === false && bad.records[0]?.kind === 'refuse',
    `blocked=${badResult.blocked} 留痕=${bad.records[0]?.kind}`
  )

  // ---- 13 卸载：解析不出目标 → 不弹卡、不执行（拿不到唯一目标就不该让用户点） ----
  const uninstallTool = find('uninstall_app')
  const ghost = makeGate('once')
  const ghostResult = await executeThroughGate(uninstallTool, { name: '绝对不存在的程序 Xyz' }, ctx, ghost.gate)
  check(
    '卸载：名字对不上时拒绝且不弹卡',
    ghostResult.ok === false && ghostResult.blocked === true && ghost.seen.length === 0,
    `ok=${ghostResult.ok} blocked=${ghostResult.blocked} 弹卡=${ghost.seen.length} 留痕=${ghost.records[0]?.kind}`
  )
  check(
    '卸载：拒绝也留痕（refuse）',
    ghost.records.length === 1 && ghost.records[0].kind === 'refuse' && ghost.records[0].result === 'rejected',
    ghost.records.map((r) => `${r.kind}:${r.result}`).join(',')
  )

  // ---- 14 卸载：能从真实注册表解析出唯一目标 → 弹卡，且卡片目标 = 解析出的程序；dryRun 不执行 ----
  const { apps } = await listInstalledApps()
  let resolvable = ''
  for (const app of apps.filter((a) => a.systemComponent !== 1).slice(0, 8)) {
    const planned = await planUninstall(app.name)
    if (planned.ok) {
      resolvable = app.name
      break
    }
  }
  if (resolvable) {
    const memoReal = makeGate('once')
    const dryUninstall = await executeThroughGate(uninstallTool, { name: resolvable }, ctx, {
      ...memoReal.gate,
      dryRun: true
    })
    const card = memoReal.seen[0] ?? ''
    check(
      '卸载：解析成功后弹卡、卡片目标即可执行目标',
      dryUninstall.ok === true && memoReal.seen.length === 1 && card.includes(resolvable),
      card || '(没弹卡)'
    )
    check(
      '卸载：销毁类不给「始终允许」',
      uninstallTool.allowAlways !== true && card.includes('allowAlways=false'),
      `allowAlways=${uninstallTool.allowAlways} 卡片=${card}`
    )
    check(
      '卸载：dryRun 时没有真的启动卸载程序',
      dryUninstall.ok === true && /演练模式/.test(dryUninstall.summary) && memoReal.records[0]?.authz === 'user_once',
      dryUninstall.summary
    )
  } else {
    console.log('SKIP  卸载：这台机器上前 8 个程序都没有可解析的卸载入口')
  }

  // ---- 15 卸载：模糊名字不算命中（拒绝模糊匹配，避免卸错程序） ----
  if (resolvable) {
    const fuzzy = makeGate('once')
    const fuzzyName = resolvable.slice(0, Math.max(2, resolvable.length - 2))
    const fuzzyResult = await executeThroughGate(uninstallTool, { name: fuzzyName }, ctx, fuzzy.gate)
    check(
      '卸载：模糊名字不命中',
      fuzzyResult.ok === false && fuzzy.seen.length === 0,
      `name=${fuzzyName} ok=${fuzzyResult.ok} 弹卡=${fuzzy.seen.length}`
    )
  }

  // ---- 16 安装：空名字 / 非法路径直接拒绝，不弹卡（winget 不会被调用） ----
  const installTool = tools.find((t) => t.name === 'install_app')
  if (installTool) {
    const instGate = makeGate('once')
    const instResult = await executeThroughGate(installTool, { name: '' }, ctx, instGate.gate)
    check(
      '安装：空名字拒绝且不弹卡',
      instResult.ok === false && instResult.blocked === true && instGate.seen.length === 0,
      `ok=${instResult.ok} blocked=${instResult.blocked} 弹卡=${instGate.seen.length}`
    )
    check(
      '安装：install 档允许「始终允许」（唯一开档工具）',
      installTool.allowAlways === true,
      `allowAlways=${installTool.allowAlways}`
    )
  } else {
    console.log('SKIP  安装：工具清单里没有 install_app')
  }

  // ---- 16b 打开程序：不弹卡（ui 档），名字对不上就拒绝 ----
  const launchTool = tools.find((t) => t.name === 'launch_app')
  if (launchTool) {
    const missing = await executeThroughGate(
      launchTool,
      { name: '绝对不存在的程序 Xyz' },
      ctx,
      makeGate('once').gate
    )
    check(
      '打开程序：开始菜单里没有就拒绝，不弹卡',
      missing.ok === false && missing.blocked === true,
      `ok=${missing.ok} blocked=${missing.blocked}`
    )
    check('打开程序：ui 档，不需要授权卡', launchTool.effect === 'ui', `effect=${launchTool.effect}`)

    /**
     * 真机上「ICEY」是 `steam://rungameid/553640` 的 `.url`，不是 `.lnk`。
     * 只认 `.lnk` 的时代，用户说"打开 ICEY"，管家答"没有这个程序"。
     * 这里钉住的是判定口径（哪些协议算程序），真机扫到的条目不由离线断言负责。
     */
    check(
      '打开程序：启动器协议算程序（steam://）',
      isLaunchableUrl('steam://rungameid/553640') === true,
      'steam:// → true'
    )
    check(
      '打开程序：http/https 不算程序（那是网页）',
      isLaunchableUrl('https://www.bilibili.com/') === false && isLaunchableUrl('http://x.test/') === false,
      'http(s):// → false'
    )
    check(
      '打开程序：盘符路径不能冒充协议（.url 指向本机 exe 的缺口）',
      isLaunchableUrl('C:\\Windows\\System32\\notepad.exe') === false,
      'C:\\...exe → false'
    )
    check(
      '打开程序：Git Bash / Git CMD / Windows Terminal / WSL 这类终端入口不放行',
      ['Git Bash', 'Git CMD', 'Windows Terminal', 'WSL', '命令提示符'].every((n) => !isLaunchableShortcut(n)),
      '全部 false'
    )
  } else {
    console.log('SKIP  打开程序：工具清单里没有 launch_app')
  }

  // ---- 16c 打开文件夹：ui 档、不弹卡，且只开目录 ----
  const folderTool = tools.find((t) => t.name === 'open_folder')
  if (folderTool) {
    check('打开文件夹：ui 档，不需要授权卡', folderTool.effect === 'ui', `effect=${folderTool.effect}`)

    // 网络共享：连上去就是一次 SMB 登录，会把本机凭据交出去，必须挡在 plan 阶段
    const unc = await executeThroughGate(
      folderTool,
      { name: '\\\\192.168.1.10\\share' },
      ctx,
      makeGate('once').gate
    )
    check(
      '打开文件夹：网络共享路径拒绝，不弹卡',
      unc.ok === false && unc.blocked === true && /凭据/.test(unc.summary),
      `ok=${unc.ok} blocked=${unc.blocked}`
    )

    // 路径不存在 / 指到 exe：都不该被当成"打开一个文件夹"
    const notThere = await executeThroughGate(
      folderTool,
      { name: 'C:\\绝对不存在的目录\\nope' },
      ctx,
      makeGate('once').gate
    )
    check(
      '打开文件夹：本机不存在的目录拒绝，不弹卡',
      notThere.ok === false && notThere.blocked === true,
      `ok=${notThere.ok}`
    )

    const exe = await executeThroughGate(
      folderTool,
      { name: 'C:\\Windows\\System32\\notepad.exe' },
      ctx,
      makeGate('once').gate
    )
    check(
      '打开文件夹：可执行文件不当文件夹打开',
      exe.ok === false && exe.blocked === true && /执行/.test(exe.summary),
      `ok=${exe.ok}`
    )
  } else {
    console.log('SKIP  打开文件夹：工具清单里没有 open_folder')
  }

  // ---- 16c-2 打开文件夹：不在桌面上的也认得（真机扫一遍） ----
  {
    const started = Date.now()
    const index = scanFolderIndex()
    const elapsed = Date.now() - started
    check(
      '打开文件夹：深索引能扫到盘根往下的目录',
      index.length > 50,
      `${index.length} 项 / ${elapsed}ms`
    )
    const candidates = listFolderCandidates()
    // 系统目录的名字有确定含义，不该被深索引里的同名声东搅成歧义
    const pictures = matchFolder('图片', candidates)
    check(
      '打开文件夹：「图片」直接指图片库，不报歧义',
      pictures.ok === true && /Pictures/i.test(pictures.folder.path),
      pictures.ok ? pictures.folder.path : pictures.reason
    )
    // 从认得的目录往下写一截，也得补成绝对路径
    const docsChild = planFolder('文档\\不存在的一层-xyz', candidates)
    check(
      '打开文件夹：「文档\\子目录」按文档目录补全（不存在时如实说不存在）',
      docsChild.ok === false && /没有/.test(docsChild.reason),
      docsChild.ok ? docsChild.folder.path : docsChild.reason
    )
  }

  // ---- 16c-3 打开文件夹：同名歧义 → 弹候选卡，用户点哪个就开哪个 ----
  {
    /*
     * 用临时目录伪造一台"盘"，不拿真机的目录做判据：
     * 换个机器跑（别人盘里没有 KCareOne）断言就会红，红的原因跟要验的事情无关。
     */
    const fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'butler-gate-choice-'))
    try {
      const names = ['KCareOne-ALL', 'KCareOne-MAIN', 'KCareOne-SQL']
      for (const name of names) mkdirSync(path.join(fakeRoot, name))
      setFolderIndexRoots([{ dir: fakeRoot, depth: 3 }])
      // 桌面也换成空的：真桌面上多一个同名目录，候选数就会变成 4，这条断言也就失去意义
      setFolderDesktopRoots([])
      resetFolderCache()

      let opened = ''
      const folderWithStub = createTools({
        openFolder: async (p) => {
          opened = p
          return ''
        }
      }).find((t) => t.name === 'open_folder')

      if (!folderWithStub) {
        console.log('SKIP  打开文件夹候选卡：工具清单里没有 open_folder')
      } else {
        const asked: string[][]= []
        const picked = path.join(fakeRoot, 'KCareOne-MAIN')
        const choiceResult = await executeThroughGate(
          folderWithStub,
          { name: 'kcareone' },
          ctx,
          {
            ...makeGate('once').gate,
            requestChoice: async (request) => {
              asked.push(request.options.map((o) => o.value))
              return picked
            }
          }
        )
        check(
          '打开文件夹：同名多个 → 弹候选卡而不是失败',
          asked.length === 1 && (asked[0] ?? []).length === 3,
          `弹卡=${asked.length} 候选=${(asked[0] ?? []).length}`
        )
        check(
          '打开文件夹：卡上每个候选都带完整路径（不然同名分不出谁是谁）',
          (asked[0] ?? []).every((v) => /^[a-zA-Z]:[\\/]/.test(v) && v.toLowerCase().includes('kcareone')),
          (asked[0] ?? []).join(' | ')
        )
        check(
          '打开文件夹：用户点哪个就开哪个（K7：卡片目标 = 执行目标）',
          choiceResult.ok === true && opened === picked,
          `开了 ${opened}`
        )

        // 取消 → 一个都不开
        let cancelledOpened = 0
        const folderCounting = createTools({
          openFolder: async () => {
            cancelledOpened++
            return ''
          }
        }).find((t) => t.name === 'open_folder')!
        const cancelled = await executeThroughGate(
          folderCounting,
          { name: 'kcareone' },
          ctx,
          { ...makeGate('once').gate, requestChoice: async () => null }
        )
        check(
          '打开文件夹：取消候选卡 → 一个都不开',
          cancelled.ok === false && cancelled.blocked === true && cancelledOpened === 0,
          `ok=${cancelled.ok} 打开次数=${cancelledOpened}`
        )
      }
    } finally {
      setFolderIndexRoots(null)
      setFolderDesktopRoots(null)
      resetFolderCache()
      rmSync(fakeRoot, { recursive: true, force: true })
    }
  }

  // ---- 16c-4 打开 / 阅读文件：能读的读出来，读不了的如实说 ----
  {
    const openFileTool = tools.find((t) => t.name === 'open_file')
    const readFileTool = tools.find((t) => t.name === 'read_file')
    if (!openFileTool || !readFileTool) {
      console.log('SKIP  打开/阅读文件：工具清单里没有 open_file / read_file')
    } else {
      check(
        '打开文件：ui 档；读文件：read 档（都不弹授权卡）',
        openFileTool.effect === 'ui' && readFileTool.effect === 'read',
        `open=${openFileTool.effect} read=${readFileTool.effect}`
      )

      /*
       * 用临时目录造样本，不拿用户的文档做判据（也不打印任何正文）：
       * 换个机器跑，别人桌面上没有这份会议纪要，红了也说明不了任何事。
       */
      const fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'butler-gate-read-'))
      try {
        // 一份真的 .docx：ZIP 里塞 word/document.xml，走自己那个 ZIP 读取器
        const docxPath = path.join(fakeRoot, '会议纪要.docx')
        writeFileSync(
          docxPath,
          buildDocx(
            '<w:p><w:r><w:t>结论：先做完闸门，再谈删除。</w:t></w:r></w:p>' +
              '<w:p><w:r><w:t>下一步：补分段读。</w:t></w:r></w:p>'
          )
        )
        const doc = await executeThroughGate(readFileTool, { path: docxPath }, ctx, makeGate('once').gate)
        const docData = doc.data as { text?: string; complete?: boolean } | null
        check(
          '读文件：.docx 的正文真的抠出来了（不拉起 Office）',
          doc.ok === true && docData?.text === '结论：先做完闸门，再谈删除。\n下一步：补分段读。',
          doc.ok ? `读到 ${docData?.text?.length ?? 0} 字` : doc.summary
        )
        check(
          '读文件：读完的要说清是全文（不然模型会含糊其辞）',
          doc.ok === true && /全文/.test(doc.summary),
          doc.summary
        )

        // PDF：抠出来是乱码，不如老实说读不了
        const pdfPath = path.join(fakeRoot, '合同.pdf')
        writeFileSync(pdfPath, '%PDF-1.7')
        const pdf = await executeThroughGate(readFileTool, { path: pdfPath }, ctx, makeGate('once').gate)
        check(
          '读文件：PDF 如实说读不了（不吐乱码让模型去总结）',
          pdf.ok === false && /PDF/.test(pdf.summary),
          pdf.summary
        )

        // 双击 exe 是"运行"不是"打开"，这条路只负责摆窗口
        const exePath = path.join(fakeRoot, 'setup.exe')
        writeFileSync(exePath, 'MZ')
        const exeFile = await executeThroughGate(openFileTool, { path: exePath }, ctx, makeGate('once').gate)
        check(
          '打开文件：exe 不当文件打开（改走 launch_app）',
          exeFile.ok === false && /launch_app/.test(exeFile.summary),
          exeFile.summary
        )

        // 同名两个文件 → 候选卡；点哪个读哪个（K7：令牌里的目标和执行的目标同源）
        mkdirSync(path.join(fakeRoot, '甲'))
        mkdirSync(path.join(fakeRoot, '乙'))
        const aPath = path.join(fakeRoot, '甲', '周报.txt')
        writeFileSync(aPath, '甲的内容')
        writeFileSync(path.join(fakeRoot, '乙', '周报.txt'), '乙的内容')
        setFileIndexRoots([fakeRoot])
        resetFileIndex()

        const offered: string[] = []
        const readPicked = await executeThroughGate(readFileTool, { path: '周报.txt' }, ctx, {
          ...makeGate('once').gate,
          requestChoice: async (request) => {
            offered.push(...request.options.map((o) => o.value))
            return path.resolve(aPath)
          }
        })
        const pickedData = readPicked.data as { text?: string } | null
        check(
          '读文件：同名多个 → 弹候选卡，点哪个读哪个',
          offered.length === 2 && readPicked.ok === true && pickedData?.text === '甲的内容',
          `候选=${offered.length} 读到=${pickedData?.text ?? readPicked.summary}`
        )
      } finally {
        setFileIndexRoots(null)
        resetFileIndex()
        rmSync(fakeRoot, { recursive: true, force: true })
      }

      // 真机：按名字找文件的那套索引扫得到用户自己的目录（只报个数，不打印文件名）
      const scanStarted = Date.now()
      const realFiles = scanFileIndex()
      check(
        '打开文件：按名字找文件能扫到真机上的文件',
        realFiles.length > 0,
        `${realFiles.length} 个文件 / ${Date.now() - scanStarted}ms`
      )
    }
  }

  // ---- 16d 进程表探不到时不影响启动：判定走在上一步之后，这里只验纯逻辑 ----
  {
    const procs = [
      { pid: 1, name: 'Weixin', windowTitle: '', windowHandle: 0, exePath: '' },
      { pid: 2, name: 'Weixin', windowTitle: '微信', windowHandle: 77, exePath: '' }
    ]
    const open = findOpenWindow(procs, [normalizeAppName('微信'), normalizeAppName('Weixin')])
    check('已经开着：认有可见窗口的那个进程', open?.pid === 2, `pid=${open?.pid}`)
    check(
      '已经开着：只有后台进程时不算开着（不谎报）',
      findOpenWindow([procs[0]], [normalizeAppName('Weixin')]) === null,
      '无窗口 → null'
    )
  }

  // ---- 17 allowAlways 落库命中：记忆里有 key 时不弹卡直接过（authz=user_always）----
  const alwaysInstall: ToolDef = {
    name: 'synthetic_install',
    label: '合成安装（验证记忆命中）',
    description: '仅用于验收 allowAlways 命中分支',
    effect: 'install',
    allowAlways: true,
    parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: '合成安装完成' })
  }
  const hit = makeGate('deny') // 记忆命中时 requestAuth 根本不该被调，deny 兜底反而能抓住误弹卡
  const hitResult = await executeThroughGate(alwaysInstall, {}, ctx, {
    ...hit.gate,
    // 合成工具没有 plan，target 走 fallbackTarget = JSON.stringify({}) = '{}'
    isRemembered: (key) => key === rememberKey('synthetic_install', '{}'),
    dryRun: true
  })
  check(
    '记忆命中时免弹卡直接执行',
    hit.seen.length === 0 && hitResult.ok === true && hit.records[0]?.authz === 'user_always',
    `弹卡=${hit.seen.length} authz=${hit.records[0]?.authz} ok=${hitResult.ok}`
  )
  const miss = makeGate('once')
  const missResult = await executeThroughGate(alwaysInstall, {}, ctx, {
    ...miss.gate,
    isRemembered: () => false,
    dryRun: true
  })
  check(
    '无记忆时照常弹卡且卡片带 allowAlways=true',
    miss.seen.length === 1 && miss.seen[0].includes('allowAlways=true') && missResult.ok === true,
    miss.seen.join(' , ') || '(没弹卡)'
  )

  // ---- 18 授权记忆：持久化 + 重启后仍生效 + 可撤销 ----
  const memDir = path.join(os.tmpdir(), `butler-mem-${Date.now()}`)
  const memKey = 'open_settings_page::设置：应用'
  const first = new Store(memDir)
  await first.init()
  await first.addAlwaysAllowed({
    key: memKey,
    tool: 'open_settings_page',
    target: '设置：应用',
    createdAt: new Date().toISOString()
  })
  // 换一个实例读同一个目录 = 模拟重启
  const afterRestart = await new Store(memDir).listAlwaysAllowed()
  const afterRevoke = await new Store(memDir).revokeAlwaysAllowed(memKey)
  check(
    '授权记忆能持久化、重启后还在、并能撤销',
    afterRestart.length === 1 && afterRestart[0].key === memKey && afterRevoke.length === 0,
    `重启后 ${afterRestart.length} 条，撤销后 ${afterRevoke.length} 条`
  )
  await fs.rm(memDir, { recursive: true, force: true })

  /**
   * ---- 19 候选卡：名字有歧义时先问「是哪一个」，选完重新解析、再走授权卡 ----
   *
   * 这一段不碰 winget（离线验收要能在没网、没装 winget 的机器上跑），
   * 用一个合成的 install 工具走同一条闸门代码，钉住三件事：
   * 选择必须写回参数重新解析、授权卡照旧弹、取消就什么都不做。
   */
  const chooser: ToolDef = {
    name: 'synthetic_chooser',
    label: '合成安装工具（有歧义）',
    description: '仅用于验收候选卡分支',
    effect: 'install',
    allowAlways: false,
    parameters: { type: 'object', properties: {} },
    plan: async (args) => {
      const id = String(args.name ?? '')
      if (!id.includes('.')) {
        return {
          ok: false,
          reason: '有两个候选',
          choice: {
            title: '你要装哪一个「kimi」？',
            pickInto: 'name',
            options: [
              { value: 'MoonshotAI.Kimi', label: 'Kimi' },
              { value: 'MoonshotAI.KimiCLI', label: 'Kimi CLI' }
            ]
          }
        }
      }
      return {
        ok: true,
        target: { title: `安装：${id}`, target: `${id} 1.0.0`, impact: '静默安装' },
        execute: async () => ({ ok: true, summary: `装了 ${id}` })
      }
    },
    run: async () => ({ ok: true, summary: '不该被调用' })
  }

  const picked2 = makeGate('once')
  let offeredOptions: string[] = []
  const pickResult = await executeThroughGate(chooser, { name: 'kimi' }, ctx, {
    ...picked2.gate,
    requestChoice: async (request) => {
      offeredOptions = request.options.map((o) => o.value)
      return 'MoonshotAI.KimiCLI'
    }
  })
  check(
    '候选卡：选完重新解析、再弹授权卡，执行的是选中那个',
    offeredOptions.length === 2 &&
      picked2.seen.length === 1 &&
      picked2.seen[0].includes('MoonshotAI.KimiCLI') &&
      pickResult.ok === true &&
      pickResult.summary.includes('MoonshotAI.KimiCLI'),
    `候选=${offeredOptions.length} 弹卡=${picked2.seen.length} 目标=${picked2.seen[0] ?? '无'}`
  )
  check(
    '候选卡：选择本身也要留痕（能回答「我点了哪一个」）',
    picked2.records.some((r) => r.title.startsWith('选择：')),
    `留痕=${picked2.records.map((r) => r.kind).join(',')}`
  )

  const cancelled = makeGate('once')
  const cancelResult = await executeThroughGate(chooser, { name: 'kimi' }, ctx, {
    ...cancelled.gate,
    requestChoice: async () => null
  })
  check(
    '候选卡：用户取消 → 不弹授权卡、不安装',
    cancelResult.ok === false && cancelResult.blocked === true && cancelled.seen.length === 0,
    `ok=${cancelResult.ok} 弹卡=${cancelled.seen.length} 留痕=${cancelled.records[0]?.kind}`
  )

  const offlineEval = makeGate('once')
  const noChoiceHooks = await executeThroughGate(chooser, { name: 'kimi' }, ctx, offlineEval.gate)
  check(
    '候选卡：没有选择能力的环境（评测/定时任务）→ 拒绝，不猜',
    noChoiceHooks.ok === false && noChoiceHooks.blocked === true && offlineEval.seen.length === 0,
    `ok=${noChoiceHooks.ok} 弹卡=${offlineEval.seen.length}`
  )

  /**
   * ---- 21 写文件：唯一一处往用户真实目录里的写入，四条边界逐条钉住 ----
   *
   * 落点由 node/document.ts 定死（<文档>\长庚产出），模型给的只有文件名；
   * 同名不覆盖；卡片上的路径就是真正写下的那个（K7）；写完回读比对内容。
   */
  const docsRoot = mkdtempSync(path.join(os.tmpdir(), 'butler-docs-'))
  const docTool = createTools({ documentsDir: docsRoot }).find((t) => t.name === 'write_document')!

  const escapeTry = makeGate('once')
  const escaped = await executeThroughGate(docTool, { name: '..\\..\\evil.md', content: 'x' }, ctx, escapeTry.gate)
  check(
    '写文件：带目录的名字在解析阶段就拒绝，卡片不弹',
    escaped.ok === false && escaped.blocked === true && escapeTry.seen.length === 0,
    `ok=${escaped.ok} 弹卡=${escapeTry.seen.length} 原因=${escaped.summary.slice(0, 40)}`
  )

  const docNoDir = createTools().find((t) => t.name === 'write_document')!
  const noDir = await executeThroughGate(docNoDir, { name: '甲.md', content: 'x' }, ctx, makeGate('once').gate)
  check(
    '写文件：没有注入文档目录时不写（不退回进程当前目录）',
    noDir.ok === false && noDir.blocked === true,
    noDir.summary
  )

  const docDenied = makeGate('deny')
  const docDenyResult = await executeThroughGate(docTool, { name: '拒绝的.md', content: 'x' }, ctx, docDenied.gate)
  const docFolder = path.join(docsRoot, '长庚产出')
  check(
    '写文件：用户拒绝 → 一个文件都不建',
    docDenyResult.ok === false && docDenied.records[0]?.result === 'rejected' && !existsSync(path.join(docFolder, '拒绝的.md')),
    `ok=${docDenyResult.ok} 留痕=${docDenied.records[0]?.result}`
  )

  const docOnce = makeGate('once')
  const docResult = await executeThroughGate(docTool, { name: '周会纪要', content: '结论：先做完闸门。\n' }, ctx, docOnce.gate)
  const docData = docResult.data as { path?: string; name?: string; bytes?: number } | null
  check(
    '写文件：落到「文档\\长庚产出」，卡片上写的路径就是写下的路径（K7）',
    docResult.ok === true &&
      docData?.path === path.join(docFolder, '周会纪要.md') &&
      docOnce.seen.length === 1 &&
      docOnce.seen[0].includes(docData?.path ?? '从不匹配'),
    `路径=${docData?.path ?? '无'} 弹卡=${docOnce.seen.length}`
  )
  check(
    '写文件：写完自己回读比对内容，结论进审计',
    docResult.verify?.state === 'confirmed' &&
      docOnce.records[0]?.verified === 'confirmed' &&
      Boolean(docOnce.records[0]?.verifyFact) &&
      existsSync(docData?.path ?? ''),
    `verify=${docResult.verify?.state} 文件在=${existsSync(docData?.path ?? '')}`
  )

  const docAgain = makeGate('once')
  const docSecond = await executeThroughGate(docTool, { name: '周会纪要', content: '第二份' }, ctx, docAgain.gate)
  const secondData = docSecond.data as { name?: string; path?: string } | null
  check(
    '写文件：同名不覆盖，换一个新名字，原来那份内容不变',
    secondData?.name === '周会纪要 (2).md' &&
      (await fs.readFile(docData?.path ?? '', 'utf8')) === '结论：先做完闸门。\n',
    `新名字=${secondData?.name ?? '无'}`
  )
  check(
    '审计记下是哪个工具（记录页的「打开所在位置」靠它，不靠 title 文案）',
    docOnce.records[0]?.tool === 'write_document' && once.records[0]?.tool === 'delete_to_recycle',
    `write=${docOnce.records[0]?.tool} destroy=${once.records[0]?.tool}`
  )
  check(
    '「打开所在位置」只认产出目录里的文件（渲染层拿不到任意路径的定位能力）',
    isInsideOutput(docsRoot, docData?.path ?? '') === true &&
      isInsideOutput(docsRoot, path.join(docsRoot, '别处.md')) === false &&
      isInsideOutput(docsRoot, path.join(docsRoot, '长庚产出2', 'x.md')) === false,
    `产出内=${isInsideOutput(docsRoot, docData?.path ?? '')}`
  )
  await fs.rm(docsRoot, { recursive: true, force: true })

  // 把演示文件补回来，方便现场验收
  const restored = await prepareSandbox()
  console.log(`\n沙箱已补齐：${restored.map((f) => f.name).join('、')}`)
  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

/**
 * 造一份最小可用的 .docx（ZIP + word/document.xml），给"读文件"那条断言当样本。
 *
 * CRC 留 0：读取器不校验它（校验得再准也修不好一个坏文件，反而把"能读"变成"读不了"）。
 * 这里要的不是一个能分发的文档，而是一个结构和真 docx 一样的包。
 */
function buildDocx(bodyXml: string): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<w:document><w:body>${bodyXml}</w:body></w:document>`
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const data = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8) // method 8 = deflate
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

void main()
