import { describe, expect, it } from 'vitest'
import { allowCommand, diagnose, type RemoteSnapshot } from '../../src/main/remote/diagnose'

/**
 * 「手机连不上」自检的判断。
 *
 * 测的不是文案，是**每条结论的触发条件**和**不能出现的结论**。两类错误都要钉住：
 * - 该报错的没报（用户照着绿勾去查别处）
 * - 不该报错的报了（用户去改一个本来没问题的地方，改完还是连不上）
 *
 * 防火墙那条尤其特殊：非管理员读不出放行规则，所以它的正确输出是
 * 「无法确认」+ 命令，**不是** ok，也**不是** fail。
 */

const base: RemoteSnapshot = {
  enabled: true,
  boundHost: '0.0.0.0',
  port: 7474,
  addresses: [{ ip: '192.168.6.197', kind: 'lan' }],
  devices: 1,
  listeners: 0,
  firewallProfiles: [{ name: 'Private', enabled: true }],
  tailscaleInstalled: false
}

const snap = (patch: Partial<RemoteSnapshot>): RemoteSnapshot => ({ ...base, ...patch })
const find = (items: ReturnType<typeof diagnose>, title: string) => items.find((i) => i.title === title)
const levels = (items: ReturnType<typeof diagnose>) => items.map((i) => i.level)

describe('diagnose：拦路的几条', () => {
  it('没开启时只给一条结论，不再往下罗列（后面每条都无意义）', () => {
    const items = diagnose(snap({ enabled: false, boundHost: null }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ level: 'fail', title: '远程入口没开' })
  })

  it('启动失败时把原因原样说出来，并指向端口占用', () => {
    const items = diagnose(snap({ enabled: false, boundHost: null, error: 'EADDRINUSE' }))
    expect(items).toHaveLength(1)
    expect(items[0].level).toBe('fail')
    expect(items[0].detail).toContain('EADDRINUSE')
    expect(items[0].action).toContain(':7474')
  })

  /**
   * 最常见的那一种：服务开着、看起来正常，但只绑在回环上。
   * 这是"手机上转圈、电脑上一切正常"的头号原因。
   */
  it('只绑回环是 fail，并指出具体该点哪个开关', () => {
    const items = diagnose(snap({ boundHost: '127.0.0.1' }))
    const item = find(items, '只监听本机回环（127.0.0.1）')
    expect(item?.level).toBe('fail')
    expect(item?.action).toContain('监听所有网卡')
  })

  it('绑回环 + 有 tailnet 地址时降级为 warn（tailscale serve 是合法用法）', () => {
    const items = diagnose(
      snap({
        boundHost: '127.0.0.1',
        addresses: [{ ip: '100.101.7.7', kind: 'tailnet' }],
        tailscaleInstalled: true
      })
    )
    const item = find(items, '只监听本机回环（127.0.0.1）')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('100.101.7.7')
  })

  it('启用但没有监听套接字时如实说，不假装正常', () => {
    const items = diagnose(snap({ boundHost: null }))
    expect(find(items, '没有在监听')?.level).toBe('fail')
  })
})

describe('diagnose：地址', () => {
  it('给出局域网地址时带上实际端口', () => {
    const item = find(diagnose(snap({ port: 9000 })), '局域网地址')
    expect(item?.detail).toContain('http://192.168.6.197:9000/')
  })

  it('没有局域网地址时是 warn，不是 fail（接了 Tailscale 也能用）', () => {
    const items = diagnose(snap({ addresses: [{ ip: '100.64.0.9', kind: 'tailnet' }], tailscaleInstalled: true }))
    expect(find(items, '没有局域网地址')?.level).toBe('warn')
  })

  it('有 tailnet 地址时把它当成"外面也能连"的正面结论', () => {
    const items = diagnose(
      snap({ addresses: [{ ip: '192.168.6.197', kind: 'lan' }, { ip: '100.64.0.9', kind: 'tailnet' }] })
    )
    expect(find(items, 'Tailscale 地址（外面也能连）')).toMatchObject({ level: 'ok' })
  })

  it('装了 Tailscale 却没拿到地址 → 指出没连上，而不是推荐去装', () => {
    const items = diagnose(snap({ tailscaleInstalled: true }))
    const item = find(items, 'Tailscale 装了但没连上')
    expect(item?.level).toBe('warn')
    expect(item?.action).toContain('已登录')
  })

  /**
   * 局域网好好的时候不该提 Tailscale：那是噪音，会把人引到一条
   * 他根本不需要的路上（装客户端、注册账号）。
   */
  it('局域网可用且没装 Tailscale 时不出现外网那一条', () => {
    const items = diagnose(snap({}))
    expect(find(items, '没有外网入口')).toBeUndefined()
    expect(find(items, 'Tailscale 装了但没连上')).toBeUndefined()
  })

  it('局域网也不可用、又没装 Tailscale 时才提外网入口', () => {
    const items = diagnose(snap({ addresses: [], tailscaleInstalled: false }))
    expect(find(items, '没有外网入口')?.level).toBe('unknown')
  })
})

describe('diagnose：防火墙（只报到"开着"，不假装知道）', () => {
  it('读不到配置时说未知，并给出命令', () => {
    const items = diagnose(snap({ firewallProfiles: [] }))
    const item = find(items, '防火墙状态未知')
    expect(item?.level).toBe('unknown')
    expect(item?.command).toContain('netsh')
  })

  it('防火墙开着 → warn + 命令，绝不能是 ok', () => {
    const items = diagnose(snap({}))
    const item = find(items, '防火墙开着')
    expect(item?.level).toBe('warn')
    expect(item?.command).toBe(allowCommand(7474))
    // 文案里必须写明"无法确认"，否则用户会读成"没问题"
    expect(item?.detail).toContain('无法确认')
  })

  it('所有配置档都关着才算 ok', () => {
    const items = diagnose(snap({ firewallProfiles: [{ name: 'Private', enabled: false }] }))
    expect(find(items, '防火墙已关闭')?.level).toBe('ok')
  })

  it('只要有一个配置档开着就按"开着"处理', () => {
    const items = diagnose(
      snap({
        firewallProfiles: [
          { name: 'Domain', enabled: false },
          { name: 'Public', enabled: true }
        ]
      })
    )
    expect(find(items, '防火墙开着')?.detail).toContain('Public')
  })

  it('放行命令限本机网段，不是任何来源', () => {
    expect(allowCommand(7474)).toContain('remoteip=localsubnet')
    expect(allowCommand(7474)).not.toContain('remoteip=any')
  })
})

describe('diagnose：配对', () => {
  it('没配对过时说明 401 的原因，并提醒码会过期', () => {
    const item = find(diagnose(snap({ devices: 0 })), '还没有配对过设备')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('401')
    expect(item?.action).toContain('2 分钟')
  })

  it('有设备连着事件流时是链路通的证据', () => {
    const item = find(diagnose(snap({ devices: 2, listeners: 1 })), '已配对 2 台设备')
    expect(item?.detail).toContain('1 个手机连着')
  })

  it('没有事件流连接不算故障，要明说', () => {
    const item = find(diagnose(snap({ devices: 1, listeners: 0 })), '已配对 1 台设备')
    expect(item?.detail).toContain('不是故障')
  })
})

describe('diagnose：顺序与整体', () => {
  /**
   * 用户点自检是为了解决"连不上"。第一行必须是拦路的那条——
   * 如果第一行是"你还没装 Tailscale"，他会去装 Tailscale。
   */
  it('拦路的排在前面，可选的排在后面', () => {
    const items = diagnose(snap({ boundHost: '127.0.0.1', addresses: [], devices: 0 }))
    expect(items[0].level).toBe('fail')
    expect(items[0].title).toContain('回环')
  })

  it('每个 level 都是四种之一（界面按这四个值给颜色，多一种就是白屏）', () => {
    const all = [
      ...diagnose(snap({})),
      ...diagnose(snap({ enabled: false, boundHost: null })),
      ...diagnose(snap({ boundHost: '127.0.0.1', addresses: [], devices: 0, firewallProfiles: [] }))
    ]
    for (const item of all) expect(['ok', 'warn', 'fail', 'unknown']).toContain(item.level)
    expect(levels(all).length).toBeGreaterThan(0)
  })

  it('每条都必须有标题和说明（空字符串会渲染成一行空白，看起来像卡了）', () => {
    for (const item of diagnose(snap({}))) {
      expect(item.title.trim()).not.toBe('')
      expect(item.detail.trim()).not.toBe('')
    }
  })
})
