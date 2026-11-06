/**
 * IMAP 服务器自动推导：设置页只需要填地址 + 授权码。
 *
 * 已知服务商直接命中；认不出的域名退回 imap.<域名> 兜底。
 * 腾讯企业邮（imap.exmail.qq.com）这类自定义域名没有规律可猜，
 * 推导错了连不上时，在设置里展开「高级」手改一次即可（改完会随账号落盘）。
 */

/** 常见服务商：@域名 → IMAP 服务器（顺序匹配，先命中先用） */
const PROVIDER_HOSTS: Array<[RegExp, string]> = [
  [/@(qq|foxmail)\.com$/, 'imap.qq.com'],
  [/@(163|126)\.com$/, 'imap.163.com'],
  [/@(yeah\.net|188\.com)$/, 'imap.163.com'],
  [/@(gmail|googlemail)\.com$/, 'imap.gmail.com'],
  [/@(outlook|hotmail|live)\.(com|cn)$/, 'outlook.office365.com'],
  [/@(sina\.com|sina\.cn|vip\.sina\.com)$/, 'imap.sina.com'],
  [/@aliyun\.com$/, 'imap.aliyun.com'],
  [/@139\.com$/, 'imap.139.com'],
  [/@189\.cn$/, 'imap.189.cn']
]

/** 按邮箱地址推导 IMAP 服务器；地址不合法时返回空串（调用方兜底默认值） */
export function deriveImapHost(address: string): string {
  const domain = address.trim().toLowerCase().split('@')[1] ?? ''
  if (!domain) return ''
  for (const [re, host] of PROVIDER_HOSTS) {
    if (re.test(`@${domain}`)) return host
  }
  return `imap.${domain}`
}

/**
 * 是否命中已知服务商表：命中说明推导结果是权威的（不用再探测）；
 * 没命中说明是自定义域名（企业邮），推导只是猜测，要靠真实连接探测。
 */
export function isKnownProvider(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@')[1] ?? ''
  if (!domain) return false
  return PROVIDER_HOSTS.some(([re]) => re.test(`@${domain}`))
}
