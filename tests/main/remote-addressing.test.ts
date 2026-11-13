import { describe, expect, it } from 'vitest'
import { classifyAddresses, isTailnetAddress, urlsFor } from '../../src/main/remote/addressing'

/**
 * 「手机该输哪个地址」。
 *
 * 这层的错法都很安静：给错一个地址，用户照着输进去，得到的是"连不上"——
 * 和他路由器没连、防火墙拦了、程序没开一模一样。所以判据要钉死：
 * 特别是 Tailscale 那段，不能用"100 开头"糊过去。
 */

const iface = (address: string, extra: Partial<{ family: string; internal: boolean }> = {}) => ({
  address,
  family: 'IPv4',
  internal: false,
  ...extra
})

describe('isTailnetAddress', () => {
  it('认 100.64.0.0/10 的两端', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
    expect(isTailnetAddress('100.100.10.20')).toBe(true)
  })

  it('刚出界的两侧不算', () => {
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.0')).toBe(false)
  })

  /**
   * 这条是重点：100.1.1.1 可以是某个真实网络里的设备。
   * 按"100 开头"判会把它当成 Tailscale 地址显示给用户，
   * 用户在外面打开它、连不上，然后去查 Tailscale 的毛病——而毛病在这里。
   */
  it('100 开头的其他网段不算（100.1.1.1 不是 tailnet）', () => {
    expect(isTailnetAddress('100.1.1.1')).toBe(false)
    expect(isTailnetAddress('100.0.0.1')).toBe(false)
  })

  it('不是 IPv4 形状的一律不算', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(false)
    expect(isTailnetAddress('192.168.1')).toBe(false)
    expect(isTailnetAddress('')).toBe(false)
    expect(isTailnetAddress('100.64.0.256')).toBe(false)
    expect(isTailnetAddress('100.64.0.x')).toBe(false)
  })
})

describe('classifyAddresses', () => {
  it('按网段分成局域网和 tailnet，保持网卡顺序', () => {
    const out = classifyAddresses([iface('192.168.6.197'), iface('100.101.7.7'), iface('10.0.0.5')])
    expect(out).toEqual([
      { ip: '192.168.6.197', kind: 'lan' },
      { ip: '100.101.7.7', kind: 'tailnet' },
      { ip: '10.0.0.5', kind: 'lan' }
    ])
  })

  it('丢掉回环和 169.254 自分配地址', () => {
    const out = classifyAddresses([
      iface('127.0.0.1', { internal: true }),
      iface('169.254.48.30'),
      iface('192.168.1.4')
    ])
    expect(out).toEqual([{ ip: '192.168.1.4', kind: 'lan' }])
  })

  it('丢掉 IPv6（拼进 http:// 里的收益抵不过一个可能出错的地方）', () => {
    const out = classifyAddresses([iface('fe80::1', { family: 'IPv6' }), iface('192.168.1.4')])
    expect(out.map((a) => a.ip)).toEqual(['192.168.1.4'])
  })

  it('同一地址出现两次只留一个（Tailscale 与物理网卡同时上报时会发生）', () => {
    const out = classifyAddresses([iface('100.1.2.3'), iface('100.1.2.3')])
    expect(out).toHaveLength(1)
  })

  it('认数字型 family（Node 新版本给 4 而不是 "IPv4"）', () => {
    const out = classifyAddresses([iface('192.168.1.9', { family: '4' })])
    expect(out).toEqual([{ ip: '192.168.1.9', kind: 'lan' }])
  })

  it('什么都不给就是空——不是"随便猜一个"', () => {
    expect(classifyAddresses([])).toEqual([])
  })
})

describe('urlsFor', () => {
  it('端口跟着实际绑定的走，不写死', () => {
    const urls = urlsFor([{ ip: '192.168.6.197', kind: 'lan' }], 8123)
    expect(urls).toEqual([{ url: 'http://192.168.6.197:8123/', kind: 'lan' }])
  })

  it('两类地址都带上，各自标明来源', () => {
    const urls = urlsFor(
      [
        { ip: '192.168.6.197', kind: 'lan' },
        { ip: '100.101.7.7', kind: 'tailnet' }
      ],
      7474
    )
    expect(urls.map((u) => u.kind)).toEqual(['lan', 'tailnet'])
    expect(urls[1].url).toBe('http://100.101.7.7:7474/')
  })
})
