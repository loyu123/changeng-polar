import { KEYED_PROVIDERS, type ButlerConfig, type PageContent, type SearchHit } from '../../shared/types'
import { decodeEntities, stripTags } from './html'

export { decodeEntities, stripTags }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface SearchOutcome {
  ok: boolean
  provider: string
  hits: SearchHit[]
  error?: string
  /** 换了来源时说一句为什么：用户明确选了某个源，静默换掉等于骗他 */
  note?: string
  durationMs: number
}

export function unwrapDdg(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return href
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  return href
}

export function unwrapBing(href: string): string {
  // 形如 /ck/a?...&u=a1<base64url>&ntb=1，base64 部分只含 [A-Za-z0-9-_]
  const m = /[?&]u=a1([A-Za-z0-9\-_]+)/.exec(href)
  if (!m) return href
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : href
  } catch {
    return href
  }
}

function absolutize(href: string, origin: string): string {
  if (!href) return ''
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('//')) return `https:${href}`
  if (href.startsWith('/')) return origin + href
  return ''
}

/**
 * 反爬人机验证页的特征词。
 *
 * DuckDuckGo 被拦时回的是 **202**，正文是一页 "Unfortunately, bots use DuckDuckGo too"，
 * 旧代码只判了 `res.ok`（202 属于 ok），于是把这一整页当成"零条结果"，
 * 用户最后看到的是"查不到"。把"被拦了"说成"没有"，是最误导人的一种降级：
 * 用户会以为自己要查的东西不存在，然后再查一遍。
 */
const CHALLENGE_MARKERS =
  /人机验证|安全验证|访问过于频繁|请输入验证码|完成验证|captcha|challenge-platform|bots use|verify you are (?:a )?human|Just a moment/i

/** 认出来就返回一句能读懂的原因；认不出来返回 null（正常页面、或只是真的没结果） */
export function detectChallenge(status: number, html: string): string | null {
  if (CHALLENGE_MARKERS.test(html.slice(0, 20_000))) return '取回的是人机验证页，被反爬拦下了'
  if (status === 202) return '取回的是 HTTP 202 挑战页，被反爬拦下了'
  return null
}

/** 检索词主体是中文吗：汉字至少两个，且不少于拉丁字母数 */
export function isCjkQuery(query: string): boolean {
  const cjk = (query.match(/[一-龥]/g) ?? []).length
  const latin = (query.match(/[a-z]/gi) ?? []).length
  return cjk >= 2 && cjk >= latin
}

/**
 * 免费 Bing 抓取的地址。
 *
 * 抓 `cn.bing.com` 而不是 `www.bing.com`：国内网络下 www 那个实例经常回一页与检索词
 * 毫无关系的结果（查 DeepSeek 返回 Windows 帮助页，查量子计算返回 bilibili），
 * cn 实例实测 150–300ms、稳定 10 条、中文命中准。cn.bing.com 在境外同样能解析，
 * 所以不按地区分流，固定用它。
 *
 * `setlang` 跟着检索词的语言走。不设 `ensearch`：之前以为"Electron 45 release notes
 * 返回菜鸟教程"是 ensearch 被钉成 0 造成的，实测带上与不带结果一致——真正的原因是
 * CN 实例本身就偏中文站，不是这个参数。
 */
export function bingSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query, count: '10', setlang: isCjkQuery(query) ? 'zh-Hans' : 'en' })
  return `https://cn.bing.com/search?${params.toString()}`
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'user-agent': UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: 'text/html'
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`)
  const html = decodeEntities(await res.text())
  const hits: SearchHit[] = []
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]))
  let lm: RegExpExecArray | null
  let i = 0
  while ((lm = linkRe.exec(html))) {
    const url = unwrapDdg(lm[1])
    if (!/^https?:\/\//i.test(url)) continue
    hits.push({ title: stripTags(lm[2]), url, snippet: snippets[i] ?? '' })
    i += 1
    if (hits.length >= 8) break
  }
  // 一条都没抽到时才判定反爬：正常页面里不会出现那些词，先判会误伤
  if (hits.length === 0) {
    const challenge = detectChallenge(res.status, html)
    if (challenge) throw new Error(`DuckDuckGo ${challenge}`)
  }
  return hits
}

async function searchBing(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(bingSearchUrl(query), {
    headers: {
      'user-agent': UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: 'text/html'
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`Bing ${res.status}`)
  const html = decodeEntities(await res.text())
  const hits: SearchHit[] = []
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/gi
  const blocks = html.match(blockRe) ?? []
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = absolutize(unwrapBing(a[1]), 'https://cn.bing.com')
    if (!/^https?:\/\//i.test(url)) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({ title: stripTags(a[2]), url, snippet: p ? stripTags(p[1]) : '' })
    if (hits.length >= 8) break
  }
  if (hits.length === 0) {
    const challenge = detectChallenge(res.status, html)
    if (challenge) throw new Error(`Bing ${challenge}`)
  }
  return hits
}

async function searchTavily(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const json = (await res.json()) as any
  const results = Array.isArray(json.results) ? json.results : []
  return results.map((r: any) => ({
    title: String(r.title ?? r.url ?? ''),
    url: String(r.url ?? ''),
    snippet: String(r.content ?? '').slice(0, 320)
  }))
}

/** Google 结果（Serper.dev）：中文站内站外都准，免费额度 2500 次 */
async function searchSerper(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn', num: 8 }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
  })
  if (!res.ok) throw new Error(`Serper ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const json = (await res.json()) as any
  const items: any[] = Array.isArray(json.organic) ? json.organic : []
  return items.map((item) => ({
    title: String(item.title ?? item.link ?? ''),
    url: String(item.link ?? ''),
    snippet: String(item.snippet ?? '').slice(0, 320)
  }))
}

/** Bing Web Search v7（Azure）：官方接口，稳定但要订阅 Key */
async function searchBingApi(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=8&responseFilter=Webpages`
  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
  })
  if (!res.ok) throw new Error(`BingAPI ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const json = (await res.json()) as any
  const items: any[] = Array.isArray(json.webPages?.value) ? json.webPages.value : []
  return items.map((item) => ({
    title: String(item.name ?? item.url ?? ''),
    url: String(item.url ?? ''),
    snippet: String(item.snippet ?? '').slice(0, 320)
  }))
}

/** 检索词拆成"可判定的词元"：拉丁词 + 中文二元组，剔除"官网/下载"这类到处都有的词 */
const STOPWORDS = new Set(['官网', '官方', '下载', '功能', '介绍', '什么', '怎么', '最新', '免费', '的是', '一个'])

export function relevanceTokens(query: string): string[] {
  const tokens = new Set<string>()
  for (const part of query.split(/[\s,，、。？?]+/)) {
    if (!part) continue
    if (/[a-z0-9]/i.test(part) && part.length >= 2) tokens.add(part.toLowerCase())
    const cjk = part.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i + 2 <= cjk.length; i += 1) {
      const gram = cjk.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) tokens.add(gram)
    }
    if (cjk.length >= 2 && !STOPWORDS.has(cjk)) tokens.add(cjk)
  }
  return [...tokens]
}

function isRelevant(hit: SearchHit, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const haystack = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase()
  return tokens.some((token) => haystack.includes(token))
}

/**
 * 免费源失败后自己再试一次。
 *
 * 为什么需要：实测撞到过一整段降级窗口——连续 12 次全部 0 条、单次 700–1800ms，
 * 隔几分钟又恢复成 8 条。那种时候它不报错、也不回验证页，只是解析不出 `b_algo`，
 * 链路于是报"查不到"。用户看到的就成了"这个东西不存在"，而其实只是被限流了几秒。
 *
 * 只重试**瞬时故障**。反爬页不重试（一定还是拦）、已经 abort 不重试（用户不等了）；
 * 空结果只给一次机会——第二次还是空，那就是真的没有，再试只是让用户多等两秒。
 * 重试之间要停一下：连着猛打反而更容易持续被限流。
 */
const RETRY_DELAYS_MS = [400, 1200] as const

/** 这个错误值不值得再试一次 */
export function isTransientSearchError(message: string): boolean {
  // 反爬/挑战页：重试没有意义
  if (/反爬|人机验证|挑战页/.test(message)) return false
  if (/\b429\b/.test(message) || /\b5\d\d\b/.test(message)) return true
  return /abort|timeout|超时|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 跑一档来源，瞬时失败按 RETRY_DELAYS_MS 重试。
 * 注意 Bing 降级时是**成功返回零条**而不是抛错，所以"空"也要当成一次失败来试。
 */
async function withRetry(name: string, fn: () => Promise<SearchHit[]>, signal?: AbortSignal): Promise<SearchHit[]> {
  let lastError: string | undefined
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      if (signal?.aborted) break
      await sleep(RETRY_DELAYS_MS[attempt - 1]!)
    }
    try {
      const hits = await fn()
      if (hits.length > 0) return hits
      lastError = `${name}: 无结果`
      if (attempt === RETRY_DELAYS_MS.length) return hits
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastError = `${name}: ${message}`
      // 不是瞬时故障就别浪费时间：反爬页再来一次还是反爬页
      if (!isTransientSearchError(message) || attempt === RETRY_DELAYS_MS.length) throw err
    }
  }
  throw new Error(lastError ?? `${name}: 重试后仍无结果`)
}

export async function searchWeb(
  query: string,
  config: ButlerConfig,
  signal?: AbortSignal
): Promise<SearchOutcome> {
  const started = Date.now()
  const provider = config.searchProvider ?? 'bing'
  if (provider === 'none') {
    return { ok: false, provider, hits: [], error: '检索能力未启用（设置 → 检索来源）', durationMs: 0 }
  }
  const chain: Array<{ name: string; fn: () => Promise<SearchHit[]> }> = []
  const freeDdg = (): Promise<SearchHit[]> => searchDuckDuckGo(query, signal)
  const freeBing = (): Promise<SearchHit[]> => searchBing(query, signal)

  if (KEYED_PROVIDERS.includes(provider)) {
    const key = config.searchKey.trim()
    if (!key) {
      return { ok: false, provider, hits: [], error: `${provider} 需要 API Key（设置 → 检索来源）`, durationMs: 0 }
    }
    const keyed: Record<string, () => Promise<SearchHit[]>> = {
      tavily: () => searchTavily(query, key, signal),
      serper: () => searchSerper(query, key, signal),
      bingapi: () => searchBingApi(query, key, signal)
    }
    chain.push({ name: provider, fn: keyed[provider] })
    // Key 失效 / 超额时不直接把失败甩给用户：继续用免费源兜底，并在错误里说明
    chain.push({ name: 'bing', fn: freeBing })
    chain.push({ name: 'duckduckgo', fn: freeDdg })
  } else if (provider === 'duckduckgo') {
    // 用户明确选了 DuckDuckGo 就照办；它被拦时再退到 Bing
    chain.push({ name: 'duckduckgo', fn: freeDdg })
    chain.push({ name: 'bing', fn: freeBing })
  } else {
    // 默认先走 Bing：国内网络下 DuckDuckGo 基本直接回人机验证页，先试它等于白等一次
    chain.push({ name: 'bing', fn: freeBing })
    chain.push({ name: 'duckduckgo', fn: freeDdg })
  }

  const errors: string[] = []
  const relevance = relevanceTokens(query)
  for (const step of chain) {
    try {
      const raw = await withRetry(step.name, step.fn, signal)
      // 免费源经常返回与检索词完全无关的页面：先把无关结果丢掉，宁可报"查不到"
      const hits = raw.filter((hit) => isRelevant(hit, relevance))
      if (hits.length > 0) {
        // 前面几档都没成，这一档成了：把"换了来源"带出去，别让它悄悄发生
        const note = errors.length > 0 ? `首选来源不可用（${errors.join('；')}），已改用 ${step.name}` : undefined
        return { ok: true, provider: step.name, hits, durationMs: Date.now() - started, note }
      }
      errors.push(`${step.name}: ${raw.length > 0 ? `${raw.length} 条结果全部与检索词无关` : '无结果'}`)
    } catch (err) {
      errors.push(`${step.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    ok: false,
    provider,
    hits: [],
    error: `检索失败（${errors.join('；')}）`,
    durationMs: Date.now() - started
  }
}

function pickCharset(contentType: string, html: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(html.slice(0, 4096))?.[1]
  return (fromMeta ?? 'utf-8').toLowerCase()
}

/**
 * 页面"看起来有内容，其实没读到正文"的几种样子。
 *
 * 为什么要这一步：剥掉标签之后，JS 渲染页、登录墙、错误页都会剩下**非零长度**的文字，
 * 不报错，于是模型会拿它当正文总结。实测三个真实例子：
 *   知乎问答    35 字，只剩站点口号「知乎，让每一次点击都充满意义」
 *   微信公众号  78 字，全是「，」「。」这类标点碎片
 *   小红书      14 字，最终地址已经跳到 /login
 * 三种都"成功"读到了东西，但读到的都不是那页讲的事。
 *
 * 只在证据明确时才报。宁可漏报，也不要把一个正常的短页面说成"读不到"——
 * 一句假的"读不到"会让模型放弃一个本来能用的页面，那比不报更糟。
 */
const LOGIN_PATH = /\/(?:login|log-in|signin|sign-in|sign_in|passport|sso|auth)(?:\/|$|\?)/i
const LOGIN_REDIRECT_PARAM = /[?&](?:redirect|redirect_uri|redirectPath|redirect_url|returnUrl|return_url|continue|next)=/i
/** 典型的前端渲染容器：body 里只有它，正文得靠 JS 填进去 */
const SPA_SHELL =
  /id=["'](?:root|app|__next|___gatsby)["']|__NEXT_DATA__|__NUXT__|ng-version=|data-reactroot|window\.__INITIAL_STATE__|window\.__NUXT/
/** 页面自己写在明处的错误提示 */
const ERROR_LEAD = /^(?:参数错误|页面不存在|页面未找到|内容不存在|内容已删除|访问受限|请求失败|系统繁忙|出错了|无法访问|404|403)/

/** 一行是否属于"排版碎片"：只有标点、或者一两个字 */
function isFragmentLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (t.length <= 2) return true
  return !/[一-龥a-zA-Z0-9]/.test(t)
}

export function diagnosePage(input: {
  html: string
  text: string
  finalUrl: string
  /** <title> 缺失、标题回落成地址：多半是 JS 壳子或错误页 */
  titleMissing: boolean
}): string | undefined {
  const { html, text, finalUrl, titleMissing } = input
  const main = text
  if (!main.trim()) return '这页没有任何文字内容（抓回来是空的）'

  if (ERROR_LEAD.test(main.replace(/^[^一-龥a-zA-Z0-9]+/, ''))) {
    return '这页返回的是错误提示，不是内容'
  }

  let pathname = ''
  try {
    const u = new URL(finalUrl)
    pathname = u.pathname + u.search
  } catch {
    pathname = finalUrl
  }
  if (LOGIN_PATH.test(pathname) || LOGIN_REDIRECT_PARAM.test(pathname)) {
    return '最终地址跳到了登录页，正文要登录才能看'
  }

  // 碎片占比过高：微信那种「， ⏎ 。 ⏎ ，」的排版残渣
  const lines = main.split('\n').filter((l) => l.trim())
  if (lines.length >= 5) {
    const fragments = lines.filter(isFragmentLine).length
    if (fragments / lines.length > 0.4) {
      return `抓到的 ${main.length} 字里有 ${fragments} 行是排版碎片，不是正文`
    }
  }

  // 前端渲染：HTML 里有 SPA 容器，而剥出来的文字很少
  if (main.length < 500 && SPA_SHELL.test(html)) {
    return '这页正文由 JS 在浏览器里生成，抓 HTML 只能拿到空壳'
  }

  // 兜底：文字少到不可能是正文。这一条措辞最软，因为"短"本身不是证据
  if (main.length < 150 && titleMissing) {
    return `只抓到 ${main.length} 字，看着是站点说明而不是正文`
  }
  return undefined
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<PageContent> {
  if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 地址')
  const res = await fetch(url, {
    // 光有 UA 不够：微软系站点会按请求头组合判定"不是浏览器"，直接回 block 页
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 3_000_000) throw new Error('页面过大，已跳过')
  const contentType = res.headers.get('content-type') ?? ''

  if (/^(image|audio|video|application\/pdf|application\/octet-stream)/i.test(contentType)) {
    return {
      url,
      finalUrl: res.url || url,
      title: path.basenameSafe(res.url || url),
      text: `（非 HTML 内容：${contentType}，未提取正文）`,
      fetchedAt: new Date().toISOString()
    }
  }

  let html = buf.toString('utf8')
  const charset = pickCharset(contentType, html)
  if (charset && !/utf-?8/i.test(charset)) {
    try {
      html = new TextDecoder(charset).decode(buf)
    } catch {
      /* 保留 utf8 结果 */
    }
  }

  const rawTitle = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim()
  const title = rawTitle || url

  // 页面自带的描述：整站用 JS 渲染时（微软系产品页常见）正文只有几十个字，
  // 但 <meta description> 里就是官方自己的介绍。这是页面自己的话，不是我们的推测
  const description = decodeEntities(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html)?.[1] ??
      ''
  ).trim()

  const bodyText = stripTags(html)
  let text = bodyText
  if (text.length < 400 && description.length > 20) text = `${description}\n\n${text}`

  // 先按"剥出来的正文"判断，别让补进来的 description 把"没读到"掩盖掉
  const caveat = diagnosePage({
    html,
    text: bodyText,
    finalUrl: res.url || url,
    titleMissing: rawTitle.length === 0
  })

  return {
    url,
    finalUrl: res.url || url,
    title,
    text: text.slice(0, 4000),
    fetchedAt: new Date().toISOString(),
    caveat
  }
}

/** 仅用于非 HTML 内容的标题兜底 */
const path = {
  basenameSafe(u: string): string {
    try {
      return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() ?? u)
    } catch {
      return u
    }
  }
}
