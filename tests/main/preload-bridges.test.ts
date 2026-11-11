import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * preload 暴露的每个通道都得有渲染层在调。
 *
 * 为什么值得一条测试：这个仓库里同一类问题出过三次。
 *   - `notes:list` / `notes:save`：写它的页面删了，通道和 store 方法留了下来，
 *     于是 `list_installed_apps` 永远带着一个空字段，工具描述还在让模型「优先引用它」。
 *   - `memory:save`：设置页只能看、能删、能清空，加不了——虽然 config.ts 的注释
 *     写着「用户能看、能删、能自己加一条」。
 *   - `orb:open`：球走 toggle、托盘在主进程里直接调 showPanel，这条通道没人走。
 *
 * 三次都不是崩溃，是**一句话说不圆**：能力宣称的和实际能调的通道对不上。
 * 这种缝没人会去测（因为没有报错），所以拿一条会先红的测试钉住。
 *
 * 只看 `invoke`（请求-应答）。`send` / `on` 那类事件通道由主进程单向推，
 * 渲染层在别处监听也说得通，不在这条测试的射程内。
 */

/** 有意留着的空桥：加进这里必须写清为什么，否则下一个人只会看到一条红 */
const INTENTIONALLY_UNUSED = new Set<string>([
  // 目前没有
])

function readTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) readTree(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * 把字符串字面量与注释挖成空格（长度不变，位置不变）。
 *
 * 不这么做的话，`'{'` 这样的字符串、`// {` 这样的注释都会算成括号，
 * 整个深度就歪了——而深度一歪，"这个 invoke 属于哪个对象"就全错。
 */
function blankOut(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const fill = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      fill(i, end < 0 ? n : end)
      i = end < 0 ? n : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      fill(i, end < 0 ? n : end + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1
        j += 1
      }
      // 引号本身也挖掉：它们不影响括号计数
      fill(i, j + 1)
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 这一行的缩进（掩码后按行切，行号与原文一一对应） */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * 从 preload 里读出「渲染层该怎么调 → 通道名」。
 *
 * 按行 + 缩进解析，不数括号。数括号的写法试过两次都不行：
 * 只认具名对象会在 `onPrefs: (...) => {` 上只出栈不入栈，深度整段错位；
 * 改成每个 `{` 都入栈之后，`(id: string) =>` 里的参数名又被当成属性名，
 * 于是 `butler.shell.p -> shell:reveal` 这种假条目一片。
 *
 * 属性名的形状是固定的：**行首缩进 + `name:`**，参数名不可能出现在这个位置。
 * 缩进同时给出了层级：`orb.sessions.list` 是三层缩进，不是三次花括号。
 * 真要写成一行一个通道的其它形状，下面的解析器自检会先红。
 */
function bridgesOf(source: string): Array<{ apiPath: string; channel: string }> {
  // 仓库里的文件是 CRLF：不归一化的话行尾会多一个 `\r`，
  // `(.*)$` 匹配不上、`endsWith('{')` 也不成立，整份文件解析出 0 条而不报错。
  const text = source.replace(/\r\n?/g, '\n')
  const masked = blankOut(text).split('\n')
  const raw = text.split('\n')
  /** 还开着的对象块（`name: {` 与 `name: () => {` 都算） */
  const blocks: Array<{ indent: number; name: string }> = []
  const result: Array<{ apiPath: string; channel: string }> = []
  /** 上一行的 key：给「key 在一行、invoke 在下一行」的写法留着 */
  let pending: { indent: number; name: string } | null = null

  const popDeeperThan = (indent: number): void => {
    while (blocks.length > 0 && blocks[blocks.length - 1].indent >= indent) blocks.pop()
  }

  for (let n = 0; n < masked.length; n += 1) {
    const line = masked[n]
    if (!line.trim()) {
      pending = null
      continue
    }
    const indent = indentOf(line)
    const at = line.indexOf('invoke(')
    const keyMatch = /^\s*([A-Za-z_$][\w$]*):\s*(.*)$/.exec(line)

    if (!keyMatch) {
      // 不是属性行：缩进退回来就说明上面的块关了（`},` 这一行也走这里）
      popDeeperThan(indent)
      if (at >= 0 && pending) {
        const channel = /invoke\(\s*'([^']+)'/.exec(raw[n].slice(at))
        if (channel) {
          const path = ['butler', ...blocks.map((b) => b.name), pending.name].join('.')
          result.push({ apiPath: path, channel: channel[1] })
        }
      }
      pending = null
      continue
    }

    const name = keyMatch[1]
    const rest = keyMatch[2].trimEnd()
    popDeeperThan(indent)

    if (rest.endsWith('{')) {
      // 又开了一层：`sessions: {` / `onPrefs: (...) => {`
      blocks.push({ indent, name })
      pending = null
    } else if (at >= 0) {
      // 一行写完的叶子：`menu: () => ipcRenderer.invoke('orb:menu')`
      const channel = /invoke\(\s*'([^']+)'/.exec(raw[n].slice(at))
      if (channel) {
        const path = ['butler', ...blocks.map((b) => b.name), name].join('.')
        result.push({ apiPath: path, channel: channel[1] })
      }
      pending = null
    } else {
      // key 在这行、值在下一行：`save: (patch) =>` 换行再 `ipcRenderer.invoke(...)`
      pending = { indent, name }
    }
  }
  return result
}

describe('preload 通道与渲染层调用方', () => {
  const root = path.resolve(__dirname, '../..')
  const preload = readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
  // 渲染层源码摊平成一行：`butler.find\n  .all(` 这种换行不该算成"没调用"
  const renderer = readTree(path.join(root, 'src/renderer'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/\s*\n\s*/g, '')

  const bridges = bridgesOf(preload)
  const pathOf = (channel: string): string | undefined => bridges.find((b) => b.channel === channel)?.apiPath

  it('能解析出通道（解析器坏了要先红，而不是静悄悄地全过）', () => {
    expect(bridges.length).toBeGreaterThan(40)
    // 几种嵌套形态都得认对，否则下面的"没人调"是假的
    expect(pathOf('chat:send')).toBe('butler.chat.send')
    expect(pathOf('memory:save')).toBe('butler.memory.save')
    expect(pathOf('orb:sessions:list')).toBe('butler.orb.sessions.list')
    expect(pathOf('orb:menu')).toBe('butler.orb.menu')
    expect(pathOf('shell:reveal')).toBe('butler.shell.reveal')
  })

  it('preload 里每个 invoke 通道都被解析到了一条路径（漏掉的叶子等于没检查）', () => {
    const text = preload.replace(/\r\n?/g, '\n')
    const all = new Set([...text.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]))
    const seen = new Set(bridges.map((b) => b.channel))
    const missed = [...all].filter((ch) => !seen.has(ch))
    expect(missed).toEqual([])
  })

  it('每个通道都有渲染层在调，或者被明确列为"有意留着"', () => {
    const orphaned = bridges
      .filter((b) => !INTENTIONALLY_UNUSED.has(b.apiPath))
      .filter((b) => !new RegExp(b.apiPath.replace(/\./g, '\\.') + '(?![\\w])').test(renderer))
      .map((b) => `${b.apiPath}  ->  ${b.channel}`)
    expect(orphaned).toEqual([])
  })

  it('"有意留着"的名单里不留已经不存在的路径（名单也要跟着代码走）', () => {
    const known = new Set(bridges.map((b) => b.apiPath))
    for (const name of INTENTIONALLY_UNUSED) {
      expect(known.has(name), name).toBe(true)
    }
  })
})
