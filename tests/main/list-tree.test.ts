import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  formatListing,
  isInsideRoot,
  listOneLevel,
  listTree,
  LIST_MAX_ENTRIES,
  resolveWithin
} from '../../src/main/node/list-tree'

/**
 * 列目录。
 *
 * 这个工具的全部价值就在**作用域**上：只列项目档案里登记过的根。
 * 一旦 isInsideRoot 判错，它就从"能看项目"变成"能看全盘"，
 * 而这两种能力在界面上长得一模一样——用户看不出区别，所以只能靠测试守。
 *
 * 另外三类错法也要钉住：截断不说明（把"不是全部"当成"全部"）、
 * 读不到静默跳过（让模型以为项目就这么点东西）、跟到符号链接里去（绕开作用域）。
 */

describe('isInsideRoot', () => {
  it('根本身算在里面', () => {
    expect(isInsideRoot('D:\\proj', 'D:\\proj')).toBe(true)
    expect(isInsideRoot('D:\\proj', 'D:\\proj\\a\\b.txt')).toBe(true)
  })

  it('大小写和分隔符不影响判断（Windows 语义）', () => {
    expect(isInsideRoot('D:\\Proj', 'd:/proj/a.txt')).toBe(true)
  })

  /**
   * 这条是重点：`D:\proj-evil` 以 `D:\proj` 开头，纯字符串前缀判断会放行。
   * 前缀必须带上分隔符。
   */
  it('前缀相同但不是一个目录的不算（D:\\proj vs D:\\proj-evil）', () => {
    expect(isInsideRoot('D:\\proj', 'D:\\proj-evil\\secret.txt')).toBe(false)
    expect(isInsideRoot('D:\\proj', 'D:\\project')).toBe(false)
  })

  it('上级目录不算', () => {
    expect(isInsideRoot('D:\\proj\\sub', 'D:\\proj')).toBe(false)
    expect(isInsideRoot('D:\\proj', 'D:\\')).toBe(false)
    expect(isInsideRoot('D:\\proj', 'C:\\Windows')).toBe(false)
  })

  it('用 .. 爬出去的不算', () => {
    expect(isInsideRoot('D:\\proj', 'D:\\proj\\..\\secret.txt')).toBe(false)
  })
})

describe('resolveWithin', () => {
  const root = 'D:\\work\\proj'

  it('空 = 根本身', () => {
    expect(resolveWithin(root, '')).toBe(path.resolve(root))
    expect(resolveWithin(root, undefined)).toBe(path.resolve(root))
  })

  it('相对子目录解析到根底下', () => {
    expect(resolveWithin(root, '.workbuddy/memory')).toBe(path.resolve(root, '.workbuddy/memory'))
  })

  it('根底下的绝对路径也收', () => {
    expect(resolveWithin(root, 'D:\\work\\proj\\a')).toBe(path.resolve('D:\\work\\proj\\a'))
  })

  it('越界的绝对路径拒绝', () => {
    expect(resolveWithin(root, 'C:\\Windows\\System32')).toBeNull()
    expect(resolveWithin(root, 'D:\\work\\other')).toBeNull()
  })

  it('用 .. 爬出去拒绝', () => {
    expect(resolveWithin(root, '..\\..\\Windows')).toBeNull()
    expect(resolveWithin(root, 'a/../../../etc')).toBeNull()
  })
})

describe('listTree / listOneLevel（真磁盘，临时目录）', () => {
  let base = ''
  let root = ''

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'list-tree-'))
    root = path.join(base, 'proj')
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.writeFile(path.join(root, 'README.md'), '# 项目\n')
    await fs.writeFile(path.join(root, 'src', 'main.ts'), 'export {}\n')
    await fs.writeFile(path.join(root, 'src', 'deep', 'x.ts'), '// x\n')
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '// dep\n')
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]\n')
  })

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
  })

  it('列出文件和子目录，路径是相对根的', async () => {
    const r = await listTree(root, root)
    const paths = r.entries.map((e) => e.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src')
    expect(paths).toContain('src/main.ts')
    // 相对路径里不该出现绝对路径
    expect(paths.every((p) => !p.includes(base))).toBe(true)
  })

  /**
   * 跳过规则和文件夹索引 / file.ts 的文件索引是同一套（shouldSkipDirName）：
   * node_modules 和 .git 不进去。不然"这个项目有什么"会被几万个依赖文件淹没。
   */
  it('不钻进 node_modules 和 .git（和其余索引同一套跳过规则）', async () => {
    const r = await listTree(root, root)
    expect(r.entries.some((e) => e.path.startsWith('node_modules'))).toBe(false)
    expect(r.entries.some((e) => e.path.startsWith('.git'))).toBe(false)
  })

  it('带大小和修改时间（问"最近改了什么"要用）', async () => {
    const r = await listTree(root, root)
    const readme = r.entries.find((e) => e.path === 'README.md')
    expect(readme?.size).toBeGreaterThan(0)
    expect(readme?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('按扩展名统计', async () => {
    const r = await listTree(root, root)
    expect(r.byExt['.md']).toBe(1)
    expect(r.byExt['.ts']).toBe(2)
  })

  it('深度受限：depth=1 时只到第一层', async () => {
    const r = await listTree(root, root, 1)
    expect(r.entries.some((e) => e.path === 'src')).toBe(true)
    expect(r.entries.some((e) => e.path === 'src/main.ts')).toBe(false)
  })

  it('只列某个子目录', async () => {
    const r = await listTree(root, path.join(root, 'src'))
    const paths = r.entries.map((e) => e.path)
    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('README.md')
  })

  it('单层列表：目录在前、文件在后', async () => {
    const layer = await listOneLevel(root, root)
    const kinds = layer.entries.map((e) => e.kind)
    const firstFile = kinds.indexOf('file')
    const lastDir = kinds.lastIndexOf('dir')
    if (firstFile !== -1 && lastDir !== -1) expect(lastDir).toBeLessThan(firstFile)
  })

  it('不存在的目录：如实记成读不到，不假装是空目录', async () => {
    const layer = await listOneLevel(root, path.join(root, 'no-such-dir'))
    expect(layer.entries).toHaveLength(0)
    expect(layer.unreadable).toHaveLength(1)
    // 关键区别：空目录 vs 读不到，两者在结果里必须能分开
    expect(layer.unreadable[0].path).toContain('no-such-dir')
  })

  /**
   * 符号链接指向根外面：必须当成普通条目，不能跟进去。
   * 跟进去等于绕开作用域——这是这个工具唯一的边界。
   */
  it('不跟随指向根外的符号链接', async () => {
    const linkPath = path.join(root, 'escape-link')
    try {
      await fs.symlink(base, linkPath, 'junction')
    } catch {
      return // 没权限建链接（非开发者模式），跳过这一条
    }
    const r = await listTree(root, root)
    // 链接本身可以出现在清单里，但绝不该把 base 的内容带出来
    expect(r.entries.some((e) => e.path.includes('escape-link') && e.kind === 'dir')).toBe(false)
    expect(r.entries.some((e) => e.path.includes('proj'))).toBe(false)
  })

  it('条目上限：超了要标 truncated，而不是悄悄少给', async () => {
    const big = path.join(base, 'big')
    await fs.mkdir(big, { recursive: true })
    for (let i = 0; i < LIST_MAX_ENTRIES + 20; i++) {
      await fs.writeFile(path.join(big, `f${i}.txt`), 'x')
    }
    const r = await listTree(big, big)
    expect(r.entries.length).toBeLessThanOrEqual(LIST_MAX_ENTRIES)
    expect(r.truncated).toBe(true)
  })
})

describe('formatListing', () => {
  const result = {
    root: 'D:\\proj',
    entries: [
      { path: 'src', name: 'src', kind: 'dir' as const, mtime: '2026-11-13T00:00:00.000Z' },
      { path: 'README.md', name: 'README.md', kind: 'file' as const, size: 2048, mtime: '2026-11-13T00:00:00.000Z' }
    ],
    truncated: false,
    dirsScanned: 2,
    unreadable: [],
    skipped: [],
    byExt: { '.md': 1 }
  }

  it('目录和文件分开列，文件带大小', () => {
    const text = formatListing(result)
    expect(text).toContain('目录：')
    expect(text).toContain('文件：')
    expect(text).toContain('2KB')
  })

  /** 截断必须写在给模型的那段文字里，不能只放在 data 字段里等它去找 */
  it('截断时明说"这不是全部"', () => {
    const text = formatListing({ ...result, truncated: true })
    expect(text).toContain('截断')
    expect(text).toContain('不是全部')
  })

  it('读不到的部分要列出来（静默跳过会让模型以为项目就这么点）', () => {
    const text = formatListing({ ...result, unreadable: [{ path: 'vault', reason: 'EACCES' }] })
    expect(text).toContain('读不到')
    expect(text).toContain('vault')
  })

  it('文件按修改时间倒序（问进展时最近动过的是线索）', () => {
    const text = formatListing({
      ...result,
      entries: [
        { path: 'old.md', name: 'old.md', kind: 'file' as const, size: 1, mtime: '2020-01-01T00:00:00.000Z' },
        { path: 'new.md', name: 'new.md', kind: 'file' as const, size: 1, mtime: '2026-11-13T00:00:00.000Z' }
      ]
    })
    expect(text.indexOf('new.md')).toBeLessThan(text.indexOf('old.md'))
  })

  it('空项目不崩（只有根和计数）', () => {
    expect(() => formatListing({ ...result, entries: [], byExt: {} })).not.toThrow()
  })
})

describe('链接：列出来但不进去', () => {
  /**
   * 两个错法各偏一边：
   * - 跟进去 → 绕开作用域，能读到项目外的东西
   * - 完全跳过 → 清单里凭空少一个目录，模型会断言"这个项目没有它"
   * 正确做法是**列出来、标明是链接、说清没跟进去**。
   */
  it('指向根外的链接出现在清单里，但内容不会泄漏', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lnk-'))
    try {
      const root = path.join(base, 'proj')
      const outside = path.join(base, 'outside')
      await fs.mkdir(root, { recursive: true })
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(outside, 'SECRET.txt'), 'secret')
      let linked = true
      try {
        await fs.symlink(outside, path.join(root, 'link-out'), 'junction')
      } catch {
        linked = false // 非开发者模式下没有建链接的权限
      }
      if (!linked) return

      const r = await listTree(root, root)
      const link = r.entries.find((e) => e.path === 'link-out')
      expect(link?.kind).toBe('link')
      // 关键：外面那个文件绝不能出现在清单里
      expect(JSON.stringify(r.entries)).not.toContain('SECRET')
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('提示文字里说明了为什么没跟进去', () => {
    const text = formatListing({
      root: 'D:\proj',
      entries: [{ path: 'vendor', name: 'vendor', kind: 'link' as const, mtime: '' }],
      truncated: false,
      dirsScanned: 1,
      unreadable: [],
      skipped: [],
      byExt: {}
    })
    expect(text).toContain('vendor')
    expect(text).toContain('没有跟进去')
  })
})

describe('点开头的目录：这里的规则和文件索引不同', () => {
  /**
   * 真机踩到过：这个报告项目的进度日志在 `.workbuddy/memory/`，
   * PPT 构建日志在 `.slidep/`。`shouldSkipDirName` 会跳过**所有**点开头目录
   * （对文件索引正确），照搬过来的话模型列完项目会说"没看到进度记录"，
   * 而记录明明在那儿。
   *
   * 所以项目清单只跳过**已知是噪音**的那批，其余点开头目录照常列出。
   */
  it('列出 .workbuddy 这类有意义的点开头目录', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dot-'))
    try {
      const root = path.join(base, 'proj')
      await fs.mkdir(path.join(root, '.workbuddy', 'memory'), { recursive: true })
      await fs.writeFile(path.join(root, '.workbuddy', 'memory', '2026-11-13.md'), '进度')
      const r = await listTree(root, root)
      expect(r.entries.some((e) => e.path === '.workbuddy')).toBe(true)
      expect(r.entries.some((e) => e.path === '.workbuddy/memory/2026-11-13.md')).toBe(true)
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('噪音目录仍然跳过，但要报名字（不然模型会断言"没有 node_modules"）', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'noise-'))
    try {
      const root = path.join(base, 'proj')
      await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
      await fs.mkdir(path.join(root, 'dist'), { recursive: true })
      await fs.writeFile(path.join(root, 'app.ts'), 'x')
      const r = await listTree(root, root)
      expect(r.entries.some((e) => e.path.startsWith('node_modules'))).toBe(false)
      expect(r.skipped).toContain('node_modules')
      expect(r.skipped).toContain('dist')
      // 报名字不等于列内容
      expect(JSON.stringify(r.entries)).not.toContain('node_modules')
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe('跳过 build 这类名字是模糊的', () => {
  /**
   * `build`/`dist` 通常是产物，但在别的项目里可能是构建脚本目录——
   * 这个报告项目的 `.workbuddy/build/` 里就是 build_report.py，
   * 正是生成报告的代码。所以两条都要成立：
   * ① 默认不列内容（免得把产物塞满清单）
   * ② 但要说清"还能单独指定它来看"，否则模型会回答"没有构建脚本"
   */
  it('默认跳过，但提示里给出"单独指定"的出路', () => {
    const text = formatListing({
      root: 'D:\proj',
      entries: [],
      truncated: false,
      dirsScanned: 1,
      unreadable: [],
      skipped: ['build'],
      byExt: {}
    })
    expect(text).toContain('build')
    expect(text).toContain('单独')
  })

  it('把 dir 指到被跳过的目录能真的列出来（脚本和产物都在）', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'build-'))
    try {
      const root = path.join(base, 'proj')
      await fs.mkdir(path.join(root, 'build'), { recursive: true })
      await fs.writeFile(path.join(root, 'build', 'build_report.py'), '# code\n')
      // 整个项目：build 被跳过
      const whole = await listTree(root, root)
      expect(whole.entries.some((e) => e.path.includes('build_report.py'))).toBe(false)
      // 指定它：内容真的出来了
      const inside = await listTree(root, path.join(root, 'build'))
      expect(inside.entries.some((e) => e.path.endsWith('build_report.py'))).toBe(true)
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
