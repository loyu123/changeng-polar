import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, DOC_SKELETONS } from '../../src/main/agent/prompt'

/**
 * 三种交付物的骨架。
 *
 * 这是这一版**唯一的新增能力**（不新增工具、不新增授权面），全部落在提示词上。
 * 所以它的测试不能只验"字符串里有这几个字"——那什么都没证明。
 * 要钉住的是**每一段里那句防止模型编造的话还在不在**：
 *
 * - 进展汇报：不许拿档案里那句"说明"当现状复述
 * - 资料摘要：读不了的材料必须逐条列出来，不能跳过不提
 * - 项目计划：开头就要标明这是判断，不是查到的事实
 *
 * 这三条正是把"汇报"和"我猜"分开的东西。删掉任何一句，交付物就退化成
 * 一段读起来很像、但没有依据的话——而这个项目一贯的口径是能确定的说确定。
 */

const env = {
  machineName: 'TEST-PC',
  userName: 'tester',
  osVersion: 'Windows 11',
  today: '2026-11-13',
  hasSearch: true,
  toolBudget: 5
}

describe('三种交付物都在', () => {
  it('三段标题都在（进展汇报 / 资料摘要 / 项目计划）', () => {
    expect(DOC_SKELETONS).toContain('进展汇报')
    expect(DOC_SKELETONS).toContain('资料摘要')
    expect(DOC_SKELETONS).toContain('项目计划')
  })

  it('每段都给了触发说法，模型才知道什么时候用', () => {
    expect(DOC_SKELETONS).toContain('进展到哪了')
    expect(DOC_SKELETONS).toContain('这些资料讲了什么')
    expect(DOC_SKELETONS).toContain('帮我规划')
  })

  it('拼进完整提示词里，不是写了个没人用的常量', () => {
    const prompt = buildSystemPrompt(env, '   - 测试能力')
    expect(prompt).toContain('三种交付物')
    expect(prompt).toContain('进展汇报')
    expect(prompt).toContain('项目计划')
  })
})

describe('每段里那句防编造的话', () => {
  /**
   * 这条是三种里最容易犯的：档案里那句话是用户很久以前填的，
   * 模型读到它就会当成"现在的状态"复述一遍，而它一个文件都没打开过。
   */
  it('进展汇报：不许把档案里的说明当现状', () => {
    expect(DOC_SKELETONS).toContain('不许拿项目档案')
    expect(DOC_SKELETONS).toContain('过时')
    expect(DOC_SKELETONS).toContain('我去看一下')
  })

  it('进展汇报：结尾要交代覆盖范围（看了什么、没看什么）', () => {
    expect(DOC_SKELETONS).toContain('覆盖范围')
    expect(DOC_SKELETONS).toContain('truncatedFromStart')
  })

  /**
   * 少报一份材料，比把读不了的当成"没这份"轻得多。
   * 静默跳过会让用户以为那批资料里没有这一份。
   */
  it('资料摘要：读不了的必须逐条列出来', () => {
    expect(DOC_SKELETONS).toContain('读不了的')
    expect(DOC_SKELETONS).toContain('逐条')
    expect(DOC_SKELETONS).toContain('不要跳过不提')
  })

  it('资料摘要：按主题归类，不是按文件名罗列', () => {
    expect(DOC_SKELETONS).toContain('按主题归类')
    expect(DOC_SKELETONS).toContain('不是摘要')
  })

  /**
   * 计划天然是判断。不标出来的话，用户会把"我建议先做 A"读成
   * "材料显示应该先做 A"——两句的可信度天差地别。
   */
  it('项目计划：开头标明这是判断，不是查到的事实', () => {
    expect(DOC_SKELETONS).toContain('这是你的判断')
    expect(DOC_SKELETONS).toContain('不是查到的事实')
  })

  it('项目计划：不许编日期和数据，缺信息要问', () => {
    expect(DOC_SKELETONS).toContain('不许编')
    expect(DOC_SKELETONS).toContain('估计')
    expect(DOC_SKELETONS).toContain('问他')
  })

  it('三种都要落成文件（用户要"准备好材料"就是拿到文件）', () => {
    expect(DOC_SKELETONS).toContain('write_document')
    expect(DOC_SKELETONS).toContain('path')
  })
})

describe('新工具在提示词里也有用法规则', () => {
  /**
   * 0.9.1 / 0.9.2 加了 list_files 和 read_log_tail，但「工具使用规则」那一段
   * 一条都没提它们——模型只能从工具描述里猜什么时候用。而这一段的写法是
   * 「用户说 X 用 Y」，缺了它，问进展时模型很可能还是会去调 read_file。
   */
  it('list_files 与 read_log_tail 都写进了工具使用规则', () => {
    const prompt = buildSystemPrompt(env, '   - 测试能力')
    expect(prompt).toContain('list_files')
    expect(prompt).toContain('read_log_tail')
  })

  it('明确说了"不要用 read_file 硬凑"，并给了理由（答案在末尾）', () => {
    const prompt = buildSystemPrompt(env, '   - 测试能力')
    expect(prompt).toMatch(/不要用 read_file 硬凑/)
    expect(prompt).toMatch(/末尾/)
  })

  it('被作用域拒绝时不许用别的路径绕（否则那个边界形同虚设）', () => {
    const prompt = buildSystemPrompt(env, '   - 测试能力')
    expect(prompt).toContain('不要用 read_file 或别的路径绕')
  })
})

describe('提示词整体', () => {
  it('骨架插在「回答格式」之前，不是接在最后面', () => {
    const prompt = buildSystemPrompt(env, '   - 测试能力')
    expect(prompt.indexOf('三种交付物')).toBeLessThan(prompt.indexOf('## 回答格式'))
  })

  it('项目档案为空时骨架照样在（用户还没登记项目也要能规划）', () => {
    const prompt = buildSystemPrompt({ ...env, projects: '' }, '   - 测试能力')
    expect(prompt).toContain('三种交付物')
  })

  it('没有反引号残留（提示词是模板串，反引号会把它截断）', () => {
    expect(DOC_SKELETONS).not.toContain('`')
  })
})

describe('工具预算撑得下三种骨架', () => {
  /**
   * 骨架里「资料摘要」要读多份材料再加一次落盘。原来预算是 5 步，
   * 按"读完一份看结果再决定读哪份"这种常见节奏，5 步只够四份材料 + 落盘。
   * 这里钉住"至少比原来的 5 多"，免得有人顺手改回去而骨架悄悄用不了。
   */
  it('预算至少 6 步（5 步读不完一批材料）', async () => {
    const { TOOL_BUDGET_STEPS } = await import('../../src/main/agent/agent')
    expect(TOOL_BUDGET_STEPS).toBeGreaterThanOrEqual(6)
  })

  it('提示词里写的步数与常量一致（两处各写一个数会让模型按错的那个停）', async () => {
    const { TOOL_BUDGET_STEPS } = await import('../../src/main/agent/agent')
    const prompt = buildSystemPrompt({ ...env, toolBudget: TOOL_BUDGET_STEPS }, '   - 测试能力')
    expect(prompt).toContain(`最多 ${TOOL_BUDGET_STEPS} 步`)
  })
})
