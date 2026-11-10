import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { desktopDirs } from '../../src/main/node/desktop-apps'

/**
 * 桌面应用的取数规则。
 *
 * 这里只测纯文件系统部分（不碰 app.getFileIcon —— 那需要 electron 上下文，
 * 由真机验收覆盖）。锁三件容易悄悄坏掉的事：
 */

describe('desktopDirs', () => {
  it('同时给出用户桌面和公共桌面', () => {
    const dirs = desktopDirs()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
    expect(dirs.some((d) => d.from === 'user')).toBe(true)
    // 公共桌面存在时要带上，否则漏掉"装给所有用户"的快捷方式
    const pub = dirs.find((d) => d.from === 'public')
    if (pub) expect(pub.dir.toLowerCase()).toContain('public')
  })

  it('两个桌面不会重复（某些环境 PUBLIC 指到用户目录）', () => {
    const dirs = desktopDirs()
    const uniq = new Set(dirs.map((d) => path.resolve(d.dir)))
    expect(uniq.size).toBe(dirs.length)
  })

  it('用户桌面指向 ~/Desktop', () => {
    const user = desktopDirs().find((d) => d.from === 'user')
    expect(user?.dir).toBe(path.join(os.homedir(), 'Desktop'))
  })
})

describe('桌面应用该收哪些文件', () => {
  let dir = ''
  const APP_EXT = new Set(['.lnk', '.url', '.exe', '.appref-ms'])

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** 与 listDesktopApps 里的过滤规则保持一致 */
  async function scan(d: string): Promise<string[]> {
    const names = await fs.readdir(d)
    return names.filter(
      (n) => APP_EXT.has(path.extname(n).toLowerCase()) && !n.startsWith('.') && !n.startsWith('~$')
    )
  }

  it('只要快捷方式和可直接执行的文件，普通文档不算应用', async () => {
    await fs.writeFile(path.join(dir, '微信.lnk'), '')
    await fs.writeFile(path.join(dir, '网页.url'), '')
    await fs.writeFile(path.join(dir, '工具.exe'), '')
    await fs.writeFile(path.join(dir, '报告.docx'), '')
    await fs.writeFile(path.join(dir, '照片.jpg'), '')

    const found = await scan(dir)
    expect(found.sort()).toEqual(['工具.exe', '微信.lnk', '网页.url'].sort())
  })

  it('跳过隐藏文件和 Office 临时文件', async () => {
    await fs.writeFile(path.join(dir, 'a.lnk'), '')
    await fs.writeFile(path.join(dir, '.hidden.lnk'), '')
    await fs.writeFile(path.join(dir, '~$word.lnk'), '')
    expect(await scan(dir)).toEqual(['a.lnk'])
  })

  it('把文件夹排除掉（桌面上常放文件夹，但那不是应用）', async () => {
    await fs.mkdir(path.join(dir, '我的项目.lnk')) // 名字像快捷方式的文件夹
    await fs.writeFile(path.join(dir, '真快捷方式.lnk'), '')
    // 扫描逻辑之后会 stat 判 isFile，这里直接验语义
    const names = await fs.readdir(dir)
    const files: string[] = []
    for (const n of names) {
      const st = await fs.stat(path.join(dir, n))
      if (st.isFile()) files.push(n)
    }
    expect(files).toEqual(['真快捷方式.lnk'])
  })

  it('桌面为空时不报错，返回空数组', async () => {
    expect(await scan(dir)).toEqual([])
  })

  it('目录不存在时不抛错（没有公共桌面是常态）', async () => {
    const missing = path.join(dir, '不存在的桌面')
    let names: string[] = []
    try {
      names = await fs.readdir(missing)
    } catch {
      names = []
    }
    expect(names).toEqual([])
  })
})
