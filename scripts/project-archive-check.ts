import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/node/store'
import { normalizeProject, projectsBlock, upsertProject } from '../src/main/node/projects'
import { probeProject } from '../src/main/node/projects-probe'

/**
 * 项目档案的落盘 + 提示词验证。
 *
 * 用法：npx tsx scripts/project-archive-check.ts
 *
 * 验的是什么：**它读回来的东西就是模型下一轮会看到的那一段**。
 * 不是"能不能写文件"——那是 Store 早就验过的事。这里要确认的是
 * 用户填的内容经过 normalize → 落盘 → 读回 → projectsBlock 之后，
 * 路径原样、没有变成相对路径、没有丢字段。
 *
 * 不碰真实配置目录：用一个临时目录，退出即删。
 */
async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-archive-'))
  const store = new Store(dir)
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`)
  }

  try {
    check('空档案读回空列表', (await store.listProjects()).length === 0, '开头是干净的')

    // 用用户真实登记的这两个项目，走真实的那条路
    const inputs = [
      {
        name: '开题报告',
        root: 'C:\\Users\\jiabi\\Desktop\\开题报告资料包_面向中文开源大模型的文本后门攻击与防御研究',
        logPath:
          'C:\\Users\\jiabi\\Desktop\\开题报告资料包_面向中文开源大模型的文本后门攻击与防御研究\\.workbuddy\\memory\\2026-11-13.md',
        note: '面向中文开源大模型的文本后门攻击与防御研究。开题报告书 12 页、文献综述 9 页、开题汇报 PPT 16 页均已出稿；封面待补指导教师与职称。'
      },
      {
        name: '学位论文材料',
        root: 'C:\\Users\\jiabi\\Desktop\\面向中文开源大模型的文本后门攻击与防御研究',
        note: '含学校要求、学长范本（宋杨辉）、相关文献。'
      }
    ]

    for (const input of inputs) {
      const normalized = normalizeProject(input)
      if (!normalized.ok) {
        check(`校验「${input.name}」`, false, normalized.reason)
        continue
      }
      check(`校验「${input.name}」`, true, normalized.value.root)

      await store.mutateProjects((current) => {
        const outcome = upsertProject(current, input, {
          id: `seed-${input.name}`,
          now: new Date().toISOString()
        })
        return outcome.ok ? { list: outcome.list, result: outcome.list } : { list: current, result: current }
      })
    }

    const saved = await store.listProjects()
    check('落盘后读回', saved.length === 2, `projects.json 里有 ${saved.length} 条`)

    for (const p of saved) {
      const probe = probeProject(p)
      check(
        `路径探测「${p.name}」`,
        probe.rootExists,
        `根目录${probe.rootExists ? '在' : '找不到'}；日志${probe.logExists === null ? '未登记' : probe.logExists ? '在' : '找不到'}`
      )
    }

    const block = projectsBlock(saved)
    console.log('\n—— 模型下一轮会看到的这一段 ——')
    console.log(block)

    check('提示词里路径原样出现', block.includes(inputs[0].root), '没有被转成相对路径或丢字符')
    check('日志路径也在', block.includes(inputs[0].logPath!), '模型不用自己翻目录猜哪个是日志')
    check('写明了"不是已核实的事实"', block.includes('不是你已经核实过的事实'), '防止模型把档案复述成现状')

    // 改名不新增：直接用同一个根目录再存一次
    const renamed = await store.mutateProjects((current) => {
      const outcome = upsertProject(current, { ...inputs[0], name: '开题报告（改名测试）' }, {
        id: 'ignored',
        now: new Date().toISOString()
      })
      return outcome.ok ? { list: outcome.list, result: outcome.list } : { list: current, result: current }
    })
    check('同根目录改名不新增条目', renamed.length === 2, `仍是 ${renamed.length} 条`)
    check('改名生效', renamed.some((p) => p.name === '开题报告（改名测试）'), renamed.map((p) => p.name).join(' / '))

    // 坏输入不落盘
    const before = (await store.listProjects()).length
    await store.mutateProjects((current) => {
      const outcome = upsertProject(current, { name: '坏路径', root: '\\\\nas\\share' }, { id: 'x', now: '' })
      return outcome.ok ? { list: outcome.list, result: outcome.list } : { list: current, result: current }
    })
    check('网络路径被拒且不落盘', (await store.listProjects()).length === before, `仍是 ${before} 条`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

void main().catch((err) => {
  console.error('检查中止：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
