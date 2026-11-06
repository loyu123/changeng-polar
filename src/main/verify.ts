import type { ButlerConfig, SearchHit, VerifyResult } from '../shared/types'
import { chatCompletion } from './agent/llm'
import { fetchPage, searchWeb } from './node/web'

/** 明显不是官网的站点：下载站、问答、百科、聚合站 */
const BLACKLIST = [
  'baidu.com',
  'zhihu.com',
  'csdn.net',
  'so.com',
  'sogou.com',
  'bing.com',
  'wikipedia.org',
  'softonic',
  'crsky',
  'pc6.com',
  'onlinedown',
  'duote',
  'zol.com.cn',
  'pconline',
  'downxia',
  'huajun',
  'jiameng',
  'taobao.com',
  'tmall.com',
  'jd.com',
  'apps.microsoft.com',
  // 登录页 / 账号页：免费检索源常把它们当"官网"返回，抓下来只有一屏表单
  'accounts.',
  'login.',
  'signin.',
  '/signin',
  '/login'
]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

function rootToken(host: string): string {
  const parts = host.split('.')
  return parts.length > 1 ? parts[parts.length - 2] : host
}

function latinTokens(...values: string[]): string[] {
  const tokens = new Set<string>()
  for (const value of values) {
    for (const raw of value.split(/[\s,，·|/()（）【】\[\]-]+/)) {
      const token = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (token.length >= 3 && /[a-z]/.test(token)) tokens.add(token)
    }
  }
  return [...tokens]
}

function scoreHit(hit: SearchHit, tokens: string[], appName: string): number {
  const host = hostOf(hit.url)
  if (!host) return -99
  let score = 0
  if (BLACKLIST.some((b) => host.includes(b))) score -= 8
  const root = rootToken(host)
  for (const token of tokens) {
    if (root.includes(token) || token.includes(root)) score += 4
    else if (host.includes(token)) score += 2
  }
  // 中文名没有拉丁词元可对，用标题包含程序名做信号
  if (appName && hit.title.includes(appName)) score += 3
  // 优先站点首页：下载页/安装页只说"提供安装包"，给不出一句话功能
  try {
    const pathname = new URL(hit.url).pathname
    if (pathname === '/' || pathname === '') score += 3
    else if (pathname.split('/').filter(Boolean).length > 1) score -= 1
    if (/download|install|pricing|store/i.test(pathname)) score -= 2
  } catch {
    /* 忽略非法 URL */
  }
  if (/官网|官方网站|official/i.test(`${hit.title} ${hit.snippet}`)) score += 2
  if (/帮助|文档|支持|help|docs|support/i.test(hit.url)) score += 1
  return score
}

function extractJson(text: string): any | null {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

export type VerifyVia = 'registry' | 'guess' | 'search'

export interface VerifyOptions {
  signal?: AbortSignal
  /** 注册表登记的产品网址（URLInfoAbout）：有就直连，比检索可靠得多 */
  officialUrl?: string
  /** 每次尝试的诊断回调（探针用 --debug 打开），线上不传 */
  onAttempt?: (info: { url: string; via: VerifyVia; ok: boolean; detail?: string }) => void
}

/** 域名里要能找到程序名/发布者的词，才值得去抓——挡住模型随口给的无关域名 */
function hostMatchesTokens(url: string, tokens: string[]): boolean {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  const parts = host.split('.').filter((p) => p && p !== 'www')
  return tokens.some((token) => {
    const t = token.toLowerCase()
    if (t.length < 3) return false
    return parts.some((part) => part.includes(t) || t.includes(part))
  })
}

/**
 * 让模型先"猜"官网地址，再由抓取+核对来判定。
 *
 * 这不违反「不编造」：模型给的只是**待核实的候选**，最终写进结果的
 * 说明句与来源地址都必须来自真实抓到的页面；猜错就丢弃。
 */
export async function guessOfficialUrls(
  appName: string,
  publisher: string,
  config: ButlerConfig,
  signal?: AbortSignal,
  onRaw?: (raw: string) => void
): Promise<string[]> {
  try {
    const extraction = await chatCompletion({
      config: { ...config, stream: false, temperature: 0 },
      tools: [],
      signal,
      messages: [
        {
          role: 'system',
          content: '你只输出 JSON。不要解释，不要用 Markdown 代码块。'
        },
        {
          role: 'user',
          content: `软件名称：${appName}\n发布者：${publisher || '未知'}\n\n请给出这个软件的**官方网站**地址候选，最多 2 个，按可能性从高到低。\n只给你有把握的官方域名（官网首页、官方产品页或官方文档）；不确定就返回空数组。\n绝对不要给下载站、软件园、百科、博客、论坛、登录页。\n\n输出格式：{"candidates":["https://example.com"]}`
        }
      ]
    })
    onRaw?.(extraction.content ?? '')
    const parsed = extractJson(extraction.content || '')
    const list = Array.isArray(parsed?.candidates) ? (parsed!.candidates as unknown[]) : []
    return list.filter((item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item)).slice(0, 2)
  } catch (err) {
    onRaw?.(`[error] ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export async function verifyApp(
  appName: string,
  publisher: string,
  config: ButlerConfig,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const { signal, officialUrl, onAttempt } = options
  const checkedAt = new Date().toISOString()
  const fail = (reason: string): VerifyResult => ({
    appName,
    status: 'unverified',
    sentence: '',
    sourceUrl: '',
    evidenceText: '',
    checkedAt,
    reason
  })

  if (!config.apiKey && !/localhost|127\.0\.0\.1/i.test(config.baseUrl)) {
    return fail('未配置模型，无法判断官网正文')
  }

  // 注册表里的名字常带版本号、语言标记、版本档位（"- zh-cn"、"家庭版"、"64-bit"），
  // 直接拿去检索会把结果带偏，先剥掉这些
  const cleanName = appName
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\s*[-–—_]\s*(zh|zh-cn|zh-tw|en|en-us|ja|ko)\b/gi, ' ')
    .replace(/\b(user|machine|64-bit|32-bit|x64|x86)\b/gi, ' ')
    .replace(/\s+v?\d[\w.\-+]*/gi, ' ')
    .replace(/\b(家庭版|专业版|企业版|教育版|标准版|免费版|中文版|社区版|beta|insider|preview)\b/gi, ' ')
    .replace(/[-–—_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const tokens = latinTokens(cleanName, appName, publisher)

  let lastReason = ''
  const visited = new Set<string>()

  /** 抓一页、让模型只依据正文判断；判定成功就返回结果，失败返回 null 并记原因 */
  const attempt = async (url: string, via: VerifyVia): Promise<VerifyResult | null> => {
    if (!url || visited.has(url)) return null
    visited.add(url)
    try {
      const page = await fetchPage(url, signal)
      // 安全公告 / CVE 页也会被模型当成"官方页面"，但它说明不了这个软件是做什么的
      if (/cve-\d{4}|vulnerab|security-bulletin|security-update/i.test(page.finalUrl)) {
        lastReason = '抓到的是安全公告页，不是产品页'
        onAttempt?.({ url: page.finalUrl, via, ok: false, detail: lastReason })
        return null
      }
      if (page.text.length < 120) {
        lastReason = `页面正文过短（${page.text.length} 字）`
        onAttempt?.({ url: page.finalUrl, via, ok: false, detail: lastReason })
        return null
      }
      const extraction = await chatCompletion({
        config: { ...config, stream: false, temperature: 0 },
        tools: [],
        signal,
        messages: [
          {
            role: 'system',
            content:
              '你是一个严格的资料核对员。只依据用户给出的网页正文判断，不允许使用你自己的知识补充。回答只输出一个 JSON 对象，不要解释。'
          },
          {
            role: 'user',
            content: `软件名称：${appName}\n发布者：${publisher || '未知'}\n页面地址：${page.finalUrl}\n页面标题：${page.title}\n\n页面正文（截断）：\n${page.text.slice(0, 2500)}\n\n请判断并输出 JSON：\n{"official": true 或 false, "sentence": "这个软件是做什么的，不超过40个汉字，必须能在正文中找到依据", "basis": "支撑 sentence 的正文原句片段，不超过60字"}\n\nofficial 为 true 的条件：这个页面确实是该软件的官方网站、官方产品页或官方帮助文档。第三方评测、下载站、百科、问答一律为 false。`
          }
        ]
      })
      const parsed = extractJson(extraction.content || '')
      if (!parsed) {
        lastReason = '模型没有返回可解析的核对结果'
        onAttempt?.({ url: page.finalUrl, via, ok: false, detail: lastReason })
        return null
      }
      if (parsed.official === true && typeof parsed.sentence === 'string' && parsed.sentence.trim()) {
        onAttempt?.({ url: page.finalUrl, via, ok: true, detail: parsed.sentence.trim().slice(0, 40) })
        return {
          appName,
          status: 'verified',
          sentence: parsed.sentence.trim().slice(0, 60),
          sourceUrl: page.finalUrl,
          evidenceText: String(parsed.basis ?? '').slice(0, 80),
          checkedAt: new Date().toISOString(),
          via
        }
      }
      lastReason = via === 'registry' ? '注册表登记的网址不是官方页面' : '页面不是官方页面'
      onAttempt?.({ url: page.finalUrl, via, ok: false, detail: lastReason })
      return null
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err)
      onAttempt?.({ url, via, ok: false, detail: lastReason })
      return null
    }
  }

  // 第一步：注册表自己登记的产品网址。不经过检索，也就没有"搜出一堆下载站"的问题
  const hint = (officialUrl ?? '').trim()
  if (/^https?:\/\//i.test(hint)) {
    const verified = await attempt(hint, 'registry')
    if (verified) return verified
  }

  // 第二步：让模型提候选域名，再靠抓取核对。比免费检索可靠，成本是多一次模型调用；
  // 域名必须能对上程序名/发布者才去抓，避免满世界乱试
  const guessed = (
    await guessOfficialUrls(appName, publisher, config, signal, (raw) => {
      // 模型调用本身失败也要留痕，否则会被误读成"模型不知道这个软件"
      if (raw.startsWith('[error]')) onAttempt?.({ url: '(模型提议)', via: 'guess', ok: false, detail: raw })
    })
  )
    .filter((url) => hostMatchesTokens(url, tokens))
    .slice(0, 2)
  for (const url of guessed) {
    const verified = await attempt(url, 'guess')
    if (verified) return verified
  }

  // 第三步：检索 → 排序 → 最多试两个像官网的地址
  const queries = [`${cleanName} 官网`, `${cleanName} 功能介绍`]
  if (publisher.trim()) queries.push(`${publisher} ${cleanName} 官网`)
  let hits: SearchHit[] = []
  let lastError = ''
  for (const query of queries) {
    const outcome = await searchWeb(query, config, signal)
    if (outcome.ok && outcome.hits.length > 0) {
      hits = outcome.hits
      break
    }
    lastError = outcome.error ?? '检索无结果'
  }
  if (hits.length === 0) return fail(lastReason || lastError || '检索无结果')

  const ranked = [...hits]
    .map((hit) => ({ hit, score: scoreHit(hit, tokens, cleanName) }))
    .sort((a, b) => b.score - a.score)
    .filter((item) => item.score > 0)
    .slice(0, 2)

  if (ranked.length === 0) return fail(lastReason || '检索结果里没有像官网的地址')

  for (const candidate of ranked) {
    const verified = await attempt(candidate.hit.url, 'search')
    if (verified) return verified
  }

  return fail(lastReason || '未能在官方来源找到说明')
}
