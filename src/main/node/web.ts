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
  return hits
}

async function searchBing(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&count=10`,
    {
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        accept: 'text/html'
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
    }
  )
  if (!res.ok) throw new Error(`Bing ${res.status}`)
  const html = decodeEntities(await res.text())
  const hits: SearchHit[] = []
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/gi
  const blocks = html.match(blockRe) ?? []
  for (const block of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = absolutize(unwrapBing(a[1]), 'https://www.bing.com')
    if (!/^https?:\/\//i.test(url)) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({ title: stripTags(a[2]), url, snippet: p ? stripTags(p[1]) : '' })
    if (hits.length >= 8) break
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

export async function searchWeb(
  query: string,
  config: ButlerConfig,
  signal?: AbortSignal
): Promise<SearchOutcome> {
  const started = Date.now()
  const provider = config.searchProvider ?? 'duckduckgo'
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
    chain.push({ name: 'duckduckgo', fn: freeDdg })
    chain.push({ name: 'bing', fn: freeBing })
  } else if (provider === 'bing') {
    chain.push({ name: 'bing', fn: freeBing })
    chain.push({ name: 'duckduckgo', fn: freeDdg })
  } else {
    chain.push({ name: 'duckduckgo', fn: freeDdg })
    chain.push({ name: 'bing', fn: freeBing })
  }

  const errors: string[] = []
  const relevance = relevanceTokens(query)
  for (const step of chain) {
    try {
      const raw = await step.fn()
      // 免费源经常返回与检索词完全无关的页面：先把无关结果丢掉，宁可报"查不到"
      const hits = raw.filter((hit) => isRelevant(hit, relevance))
      if (hits.length > 0) {
        return { ok: true, provider: step.name, hits, durationMs: Date.now() - started }
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

  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim()

  // 页面自带的描述：整站用 JS 渲染时（微软系产品页常见）正文只有几十个字，
  // 但 <meta description> 里就是官方自己的介绍。这是页面自己的话，不是我们的推测
  const description = decodeEntities(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html)?.[1] ??
      ''
  ).trim()

  let text = stripTags(html)
  if (text.length < 400 && description.length > 20) text = `${description}\n\n${text}`
  return { url, finalUrl: res.url || url, title: title || url, text: text.slice(0, 4000), fetchedAt: new Date().toISOString() }
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
