import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_BUDGET_STEPS } from '../../src/main/agent/agent'
import { buildSystemPrompt } from '../../src/main/agent/prompt'
import { capabilityBrief, createTools } from '../../src/main/agent/tools'

/**
 * 工具注册表与系统提示词的口径一致性。
 *
 * 模型"否认自己的能力"和"夸大自己的能力"都是从提示词与注册表漂移来的，
 * 所以这里锁的是"两处说的是同一件事"。
 */
describe('系统提示词与工具注册表', () => {
  const env = {
    machineName: 'TEST-PC',
    userName: 'tester',
    osVersion: 'Windows 11',
    today: '2026/1/1',
    hasSearch: true,
    toolBudget: TOOL_BUDGET_STEPS
  }

  it('能力段由注册表生成：改动机器的工具都在提示词里', () => {
    const tools = createTools()
    const brief = capabilityBrief(tools)
    const mutating = tools.filter((t) => ['write', 'destroy', 'install'].includes(t.effect))
    expect(mutating.length).toBeGreaterThan(0)
    for (const tool of mutating) {
      expect(brief).toContain(tool.name)
    }
  })

  it('只读工具不进"能改动机器"那一段（避免夸大）', () => {
    const tools = createTools()
    const brief = capabilityBrief(tools)
    for (const tool of tools.filter((t) => t.effect === 'read')) {
      expect(brief).not.toContain(tool.name)
    }
  })

  it('提示词里的工具预算与代码里的步数上限是同一个数', () => {
    const prompt = buildSystemPrompt(env, '')
    expect(prompt).toContain(`最多 ${TOOL_BUDGET_STEPS} 步`)
  })

  it('没有检索能力时，提示词明确要求回答"查不到"', () => {
    const prompt = buildSystemPrompt({ ...env, hasSearch: false }, '')
    expect(prompt).toMatch(/没有任何联网检索能力/)
    expect(prompt).toMatch(/查不到/)
  })
})

describe('工具定义完整性', () => {
  const tools = createTools()

  it('工具名唯一', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个工具都声明了合法分档', () => {
    const valid = new Set(['read', 'ui', 'write', 'destroy', 'install'])
    for (const tool of tools) {
      expect(valid.has(tool.effect), tool.name).toBe(true)
    }
  })

  it('销毁类工具一律不允许「始终允许」', () => {
    for (const tool of tools.filter((t) => t.effect === 'destroy')) {
      expect(tool.allowAlways, tool.name).not.toBe(true)
    }
  })

  it('每个工具都有给人看的标签与参数 schema', () => {
    for (const tool of tools) {
      expect(tool.label.length, tool.name).toBeGreaterThan(0)
      expect(tool.description.length, tool.name).toBeGreaterThan(0)
      expect(tool.parameters, tool.name).toMatchObject({ type: 'object' })
    }
  })

  it('必需参数都出现在 properties 里（模型否则会一直传空）', () => {
    for (const tool of tools) {
      const required = (tool.parameters as { required?: string[] }).required ?? []
      const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      for (const name of required) {
        expect(Object.keys(props), `${tool.name}.${name}`).toContain(name)
      }
    }
  })

  it('带 plan 的工具，run 直接调用一定被拒（防止绕过授权解析）', async () => {
    const planned = tools.filter((t) => typeof t.plan === 'function')
    expect(planned.length).toBeGreaterThan(0)
    for (const tool of planned) {
      const result = await tool.run({}, {
        config: {} as never,
        record: (e) => ({ ...e, id: '', ts: '' })
      })
      expect(result.ok, tool.name).toBe(false)
    }
  })
})

describe('README 的边界说明与注册表一致', () => {
  const root = path.resolve(__dirname, '../..')
  const tools = createTools()
  const readme = (file: string): string =>
    readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n')

  /**
   * 为什么值得一条测试：README 是这套东西对外的全部承诺，而它里面**写着数字**。
   * 真实发生过：README 的项目结构里写「tools.ts 17 个工具」、边界一节写 23 个，
   * 设置页的「技术说明」写「主进程注册 10 个工具」外加一句「写入真实文件没有任何
   * 通路」——而那时 `write_document` 早就在往真实文档目录写了。讲边界的段落写错
   * 比不写更糟：读者会照着它去信任或去怀疑，两者都是错的。
   *
   * 设置页那段现在是**算出来的**（从 `tools:list` 取，见 SettingsPage 的 toolsStat），
   * 结构上不会再腐。README 是静态文本，只能靠这条测试拦住。
   */
  for (const file of ['README.md', 'README.zh.md']) {
    it(`${file}：每处「N 个工具 / N tools」都等于注册表的真实数量`, () => {
      const text = readme(file)
      const claims = [...text.matchAll(/(\d+)\s*(?:个工具|tools)/g)].map((m) => Number(m[1]))
      expect(claims.length, '一处都没找到，说明正则或文案变了，别让这条静悄悄地失效').toBeGreaterThan(0)
      for (const n of claims) expect(n, `${file} 写了 ${n} 个工具`).toBe(tools.length)
    })

    it(`${file}：分档表里每一档的工具名单与注册表一致`, () => {
      const text = readme(file)
      const byEffect = new Map<string, Set<string>>()
      for (const tool of tools) {
        const set = byEffect.get(tool.effect) ?? new Set<string>()
        set.add(tool.name)
        byEffect.set(tool.effect, set)
      }

      const rows = [...text.matchAll(/^\|\s*`(read|ui|write|install|destroy)`[^|]*\|([^|]*)\|/gm)]
      expect(rows.length, `${file} 里没找到分档表`).toBe(5)

      for (const row of rows) {
        const effect = row[1]
        const listed = new Set([...row[2].matchAll(/`([a-z][a-z_]+)`/g)].map((m) => m[1]))
        const actual = byEffect.get(effect) ?? new Set<string>()
        // 用排序后的数组比：集合相等时失败信息里能直接看出多了谁少了谁
        expect([...listed].sort(), `${file} 的 ${effect} 档`).toEqual([...actual].sort())
      }
    })
  }
})

/**
 * 每个会改动机器的工具都必须回答"事后查到了什么"。
 *
 * 两种合法做法：声明 verify（闸门在动作成功后统一调用），或者在结果里自己填
 * （装程序、卸载这类核对需要的上下文只有执行过程中才有）。两条都没有的话，
 * 闸门会填一条 unavailable——不至于静默，但那个工具从此就只是"回执说成了"。
 *
 * 所以这份名单是**故意的**：新增一个写类工具却忘了核对，这条会先红。
 */
describe('写操作的事后核对覆盖', () => {
  const SELF_VERIFIED = new Set([
    'install_app', // 核对要装之前抓的自启项基准线，事后补不了
    'uninstall_app', // 主体是用户在那个卸载窗口里点确认，当场查不到
    'delegate_to_agent', // 事实来自验收检查，不是回执
    'run_project' // 事实来自逐条验收计数
  ])

  it('改动机器的工具要么声明 verify，要么在名单里（自填结论）', () => {
    const mutating = createTools().filter((t) => ['write', 'destroy', 'install'].includes(t.effect))
    expect(mutating.length).toBeGreaterThan(0)
    const missing = mutating
      .filter((t) => typeof t.verify !== 'function' && !SELF_VERIFIED.has(t.name))
      .map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('名单里的工具必须真的存在（改了名字别忘了同步这里）', () => {
    const names = new Set(createTools().map((t) => t.name))
    for (const name of SELF_VERIFIED) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it('删除到回收站的核对是"再去 stat 一次"，不是复述回执', async () => {
    const tool = createTools().find((t) => t.name === 'delete_to_recycle')!
    expect(typeof tool.verify).toBe('function')
    // 路径不存在时它必须能自己给出结论，而不是要求宿主提供什么
    const outcome = await tool.verify!(
      { path: 'C:\\definitely-not-here\\nope.txt' },
      { config: {} as never, record: (e) => ({ ...e, id: '', ts: '' }) },
      { ok: true, summary: '' }
    )
    expect(outcome.state).toBe('confirmed')
    expect(outcome.fact).toContain('没有')
  })
})
