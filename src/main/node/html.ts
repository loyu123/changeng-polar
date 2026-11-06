/**
 * HTML → 纯文本。
 *
 * 网页抓取（web.ts）与邮件正文（mail.ts）都要这一步，原来各写一份：
 * web 的 stripTags 不处理 <br> 与块级换行，邮件的 htmlToText 处理了。
 * 合并成一份，两边行为一致——邮件里的段落分隔就是靠块级标签换行来的。
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"'
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10))
      } catch {
        return ''
      }
    })
    .replace(/&([a-z]+|#\d+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
}

/** 极简去标签：够读"这页/这封讲什么"，不做富文本还原 */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * IMAP bodyStructure 里找可读的正文部件。
 * 一个递归同时回答两件事：路径（下载时要）和类型（判断是不是 HTML）——
 * 原来拆成 textPartPath / partTypeOf 两个函数各走一遍树，容易一处改了另一处忘。
 */
export function findTextPart(node: unknown): { path: string; type: string } | null {
  const walk = (n: any, depth = 0): { path: string; type: string } | null => {
    if (!n || depth > 8) return null
    const type = String(n.type ?? '')
    if (/^text\/plain/i.test(type) && n.part) return { path: String(n.part), type }
    if (Array.isArray(n.childNodes)) {
      for (const child of n.childNodes) {
        const hit = walk(child, depth + 1)
        if (hit) return hit
      }
    }
    // 没有纯文本才退到 HTML：由调用方剥标签
    if (/^text\/html/i.test(type) && n.part) return { path: String(n.part), type }
    return null
  }
  return walk(node)
}
