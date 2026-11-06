import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTools } from '../src/main/agent/tools'
import { executeThroughGate, rememberKey, type GateHooks } from '../src/main/agent/gate'
import type { ToolContext, ToolDef } from '../src/main/agent/tool-types'
import { DEFAULT_CONFIG, Store } from '../src/main/node/store'
import { prepareSandbox, SANDBOX_ROOT } from '../src/main/node/sandbox'
import { listInstalledApps } from '../src/main/node/registry'
import { planUninstall } from '../src/main/node/uninstall'
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

  // 把演示文件补回来，方便现场验收
  const restored = await prepareSandbox()
  console.log(`\n沙箱已补齐：${restored.map((f) => f.name).join('、')}`)
  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main()
