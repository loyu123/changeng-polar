import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  absolutizeFolderPath,
  isUncPath,
  looksLikeFolderPath,
  matchFolder,
  planFolder,
  resetFolderCache,
  scanFolderIndex,
  setFolderIndexRoots,
  validateFolderPath,
  type FolderCandidate
} from '../../src/main/node/folder'

/**
 * 打开文件夹的解析与边界。
 *
 * 这个工具和「打开程序」共用同一个外壳接口（shell.openPath），而那个接口对文件是
 * **打开/执行**、对目录才是"浏览"。所以这里的每条拒绝都不是洁癖：
 * 放过去就等于给"打开一个文件夹"开了个执行东西的口子。
 */

const tmpDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'butler-folder-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  setFolderIndexRoots(null)
  resetFolderCache()
})

const cand = (name: string, p = `C:\\Users\\me\\Desktop\\${name}`): FolderCandidate => ({
  name,
  path: p,
  source: 'desktop'
})

describe('打开文件夹 · 路径安检', () => {
  it('认得出 UNC 路径（\\\\主机\\共享）', () => {
    expect(isUncPath('\\\\192.168.1.10\\share')).toBe(true)
    expect(isUncPath('\\\\nas\\资料')).toBe(true)
    expect(isUncPath('C:\\Users')).toBe(false)
  })

  /**
   * 连共享目录会先做一次 SMB 登录，把本机的用户名和 NTLM 哈希交给对方。
   * 用户说"打开一个文件夹"，完全不该付这个代价。
   */
  it('网络共享一律拒绝，并说清为什么', () => {
    const checked = validateFolderPath('\\\\192.168.1.10\\share')
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain('凭据')
  })

  it('相对路径 / 盘符缺失的写法不认', () => {
    for (const bad of ['Desktop\\资料', '资料', '..\\..\\Windows']) {
      const checked = validateFolderPath(bad)
      expect(checked.ok, bad).toBe(false)
    }
  })

  /**
   * 有人（或某个网页上的指令）可能拿这个工具"打开"一个 exe。
   * 目录名带 .exe 是极少的，宁可挡住。
   */
  it('带可执行后缀的路径不当文件夹打开', () => {
    const dir = tempDir()
    const trap = path.join(dir, 'setup.exe')
    mkdirSync(trap)
    const checked = validateFolderPath(trap)
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain('执行')
  })

  it('不存在的路径、以及文件（不是目录）都拒绝', () => {
    const dir = tempDir()
    const missing = validateFolderPath(path.join(dir, '没有这个'))
    expect(missing.ok).toBe(false)

    const file = path.join(dir, '笔记.txt')
    writeFileSync(file, 'x')
    const asFile = validateFolderPath(file)
    expect(asFile.ok).toBe(false)
    if (asFile.ok) return
    expect(asFile.reason).toContain('不是文件夹')
  })

  it('真的目录放行，并返回解析后的绝对路径', () => {
    const dir = tempDir()
    const sub = path.join(dir, '应用软件')
    mkdirSync(sub)
    const checked = validateFolderPath(sub)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.path).toBe(path.resolve(sub))
  })
})

describe('打开文件夹 · 按名字挑唯一一个', () => {
  it('名字完全相同就打它，哪怕还有以它开头的别的文件夹', () => {
    const matched = matchFolder('文件', [cand('文件'), cand('文件重要'), cand('文件夹')])
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(matched.folder.name).toBe('文件')
  })

  it('大小写和空格不影响匹配', () => {
    expect(matchFolder('obsidian', [cand('Obsidian')]).ok).toBe(true)
    expect(matchFolder(' Obsidian ', [cand('Obsidian')]).ok).toBe(true)
  })

  it('名字有歧义 → 不猜，把候选列出来', () => {
    const matched = matchFolder('文件', [cand('文件重要'), cand('文件备份')])
    expect(matched.ok).toBe(false)
    if (matched.ok) return
    expect(matched.reason).toContain('文件重要')
    expect(matched.reason).toContain('文件备份')
    expect(matched.reason).toContain('需要用户指定')
  })

  it('一个都不像 → 说清自己认得哪些，并教用户给完整路径', () => {
    const matched = matchFolder('根本不存在的目录', [cand('文件重要')])
    expect(matched.ok).toBe(false)
    if (matched.ok) return
    expect(matched.reason).toContain('桌面')
    expect(matched.reason).toContain('完整路径')
  })

  it('空名字不解析', () => {
    expect(matchFolder('   ', [cand('文件重要')]).ok).toBe(false)
  })
})

describe('打开文件夹 · 给路径就直接校验', () => {
  it('给完整路径就直接校验路径，不在候选里瞎找', () => {
    const dir = tempDir()
    const sub = path.join(dir, '资料')
    mkdirSync(sub)
    const planned = planFolder(sub, [cand('资料', 'C:\\别的地方')])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.folder.path).toBe(path.resolve(sub))
    expect(planned.folder.source).toBe('given')
  })

  it('名字完全相同就打它，哪怕还有以它开头的别的文件夹', () => {
    const dir = tempDir()
    const exact = path.join(dir, '文件')
    mkdirSync(exact)
    const planned = planFolder('文件', [cand('文件', exact), cand('文件重要', path.join(dir, '别的'))])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.folder.name).toBe('文件')
    expect(planned.folder.path).toBe(path.resolve(exact))
  })

  /**
   * 名字匹配和"这个目录现在还在不在"是两件事：扫出来的候选可能已经过期。
   * 这里用真实目录验第二段，用 matchFolder 验第一段。
   */
  it('名字对上了但目录已经没了 → 解析失败，不会返回一个打不开的路径', () => {
    const dir = tempDir()
    const gone = path.join(dir, '刚刚被删掉')
    mkdirSync(gone)
    rmSync(gone, { recursive: true, force: true })
    const planned = planFolder('刚刚被删掉', [cand('刚刚被删掉', gone)])
    expect(planned.ok).toBe(false)
  })
})

describe('打开文件夹 · 空输入', () => {
  it('空名字不解析', () => {
    expect(planFolder('   ', [cand('文件重要')]).ok).toBe(false)
  })
})

describe('打开文件夹 · 像路径还是像名字', () => {
  it('带盘符或带分隔符的当路径看', () => {
    for (const p of ['D:\\资料', 'D:/资料', 'C:\\Users\\me\\Desktop', '..\\x']) {
      expect(looksLikeFolderPath(p), p).toBe(true)
    }
  })

  it('纯名字不当路径看', () => {
    for (const n of ['应用软件', 'Downloads', '文件重要']) {
      expect(looksLikeFolderPath(n), n).toBe(false)
    }
  })
})

/* ================================================================== *
 * 不在桌面上的文件夹
 *
 * 桌面上的文件夹能开之后，用户提的下一条是"D 盘里那个也开得了吗"。
 * 这里两件事要验：深索引真的能扫到盘根往下的目录；「文档\报告」这种
 * 从认得的目录往下写一截的写法能补成绝对路径。
 * ================================================================== */

/** 造一棵 tmp/a/b/c 的树，返回根 */
function tree(): string {
  const root = tempDir()
  mkdirSync(path.join(root, '一级', '二级', '三级'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', '包'), { recursive: true })
  mkdirSync(path.join(root, '.隐藏'), { recursive: true })
  return root
}

describe('深索引 · 扫到盘根往下三层', () => {
  it('子目录进索引，第三层也能扫到，第四层不进', () => {
    const root = tree()
    mkdirSync(path.join(root, '一级', '二级', '三级', '四级'))
    const names = scanFolderIndex([{ dir: root, depth: 3 }]).map((c) => c.name)
    expect(names).toContain('一级')
    expect(names).toContain('二级')
    expect(names).toContain('三级')
    expect(names).not.toContain('四级')
  })

  /**
   * node_modules 这类目录又深又多，收进来会把扫描预算吃光，让真正的用户目录
   * 被挤出索引；点开头的目录是软件配置，用户不会开口要。
   */
  it('构建产物目录和点开头的目录不收', () => {
    const root = tree()
    const names = scanFolderIndex([{ dir: root, depth: 3 }]).map((c) => c.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('包')
    expect(names).not.toContain('.隐藏')
  })

  it('目录不存在 / 读不到 → 跳过，不抛错', () => {
    expect(scanFolderIndex([{ dir: path.join(os.tmpdir(), '根本不存在-xyz'), depth: 3 }])).toEqual([])
  })

  it('深索引里的文件夹能按名字打开（这是"不在桌面上的文件夹"的回归）', () => {
    const root = tree()
    setFolderIndexRoots([{ dir: root, depth: 3 }])
    const planned = planFolder('三级')
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.folder.path).toBe(path.resolve(path.join(root, '一级', '二级', '三级')))
  })
})

describe('名字匹配 · 系统目录优先', () => {
  const system = (name: string, p: string): FolderCandidate => ({ name, path: p, source: 'known' })
  const indexed = (name: string, p = `D:\\${name}`): FolderCandidate => ({ name, path: p, source: 'index' })

  /**
   * 「打开图片」指的是图片库。深索引一上线，D 盘深处很容易就有一个也叫「图片」的目录；
   * 要是把它算进同名候选，用户每次让管家开图片库都会被反问"你说是哪个"，
   * 等于用系统的确定性换了噪音。
   */
  it('系统目录同名时直接打系统目录，不报歧义', () => {
    const matched = matchFolder('图片', [
      system('图片', 'C:\\Users\\me\\Pictures'),
      indexed('图片', 'D:\\图片')
    ])
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(matched.folder.path).toBe('C:\\Users\\me\\Pictures')
  })

  it('同一层里两个都像 → 照样报歧义，不猜', () => {
    const matched = matchFolder('周报', [indexed('周报归档'), indexed('周报备份')])
    expect(matched.ok).toBe(false)
    if (matched.ok) return
    expect(matched.reason).toContain('需要用户指定')
  })
})

describe('补全路径 · 从认得的目录往下写一截', () => {
  const docs = (p: string): FolderCandidate => ({ name: '文档', path: p, source: 'known' })

  it('「文档\\报告」补成 文档目录\\报告', () => {
    const docsDir = 'C:\\Users\\me\\Documents'
    expect(absolutizeFolderPath('文档\\报告', [docs(docsDir)])).toBe(path.join(docsDir, '报告'))
    expect(absolutizeFolderPath('文档/报告', [docs(docsDir)])).toBe(path.join(docsDir, '报告'))
  })

  it('完整路径原样解析，不经过名字匹配', () => {
    expect(absolutizeFolderPath('D:\\资料\\项目', [])).toBe(path.resolve('D:\\资料\\项目'))
  })

  /** 「D:」在 Windows 里严格说指"D 盘的当前目录"，但用户嘴里它就是 D 盘 */
  it('光一个盘符当成那块盘', () => {
    expect(absolutizeFolderPath('D:', [])).toMatch(/^D:\\/)
  })

  it('头一段既不是盘符也不认得 → 补不出来，交给名字匹配兜底', () => {
    expect(absolutizeFolderPath('随便什么\\报告', [docs('C:\\Users\\me\\Documents')])).toBe('')
  })

  it('端到端：「文档\\子目录」能打开真实存在的那个子目录', () => {
    const dir = tempDir()
    const docsDir = path.join(dir, 'Documents')
    const sub = path.join(docsDir, '报告')
    mkdirSync(sub, { recursive: true })
    const planned = planFolder('文档\\报告', [docs(docsDir)])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.folder.path).toBe(path.resolve(sub))
  })

  it('端到端：头一段解不出来时，退回用最后一段名字去找', () => {
    const dir = tempDir()
    const target = path.join(dir, '季度总结')
    mkdirSync(target)
    const planned = planFolder('工作\\季度总结', [cand('季度总结', target)])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.folder.path).toBe(path.resolve(target))
  })

  it('网络路径在补全之前就被挡住，不会被当成"头一段不认得"放过去', () => {
    const planned = planFolder('\\\\192.168.1.10\\share\\资料', [cand('资料', 'C:\\x')])
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toContain('凭据')
  })
})
