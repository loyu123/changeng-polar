import { describe, expect, it } from 'vitest'
import { diffStartupNames } from '../../src/main/node/registry'
import { createTools } from '../../src/main/agent/tools'

/**
 * 装完核对这条链路上"能在单测里锁住"的部分。
 *
 * 真正的核对要调 winget、读注册表（见 scripts/ 下的冒烟脚本），单测只锁三件
 * 会悄悄退回去的事：自启项差集的语义、卡上有没有把静默安装的代价说清楚、
 * 台账行有没有带安装时间与来源。
 */

describe('diffStartupNames', () => {
  it('只报差异，不动没变的部分', () => {
    expect(diffStartupNames(['A', 'B'], ['A', 'B'])).toEqual({ added: [], removed: [] })
  })

  it('新冒出来的自启项进 added', () => {
    expect(diffStartupNames(['A'], ['A', '网易云音乐'])).toEqual({
      added: ['网易云音乐'],
      removed: []
    })
  })

  it('消失的自启项单列，不并进 added', () => {
    // 安装不该让任何东西消失：混在一起会变成"装了个软件，多了一条、少了一条"看不出来
    expect(diffStartupNames(['A', 'B'], ['A'])).toEqual({ added: [], removed: ['B'] })
  })

  it('同名多次只算一次', () => {
    expect(diffStartupNames(['A'], ['A', 'A', 'B', 'B'])).toEqual({ added: ['B'], removed: [] })
  })
})

describe('install_app 授权卡文案', () => {
  const tool = createTools().find((t) => t.name === 'install_app')!

  it('卡上必须写明：静默安装会让默认勾选直接生效', () => {
    // 原来写的是"不在桌面留安装包"，恰好说反了：--silent 的代价正是取消不了任何勾选。
    // 用户在批准时看不到安装器界面，这句话是唯一的信息来源
    expect(tool.description).toContain('静默')
    expect(tool.label).toContain('安装')
  })

  it('提示模型：核对没对上就不能说装好了', () => {
    // 否则 winget 报成功、机器上没有，模型会替 winget 宣布装好了
    expect(tool.description).toMatch(/核对没对上时必须如实说/)
  })

  it('描述里承诺了装后核对（否则模型不知道结果里有这一项）', () => {
    expect(tool.description).toMatch(/自动核对/)
  })
})

describe('应用台账字段', () => {
  const tool = createTools().find((t) => t.name === 'list_installed_apps')!

  it('描述里交代了安装时间与"是不是管家装的"', () => {
    // 台账要能回答"这个是管家装的吗、什么时候装的"，两个字段缺一个都答不了
    expect(tool.description).toContain('installedByButler')
    expect(tool.description).toContain('什么时候装的')
  })
})
