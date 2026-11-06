import { ImapFlow, type MailboxLockObject } from 'imapflow'
import type { ButlerConfig, MailAccount, MailConfig } from '../../shared/types'
import { deriveImapHost, isKnownProvider } from '../../shared/mail-hosts'
import { findTextPart, stripTags } from './html'

/**
 * 邮箱只读接入（IMAP），支持多账号。
 *
 * 边界（改之前先看这几条）：
 * - 只读：邮箱以 readOnly 打开，FETCH 不带 BODY.PEEK 之外的写动作，已读标记不会被改动
 * - 不发信、不删信、不移动、不改文件夹——那些是另一个授权级别的事
 * - 授权码不是登录密码：QQ 邮箱在 设置→账户→POP3/IMAP/SMTP 服务 里生成
 * - 授权码落在本地 config.json，与应用内其他密钥同等待遇，不上传
 * - 多账号：mailAccounts 非空时生效（第一个为默认账号）；否则回落到旧版单账号 mail
 */

function normalizeLegacy(mail: MailConfig): MailAccount | null {
  if (!mail?.address.trim() || !mail.authCode.trim()) return null
  return {
    id: 'default',
    label: mail.address.trim(),
    address: mail.address.trim(),
    authCode: mail.authCode,
    host: mail.host.trim() || deriveImapHost(mail.address) || 'imap.qq.com',
    port: mail.port || 993
  }
}

/** 配置里所有已填好的账号（按用户配置顺序，第一个是默认账号） */
function accountsOf(config: ButlerConfig): MailAccount[] {
  const list = (config.mailAccounts ?? [])
    .filter((a) => a?.address?.trim() && a?.authCode?.trim())
    .map((a) => ({
      id: a.id,
      label: a.label?.trim() || a.address.trim(),
      address: a.address.trim(),
      authCode: a.authCode,
      // host 留空 = 按地址域名自动推导；推导不出的（企业邮箱）在设置里展开「高级」手填
      host: a.host?.trim() || deriveImapHost(a.address) || 'imap.qq.com',
      port: a.port || 993
    }))
  if (list.length > 0) return list
  const legacy = normalizeLegacy(config.mail ?? { address: '', authCode: '', host: '', port: 0 })
  return legacy ? [legacy] : []
}

/**
 * 解析出一个可用账号：不传 ref 用默认（第一个）；ref 可以是 id / 显示名 / 地址。
 * 解析不到时返回 null——调用方必须如实说"账号不存在"，不能偷偷换默认账号。
 */
export function resolveMailAccount(config: ButlerConfig, ref?: string): MailAccount | null {
  const list = accountsOf(config)
  if (list.length === 0) return null
  if (!ref?.trim()) return list[0]
  const needle = ref.trim().toLowerCase()
  return (
    list.find((a) => a.id.toLowerCase() === needle || (a.label ?? '').toLowerCase() === needle || a.address.toLowerCase() === needle) ??
    null
  )
}

/** 认证被拒的特征（连接层面就能区分，不用等命令返回） */
const AUTH_FAIL_RE = /AUTHENTICATIONFAILED|authentication|LOGIN|invalid credentials|password|login fail|account is abnormal/i

/**
 * 认证失败不能只看 message：ImapFlow 对部分服务器（如腾讯企业邮）抛笼统的
 * "Command failed"，真凭据在 err.authenticationFailed / responseText 里。
 */
function isAuthFailure(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; message?: string } | undefined
  const text = String(e?.message ?? err)
  return e?.authenticationFailed === true || AUTH_FAIL_RE.test(text)
}

/** 国内常见企业邮服务器：自定义域名猜不出来，靠真实连接探测 */
const ENTERPRISE_HOST_GUESSES = ['imap.exmail.qq.com', 'qiye.163.com', 'imap.qiye.aliyun.com']

/**
 * IMAP 服务器候选列表。
 *
 * "自动"不是猜一个域名就完事：企业邮箱（腾讯企业邮、网易企业邮、阿里企业邮）用自定义域名，
 * 从域名根本猜不出服务器。所以：
 * - 用户手填的 host 只有**与自动推导值不同**才算手动指定（老数据里存过推导错的值，靠这条规则自愈）
 * - 已知服务商（qq/gmail/163…）推导结果是权威的，只试这一个
 * - 自定义域名：推导值打头，后面依次真连常见企业邮服务器，谁连得上用谁
 */
function hostCandidates(acc: MailAccount): string[] {
  const derived = deriveImapHost(acc.address)
  const manual = acc.host?.trim() ?? ''
  // 填的恰好等于推导值 → 视为自动（老数据里可能存了推导错的值，靠这条规则自愈，不用用户清理）
  const isManual = manual && !(derived && manual.toLowerCase() === derived.toLowerCase())
  if (isManual) return [manual]
  if (isKnownProvider(acc.address)) return [derived || 'imap.qq.com']
  return [...new Set([derived || 'imap.qq.com', ...ENTERPRISE_HOST_GUESSES])]
}

/** 连上（自动探测服务器）并只读打开 INBOX；锁与实际用到的 host 交给回调，结束自动释放 */
async function withInbox<T>(
  acc: MailAccount,
  fn: (client: ImapFlow, lock: MailboxLockObject, host: string) => Promise<T>
): Promise<T> {
  const candidates = hostCandidates(acc)
  let client: ImapFlow | undefined
  let host = ''
  let sawAuthFail = false
  let lastErr: unknown

  for (const candidate of candidates) {
    const c = new ImapFlow({
      host: candidate,
      port: acc.port,
      secure: true,
      auth: { user: acc.address, pass: acc.authCode },
      // 探测要有上限：每个候选 8 秒连不上就算了
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      logger: false
    })
    try {
      await c.connect()
      client = c
      host = candidate
      break
    } catch (err) {
      lastErr = err
      if (isAuthFailure(err)) sawAuthFail = true
      try {
        c.close()
      } catch {
        /* 没连上，无需关闭 */
      }
    }
  }

  if (!client) {
    // 全部候选都失败，按失败类型分两种口径：
    // - 有认证被拒：服务器可达但登录不进——授权码不对，或这个邮箱根本不在候选的企业邮服务上
    // - 全是网络错误：服务器都不可达
    if (sawAuthFail) {
      throw new Error(
        '认证失败：服务器能连上但登录被拒——确认授权码是刚生成的（不是邮箱登录密码）；如果账号不在腾讯/网易/阿里的企业邮上，可在设置里展开「高级」手动指定服务器'
      )
    }
    throw new Error(
      `网络失败：${candidates.join(' / ')} 都连不上（IMAP 服务器不可达；企业邮箱可在设置里展开「高级」手动指定）`
    )
  }

  let lock: MailboxLockObject | undefined
  try {
    // getMailboxLock 自带互斥：同一连接上的取信操作串行，readOnly 保证不碰已读标记
    lock = await client.getMailboxLock('INBOX', { readOnly: true })
  } catch (err) {
    await closeQuietly(client)
    throw typedMailError(err, { ...acc, host })
  }
  try {
    return await fn(client, lock, host)
  } finally {
    lock?.release()
    await closeQuietly(client)
  }
}

async function closeQuietly(client: ImapFlow): Promise<void> {
  try {
    await client.logout()
  } catch {
    try {
      client.close()
    } catch {
      /* 连接本来就断了 */
    }
  }
}

export interface MailListItem {
  uid: number
  from: string
  /** 发件人地址（from 里的第一个地址，比显示名可靠） */
  fromAddress: string
  subject: string
  date: string
  seen: boolean
  /** 正文前 ~200 字，列表面板用，不整封下载 */
  snippet: string
  sizeKB: number
  /** 来自哪个账号（显示名/地址），多账号时模型用来区分来源 */
  account: string
}

export interface MailDetail {
  uid: number
  from: string
  fromAddress: string
  to: string[]
  subject: string
  date: string
  /** 纯文本正文（HTML 邮件剥标签），截到 8000 字 */
  text: string
  /** 来自哪个账号（显示名/地址） */
  account: string
}

function addrText(value: unknown): { name: string; address: string } {
  const obj = (value ?? {}) as { name?: string; address?: string }
  return { name: String(obj.name ?? ''), address: String(obj.address ?? '') }
}

function displayName(a: { name: string; address: string }): string {
  return a.name || a.address
}

/** 从 bodyStructure 里找正文部件：优先 text/plain，退而 text/html */
function textPartOf(node: unknown): { path: string; isHtml: boolean } | null {
  const hit = findTextPart(node)
  return hit ? { path: hit.path, isHtml: /^text\/html/i.test(hit.type) } : null
}

/** 把 IMAP 底层异常翻译成分型错误：模型与用户都要知道"卡在哪一步" */
function typedMailError(err: unknown, acc: MailAccount): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/AUTHENTICATIONFAILED|authentication|LOGIN|invalid credentials|password/i.test(message)) {
    return new Error(`认证失败：IMAP 登录被拒——确认地址没写错、授权码是刚生成的（不是邮箱登录密码）`)
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|fetch failed|network|EHOSTUNREACH/i.test(message)) {
    return new Error(`网络失败：连不上 ${acc.host}:${acc.port}（IMAP 服务器不可达）`)
  }
  return new Error(`IMAP 连接/读取失败：${message}`)
}

/** 连接自检：能登录、能只读打开 INBOX 就算通；accountRef 缺省测默认账号 */
export async function testMail(
  config: ButlerConfig,
  accountRef?: string
): Promise<{ ok: boolean; detail: string; total?: number }> {
  const acc = resolveMailAccount(config, accountRef)
  if (!acc) return { ok: false, detail: accountRef ? `没有找到账号「${accountRef}」` : '还没有填邮箱地址或授权码' }
  try {
    return await withInbox(acc, async (client, _lock, host) => {
      const box = client.mailbox
      const total = box && typeof box === 'object' ? box.exists : 0
      return { ok: true, detail: `已连上 ${host}（${acc.label}），INBOX 共 ${total} 封`, total }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 错误信息本身已按类型分好口径（认证/网络/候选列表），前缀只补账号名
    if (/AUTHENTICATIONFAILED|authentication/i.test(message)) {
      return { ok: false, detail: `「${acc.label}」${message}` }
    }
    return { ok: false, detail: `「${acc.label}」${message}` }
  }
}

/** 最近的邮件：列表带 200 字摘要，不整封下载；accountRef 缺省用默认账号 */
export async function listRecentMail(config: ButlerConfig, limit = 10, accountRef?: string): Promise<MailListItem[]> {
  const acc = resolveMailAccount(config, accountRef)
  if (!acc) {
    throw new Error(
      accountRef
        ? `没有找到邮箱账号「${accountRef}」，可用账号在「设置」里`
        : '还没有配置邮箱，去「设置」里填地址和授权码'
    )
  }
  return withInbox(acc, async (client) => {
    const box = client.mailbox
    const total = box && typeof box === 'object' ? box.exists : 0
    if (total === 0) return []
    const start = Math.max(1, total - Math.min(Math.max(limit, 1), 30) + 1)
    // 第一阶段：fetch 游标只收元数据，游标没走完之前不能在同一连接上发其他命令
    const metas: Array<{
      uid: number
      from: { name: string; address: string }
      subject: string
      date: string
      seen: boolean
      sizeKB: number
      part: string | null
      isHtml: boolean
    }> = []
    for await (const msg of client.fetch(`${start}:${total}`, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      bodyStructure: true
    })) {
      const date = msg.envelope?.date
      const part = textPartOf(msg.bodyStructure)
      metas.push({
        uid: msg.uid,
        from: addrText(msg.envelope?.from?.[0]),
        subject: String(msg.envelope?.subject ?? '（无主题）'),
        date: (date ? new Date(date) : new Date()).toISOString(),
        seen: Boolean(msg.flags?.has('\\Seen')),
        sizeKB: Math.round((msg.size ?? 0) / 102.4) / 10,
        part: part?.path ?? null,
        isHtml: part?.isHtml ?? false
      })
    }

    // 第二阶段：游标已收完，再逐封抓 400 字节摘要；单封失败不影响整表
    const out: MailListItem[] = []
    for (const meta of [...metas].reverse()) {
      let snippet = ''
      if (meta.part) {
        try {
          const { content } = await client.download(meta.uid, meta.part, { uid: true, maxBytes: 400 })
          const raw = content ? (await content.toArray()).map((b) => b.toString('utf8')).join('') : ''
          snippet = (meta.isHtml ? stripTags(raw) : raw).replace(/\s+/g, ' ').trim().slice(0, 200)
        } catch {
          /* 摘要拿不到不影响列表 */
        }
      }
      out.push({
        uid: meta.uid,
        from: displayName(meta.from),
        fromAddress: meta.from.address,
        subject: meta.subject,
        date: meta.date,
        seen: meta.seen,
        snippet,
        sizeKB: meta.sizeKB,
        account: acc.label ?? acc.address
      })
    }
    return out
  })
}

/** 单封正文：HTML 剥标签，截 8000 字；只读，不动已读标记；accountRef 缺省用默认账号 */
export async function readMailBody(config: ButlerConfig, uid: number, accountRef?: string): Promise<MailDetail> {
  const acc = resolveMailAccount(config, accountRef)
  if (!acc) {
    throw new Error(
      accountRef
        ? `没有找到邮箱账号「${accountRef}」，可用账号在「设置」里`
        : '还没有配置邮箱，去「设置」里填地址和授权码'
    )
  }
  return withInbox(acc, async (client) => {
    // 同样两阶段：先把信封和结构收完，游标结束后再下载正文
    let meta: {
      from: { name: string; address: string }
      to: string[]
      subject: string
      date: string
      part: string | null
      isHtml: boolean
    } | null = null
    for await (const msg of client.fetch({ uid }, { uid: true, envelope: true, bodyStructure: true })) {
      const date = msg.envelope?.date
      const part = textPartOf(msg.bodyStructure)
      meta = {
        from: addrText(msg.envelope?.from?.[0]),
        to: (msg.envelope?.to ?? []).map(addrText).map(displayName),
        subject: String(msg.envelope?.subject ?? '（无主题）'),
        date: (date ? new Date(date) : new Date()).toISOString(),
        part: part?.path ?? null,
        isHtml: part?.isHtml ?? false
      }
    }
    if (!meta) throw new Error(`没有找到 uid=${uid} 的邮件（可能已被移动或删除）`)

    let text = ''
    if (meta.part) {
      try {
        const { content } = await client.download(uid, meta.part, { uid: true, maxBytes: 1024 * 64 })
        const raw = content ? (await content.toArray()).map((b) => b.toString('utf8')).join('') : ''
        text = (meta.isHtml ? stripTags(raw) : raw)
          .replace(/\s+\n/g, '\n')
          .trim()
          .slice(0, 8000)
      } catch (err) {
        text = `（正文下载失败：${err instanceof Error ? err.message : String(err)}）`
      }
    } else {
      text = '（这封邮件没有可读的文本正文，可能是纯附件邮件）'
    }
    return {
      uid,
      from: displayName(meta.from),
      fromAddress: meta.from.address,
      to: meta.to,
      subject: meta.subject,
      date: meta.date,
      text,
      account: acc.label ?? acc.address
    }
  })
}
