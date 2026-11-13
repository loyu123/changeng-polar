/**
 * 远程入口的「手机该打开哪个地址」。
 *
 * 分离出来是为了让它能被测试：地址分类是纯函数，网络接口由调用方传进来。
 * 原来这段逻辑长在 service.ts 里，且只能给出「本机回环」和「局域网 IP」两种答案——
 * 装过 Tailscale 的机器上，真正能让手机在外面连上来的那个 100.x.x.x 地址
 * 从来没被显示过，用户只能自己去 `tailscale ip` 里找。
 */

/** 一个可以给手机用的地址，以及它属于哪类网络 */
export interface AddressClass {
  /** IPv4 地址 */
  ip: string
  /**
   * - `lan`：局域网（同一 WiFi 下手机能用；不装任何东西）
   * - `tailnet`：Tailscale 虚拟网（手机装了 Tailscale 并登录同一账号，在外面也能用）
   */
  kind: 'lan' | 'tailnet'
}

/**
 * Tailscale 是否占用了这个地址。
 *
 * Tailscale 从 **100.64.0.0/10** 里取地址——这是 RFC 6598 的运营商级 NAT 段，
 * 家庭/办公局域网不会用它，所以判据只能是这一段，不能是"100 开头"：
 * `100.1.1.1` 可能是某个真实网络里的设备，把它当成 tailnet 会给出一个
 * 手机根本连不上的地址，而用户会以为是 Tailscale 出了问题。
 *
 * 只判 IPv4：Tailscale 的 IPv6（`fd7a:115c:a1e0::/48`）对手机连接不是必需的，
 * 而把 IPv6 拼进 `http://[fd7a:...]:7474` 这种 URL 里没有任何好处。
 */
export function isTailnetAddress(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => Number(p))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = octets
  // 100.64.0.0/10 → 100.64.0.0 ~ 100.127.255.255
  return a === 100 && b >= 64 && b <= 127
}

/**
 * 把网卡清单分成「局域网」和「Tailscale」两类。
 *
 * 回环和 169.254（DHCP 失败时的自分配地址）都丢掉：前者的手机永远连不上，
 * 后者连本身机都不可靠——把它显示出来只会让用户照着输一遍、然后失败。
 *
 * 顺序保持网卡顺序：Windows 上无线网卡通常排在前面，那正是用户要的那个。
 */
export function classifyAddresses(infos: Array<{ address: string; family: string; internal: boolean }>): AddressClass[] {
  const out: AddressClass[] = []
  const seen = new Set<string>()
  for (const info of infos) {
    if (info.internal) continue
    // Node 的新版本用数字 4，老版本用字符串 'IPv4'，两种都认
    if (String(info.family) !== 'IPv4' && String(info.family) !== '4') continue
    const ip = info.address
    if (seen.has(ip)) continue
    if (ip.startsWith('169.254.')) continue
    seen.add(ip)
    out.push({ ip, kind: isTailnetAddress(ip) ? 'tailnet' : 'lan' })
  }
  return out
}

/** 手机能打开的地址；端口跟着实际绑定的走，不写死 */
export function urlsFor(addresses: AddressClass[], port: number): Array<{ url: string; kind: 'lan' | 'tailnet' }> {
  return addresses.map((a) => ({ url: `http://${a.ip}:${port}/`, kind: a.kind }))
}
