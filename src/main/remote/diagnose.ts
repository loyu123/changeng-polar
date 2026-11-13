import { networkInterfaces } from 'node:os'
import { runPs } from '../node/ps'
import { classifyAddresses, type AddressClass } from './addressing'

/**
 * 「手机连不上」的自检。
 *
 * 为什么要有这个东西：失败的表象全都一样——手机上转圈、或者干脆打不开页面。
 * 但原因分散在四个地方（总闸没开、只绑了回环、不在同一网络、防火墙拦了），
 * 而用户能看到的界面上一个都不显示。原来只能靠 "netstat 一看就露馅"（见 0.8.0
 * 那次真机调试的记录），那是开发者的排查方式，不是用户的。
 *
 * 设计上照这个仓库一贯的口径：**能确定的说确定，不能确定的说不知道**。
 * 防火墙就是典型——Windows 11 上非管理员读不出「端口 7474 有没有放行规则」
 * （`Get-NetFirewallPortFilter` 的批量枚举直接 AccessDenied，逐条问要 33 秒），
 * 所以这里只报"防火墙开着"并给出放行命令，不猜"应该没问题"。
 * 猜错的代价是用户照着界面上那个绿勾继续查别处。
 */

export type DiagLevel = 'ok' | 'warn' | 'fail' | 'unknown'

export interface DiagItem {
  level: DiagLevel
  title: string
  detail: string
  /** 用户可以直接照做的一步（一句话）；没有就不给 */
  action?: string
  /**
   * 可以直接复制的命令，和 action 分开。
   *
   * 分开是因为界面要把它排成等宽体：混在一句话里，用户得自己从中文里
   * 把命令挑出来才能复制，而这条命令是要贴进**管理员** PowerShell 的。
   */
  command?: string
}

export interface FirewallProfile {
  name: string
  enabled: boolean
}

/** 探到的机器事实。纯数据，不在这里做判断 */
export interface RemoteSnapshot {
  enabled: boolean
  /** 实际绑定的地址；没监听时为 null */
  boundHost: string | null
  port: number
  addresses: AddressClass[]
  devices: number
  listeners: number
  error?: string
  /** 读不到（权限不足）时为空数组——空数组的含义是"不知道"，不是"防火墙关了" */
  firewallProfiles: FirewallProfile[]
  /** 本机装了 Tailscale 客户端（装了 ≠ 连上了） */
  tailscaleInstalled: boolean
}

/**
 * 防火墙放行命令。
 *
 * 用 `netsh` 而不是 `New-NetFirewallRule`：前者在任何 PowerShell 版本上都在，
 * 而且这条命令要被用户复制到**管理员**窗口里执行，越短越不容易抄错。
 * 远程地址限到本机所在网段是故意的——放行给"任何"等于把这个端口交给整个咖啡馆。
 */
export function allowCommand(port: number): string {
  return `netsh advfirewall firewall add rule name="长庚远程 ${port}" dir=in action=allow protocol=TCP localport=${port} remoteip=localsubnet`
}

/**
 * 把快照变成给人看的一串结论。
 *
 * 顺序是有讲究的：**先说拦路的，再说可选的**。用户打开这个面板是为了解决
 * "连不上"，如果第一行写"你还没装 Tailscale"，他会去装 Tailscale，
 * 而真正的问题是局域网模式没开。
 */
export function diagnose(s: RemoteSnapshot): DiagItem[] {
  const items: DiagItem[] = []
  const lan = s.addresses.filter((a) => a.kind === 'lan')
  const tailnet = s.addresses.filter((a) => a.kind === 'tailnet')

  // ---- 1. 总闸 ----
  if (s.error) {
    items.push({
      level: 'fail',
      title: '远程入口启动失败',
      detail: s.error,
      action: `端口 ${s.port} 可能被别的程序占着。用 netstat -ano | findstr :${s.port} 看是谁。`
    })
    return items
  }
  if (!s.enabled) {
    items.push({
      level: 'fail',
      title: '远程入口没开',
      detail: '服务没在监听，手机连任何地址都不会有响应。',
      action: '点上面的「开启远程入口」。'
    })
    return items
  }

  // ---- 2. 绑定地址：这一条是最常见的"连不上" ----
  if (s.boundHost === '127.0.0.1') {
    if (tailnet.length > 0) {
      // 绑回环 + 有 tailnet 地址：这条是**正常且推荐的**组合，
      // 前提是用 tailscale serve 把 tailnet 的 HTTPS 转发到回环。
      items.push({
        level: 'warn',
        title: '只监听本机回环（127.0.0.1）',
        detail: `手机直接从局域网连不进来。本机有 Tailscale 地址 ${tailnet[0].ip}，如果已经配了 tailscale serve，从手机上是能连的；没配就连不上。`,
        action: '要么在下面开启局域网访问，要么按 README 的 Tailscale 一节配 serve。'
      })
    } else {
      items.push({
        level: 'fail',
        title: '只监听本机回环（127.0.0.1）',
        detail: '这个地址只有电脑自己能用，同一 WiFi 下的手机也连不上——手机发来的包到不了这个端口。',
        action: '在下面打开「监听所有网卡（0.0.0.0）」。'
      })
    }
  } else if (s.boundHost === '0.0.0.0') {
    items.push({
      level: 'ok',
      title: '监听所有网卡（0.0.0.0）',
      detail: `端口 ${s.port} 对局域网可达，手机有路可走。`
    })
  } else {
    items.push({
      level: 'fail',
      title: '没有在监听',
      detail: '服务对象是启用状态，但没有实际的监听套接字——重启一下远程入口。',
      action: '关掉再打开一次远程入口。'
    })
  }

  // ---- 3. 手机该输哪个地址 ----
  if (lan.length > 0) {
    items.push({
      level: 'ok',
      title: '局域网地址',
      detail: `同一个 WiFi 下，手机浏览器打开：${lan.map((a) => `http://${a.ip}:${s.port}/`).join(' 或 ')}`
    })
  } else {
    items.push({
      level: 'warn',
      title: '没有局域网地址',
      detail: '这台机器现在没有可用的局域网 IPv4（网线没插、WiFi 没连，或者只拿到了 169.254 的自分配地址）。手机没法用局域网连进来。',
      action: '连上 WiFi 或网线后再看这里。'
    })
  }

  // ---- 4. 外网：Tailscale ----
  if (tailnet.length > 0) {
    items.push({
      level: 'ok',
      title: 'Tailscale 地址（外面也能连）',
      detail: `手机也登录同一个 Tailscale 账号后，打开：${tailnet.map((a) => `http://${a.ip}:${s.port}/`).join(' 或 ')}`
    })
  } else if (s.tailscaleInstalled) {
    items.push({
      level: 'warn',
      title: 'Tailscale 装了但没连上',
      detail: '检测到 Tailscale 客户端，但没有拿到 100.64.0.0/10 的地址——多半是没登录，或者连接被关掉了。',
      action: '在托盘里打开 Tailscale 并确认已登录。'
    })
  } else if (lan.length === 0) {
    // 只有"局域网也不可用"时才提 Tailscale，否则是噪音
    items.push({
      level: 'unknown',
      title: '没有外网入口',
      detail: '现在只能在同一个 WiFi 下用。要出门也能连，需要装一个隧道。',
      action: '见 README 的「远程访问」一节（Tailscale 最省事，不需要公网 IP）。'
    })
  }

  // ---- 5. 防火墙：只报到"开着"，不假装知道有没有放行 ----
  const on = s.firewallProfiles.filter((p) => p.enabled)
  if (s.firewallProfiles.length === 0) {
    items.push({
      level: 'unknown',
      title: '防火墙状态未知',
      detail: '读不到 Windows 防火墙配置（需要管理员权限）。如果地址和模式都对、手机还是连不上，先怀疑这一项。',
      action: '用管理员 PowerShell 执行一次：',
      command: allowCommand(s.port)
    })
  } else if (on.length > 0) {
    items.push({
      level: 'warn',
      title: '防火墙开着',
      detail: `${on.map((p) => p.name).join(' / ')} 配置档启用中。非管理员读不出「端口 ${s.port} 有没有放行规则」，所以这一项无法确认——不是已知有问题，也不是已知没问题。手机连不上时，先把它排除掉：`,
      action: '管理员 PowerShell 里执行一次：',
      command: allowCommand(s.port)
    })
  } else {
    items.push({
      level: 'ok',
      title: '防火墙已关闭',
      detail: '三个配置档都没启用，不会有入站拦截。'
    })
  }

  // ---- 6. 配对 ----
  if (s.devices === 0) {
    items.push({
      level: 'warn',
      title: '还没有配对过设备',
      detail: '手机能打开页面，但每个请求都会被拒（401）——配对码换 token 这一步没做过。',
      action: '点「生成配对码」，在手机上输入（2 分钟内有效、用一次作废）。'
    })
  } else {
    items.push({
      level: 'ok',
      title: `已配对 ${s.devices} 台设备`,
      detail:
        s.listeners > 0
          ? `当前有 ${s.listeners} 个手机连着事件流，链路是通的。`
          : '当前没有手机连着事件流（关着页面就是这样，不是故障）。'
    })
  }

  return items
}

/**
 * 读 Windows 防火墙三个配置档的开关状态。
 *
 * 只读、不需要管理员。读不到就返回空数组——调用方据此说"未知"，
 * 而不是当成"防火墙是关的"。
 */
const FW_PS = String.raw`
$rows = @()
foreach ($p in (Get-NetFirewallProfile -ErrorAction SilentlyContinue)) {
  $rows += [pscustomobject]@{ name = [string]$p.Name; enabled = [bool]$p.Enabled }
}
[IO.File]::WriteAllText($Out, ($rows | ConvertTo-Json -Depth 3 -Compress), [Text.UTF8Encoding]::new($false))
`

/**
 * Tailscale 是否装在这台机器上（装没装和连没连上是两件事，见 diagnose）。
 *
 * 装好的 Tailscale 会把自己加进 PATH，所以 `Get-Command` 是主判据；
 * 两条常见安装路径是兜底——刚装完还没重开终端时 PATH 里没有它。
 * 这里用 `[Environment]::GetEnvironmentVariable` 取 Program Files (x86)，
 * 而不是 `${env:ProgramFiles(x86)}`：后者写在 JS 模板字符串里会被当成插值。
 */
const TS_PS = String.raw`
$found = $false
if (Get-Command tailscale -ErrorAction SilentlyContinue) { $found = $true }
if (-not $found) {
  $dirs = @([Environment]::GetEnvironmentVariable('ProgramFiles'), [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))
  foreach ($d in $dirs) {
    if (-not $d) { continue }
    if (Test-Path (Join-Path $d 'Tailscale\tailscale.exe')) { $found = $true }
  }
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json @{ installed = $found } -Compress), [Text.UTF8Encoding]::new($false))
`

export async function readFirewallProfiles(): Promise<FirewallProfile[]> {
  try {
    const raw = await runPs(FW_PS)
    if (!raw || raw === 'null') return []
    const parsed = JSON.parse(raw) as FirewallProfile | FirewallProfile[]
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: p.name, enabled: p.enabled === true }))
  } catch {
    return []
  }
}

export async function detectTailscale(): Promise<boolean> {
  try {
    const raw = await runPs(TS_PS)
    if (!raw) return false
    return (JSON.parse(raw) as { installed?: boolean }).installed === true
  } catch {
    return false
  }
}

/** 本机的 IPv4 地址（分类后） */
export function localAddresses(): AddressClass[] {
  const infos: Array<{ address: string; family: string; internal: boolean }> = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      infos.push({ address: info.address, family: String(info.family), internal: info.internal })
    }
  }
  return classifyAddresses(infos)
}
