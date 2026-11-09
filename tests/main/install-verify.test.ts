import { describe, expect, it } from 'vitest'
import { diffStartupNames } from '../../src/main/node/registry'
import { createTools } from '../../src/main/agent/tools'

/**
 * 装完核对这条链路上"能在单测里锁住"的部分。
 *
 * 真正的核对要调 winget、读注册表（见 scripts/ 下的冒烟脚本），单测只锁三件
 * 会悄悄退回去的事：自启项差集的语义、卡上有没有把安装的代价说清楚、
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

  it('描述里写明会弹安装器、要等用户点完，并交代用户取消不算失败', () => {
    // 曾经这里断言的是"静默"：那时真的用 --silent，代价是默认勾选直接生效。
    // 现在一律交互式，描述必须跟着改成"界面会弹出来、等他点完"，
    // 否则模型会以为装完立刻返回，用户还在点它就开始报结果
    expect(tool.description).toContain('安装界面')
    expect(tool.description).not.toContain('静默安装')
    expect(tool.description).toMatch(/取消/)
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
