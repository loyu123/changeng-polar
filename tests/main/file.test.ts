import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_CHARS,
  HARD_MAX_CHARS,
  decodeText,
  fileKindOf,
  isExecutableFile,
  looksBinary,
  planFile,
  readFileSlice,
  resetFileIndex,
  scanFileIndex,
  setFileIndexRoots,
  unsupportedReason,
  validateFilePath,
  type FileCandidate
} from '../../src/main/node/file'
import { SIMPLE_FONT, simplePdf } from './pdf-fixture'

/**
 * 打开 / 阅读文件。
 *
 * 这一组的重点不是"能不能读"，而是**读错的时候会不会假装读对了**：
 * GBK 文件当成 UTF-8 读会得到一串问号，PDF 硬抠会得到乱码，长文件只读了
 * 前 3000 字却让模型以为读完了——这三种错都会被模型当成事实讲给用户。
 */

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'butler-file-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  setFileIndexRoots(null)
  resetFileIndex()
})

/** 造 GBK 字节：Node 不会生成 GB18030，"中文"这两个字是查表得来的 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

describe('文件 · 路径安检', () => {
  it('网络路径拒绝，并说清为什么', () => {
    const checked = validateFilePath('\\\\192.168.1.10\\share\\a.txt')
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.reason).toContain('凭据')
  })

  it('不是本机绝对路径就不认', () => {
    for (const bad of ['a.txt', '资料\\a.txt', '..\\a.txt']) {
      expect(validateFilePath(bad).ok, bad).toBe(false)
    }
  })

  it('不存在、是目录、是特殊文件都拒绝', () => {
    const dir = tempDir()
    expect(validateFilePath(path.join(dir, '没有这个.txt')).ok).toBe(false)

    const asDir = validateFilePath(dir)
    expect(asDir.ok).toBe(false)
    if (asDir.ok) return
    expect(asDir.reason).toContain('文件夹')
  })

  it('真的文件放行，返回解析后的绝对路径', () => {
    const dir = tempDir()
    const file = path.join(dir, '笔记.txt')
    writeFileSync(file, '内容')
    const checked = validateFilePath(file)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.path).toBe(path.resolve(file))
  })
})

describe('文件 · 哪些能读', () => {
  it('文本和 Office 各有各的归类', () => {
    expect(fileKindOf('a.txt')).toBe('text')
    expect(fileKindOf('a.md')).toBe('text')
    expect(fileKindOf('a.CSV')).toBe('text')
    expect(fileKindOf('README')).toBe('text')
    expect(fileKindOf('a.docx')).toBe('docx')
    expect(fileKindOf('a.xlsx')).toBe('xlsx')
    expect(fileKindOf('a.pptx')).toBe('pptx')
  })

  it('PDF / 老式 .doc/.xls/.ppt 也算能读；图片 / 压缩包 / 音视频 / 程序读不了', () => {
    expect(fileKindOf('a.pdf')).toBe('pdf')
    expect(fileKindOf('合同.PDF')).toBe('pdf')
    // 老式 Office 走 OLE 二进制，和 docx 那套 ZIP 完全不是一回事，所以单独归类
    expect(fileKindOf('a.doc')).toBe('doc')
    expect(fileKindOf('a.xls')).toBe('xls')
    expect(fileKindOf('旧表.XLS')).toBe('xls')
    expect(fileKindOf('旧片.ppt')).toBe('ppt')
    for (const f of ['a.jpg', 'a.png', 'a.zip', 'a.exe', 'a.mp3', 'a.mp4']) {
      expect(fileKindOf(f), f).toBe('unsupported')
    }
  })

  /**
   * 读不了的说明必须是具体的。"这个格式不支持"会让用户再问一遍"为什么"，
   * 而图片、压缩包、程序的原因完全不同（一个是根本没有字，一个是得先解开）。
   */
  it('读不了的原因分格式说清楚，并给出下一步', () => {
    expect(unsupportedReason('C:\\x\\照片.jpg')).toContain('图片')
    expect(unsupportedReason('C:\\x\\包.zip')).toContain('压缩包')
    expect(unsupportedReason('C:\\x\\a.exe')).toContain('程序文件')
    expect(unsupportedReason('C:\\x\\a.xyz')).toContain('用系统默认程序打开')
    // 能读的格式要出现在"能读的是…"那句话里，免得用户以为 PDF / 老 Office 也读不了
    const reason = unsupportedReason('C:\\x\\a.xyz')
    expect(reason).toContain('PDF')
    expect(reason).toContain('.doc/.xls/.ppt')
  })
})

describe('文件 · 会执行的不当"文件"打开', () => {
  it('exe / bat / ps1 / lnk / msi / reg 都算会执行', () => {
    for (const f of ['a.exe', 'a.bat', 'a.cmd', 'a.ps1', 'a.vbs', 'a.lnk', 'a.url', 'a.msi', 'a.reg', 'a.jar']) {
      expect(isExecutableFile(f), f).toBe(true)
    }
  })

  it('普通文档不算', () => {
    for (const f of ['a.txt', 'a.docx', 'a.pdf', 'a.jpg']) {
      expect(isExecutableFile(f), f).toBe(false)
    }
  })
})

describe('文件 · 编码', () => {
  it('UTF-8 原样读出来', () => {
    expect(decodeText(Buffer.from('中文内容', 'utf8'))).toEqual({ text: '中文内容', encoding: 'utf-8' })
  })

  /**
   * 中文 Windows 记事本的默认编码就是 GBK。当 UTF-8 读会得到一串替换字符，
   * 而模型会拿那串问号去"总结"。
   */
  it('GBK 的文件按 GB18030 解对了', () => {
    const decoded = decodeText(GBK_ZHONGWEN)
    expect(decoded.text).toBe('中文')
    expect(decoded.encoding).toBe('gb18030')
  })

  it('带 BOM 的 UTF-8 去掉 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('开头', 'utf8')])
    const decoded = decodeText(buf)
    expect(decoded.text).toBe('开头')
    expect(decoded.encoding).toContain('BOM')
  })

  it('UTF-16LE 带 BOM 也认', () => {
    const body = Buffer.from('宽字符', 'utf16le')
    const decoded = decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
    expect(decoded.text).toBe('宽字符')
    expect(decoded.encoding).toBe('utf-16le')
  })

  it('UTF-16 没有 BOM 时靠空字节特征认出来', () => {
    const decoded = decodeText(Buffer.from('abcdefgh', 'utf16le'))
    expect(decoded.text).toBe('abcdefgh')
    expect(decoded.encoding).toContain('utf-16')
  })

  it('一堆控制字符的"文本"判成二进制', () => {
    expect(looksBinary('正常的中文文本，没有控制字符')).toBe(false)
    expect(looksBinary('\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008'.repeat(50))).toBe(true)
  })
})

describe('文件 · 分段读', () => {
  /** 10000 字：比默认段和硬上限都长，才验得出"一次读不完" */
  const longFile = (): string => {
    const dir = tempDir()
    const file = path.join(dir, '长文.txt')
    writeFileSync(file, '一二三四五六七八九十'.repeat(1000), 'utf8')
    return file
  }

  it('一次读不完时给出 nextOffset，并标明还没到头', () => {
    const file = longFile()
    const out = readFileSlice(file, { maxChars: 500 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.read.totalChars).toBe(10000)
    expect(out.read.text.length).toBe(500)
    expect(out.read.nextOffset).toBe(500)
  })

  it('带 offset 接着读，读到结尾时 nextOffset 是 null', () => {
    const file = longFile()
    const out = readFileSlice(file, { offset: 9900, maxChars: 500 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.read.offset).toBe(9900)
    expect(out.read.nextOffset).toBeNull()
    expect(out.read.text).toBe('一二三四五六七八九十'.repeat(10))
  })

  it('offset 越过结尾 → 明确说没东西可读了，而不是给空串', () => {
    const out = readFileSlice(longFile(), { offset: 99999 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('超过')
  })

  it('maxChars 被夹在硬上限里，参数再大也不会撑爆上下文', () => {
    const out = readFileSlice(longFile(), { maxChars: 999999 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.read.text.length).toBe(HARD_MAX_CHARS)
    expect(out.read.nextOffset).not.toBeNull()
  })

  it('默认一次读多少有定数（不是随手的魔法数字）', () => {
    const out = readFileSlice(longFile())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.read.text.length).toBe(DEFAULT_MAX_CHARS)
  })
})

describe('文件 · 读不了就说读不了', () => {
  it('真 PDF 能读出字（PDF 已经不是"读不了"的那一类了）', () => {
    const dir = tempDir()
    const file = path.join(dir, '简报.pdf')
    writeFileSync(file, simplePdf('BT /F1 12 Tf 72 720 Td (Quarterly report) Tj ET', SIMPLE_FONT), 'latin1')
    const out = readFileSlice(file)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.read.kind).toBe('pdf')
    expect(out.read.text).toBe('Quarterly report')
    expect(out.read.encoding).toContain('PDF')
  })

  it('坏掉的 PDF 如实说读不了，不吐乱码', () => {
    const dir = tempDir()
    const file = path.join(dir, '坏.pdf')
    writeFileSync(file, '%PDF-1.7\n...')
    const out = readFileSlice(file)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('读不了')
  })

  /**
   * 后缀是 .txt，内容其实是 ZIP：当 UTF-8 解会得到一堆控制字符。
   * 放过去等于让模型拿着一堆乱码编出"这份文件说的是…"。
   */
  it('后缀是文本但内容是二进制 → 拒绝', () => {
    const dir = tempDir()
    const file = path.join(dir, '伪装.txt')
    writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]))
    const out = readFileSlice(file)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('不像文字')
  })

  it('坏掉的 docx → 拒绝并给出"可以打开自己看"的出路', () => {
    const dir = tempDir()
    const file = path.join(dir, '坏.docx')
    writeFileSync(file, '这不是一个真正的 docx')
    const out = readFileSlice(file)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('读不了')
    expect(out.reason).toContain('打开')
  })
})

describe('文件 · 按名字找', () => {
  const write = (dir: string, name: string, content = 'x'): string => {
    const full = path.join(dir, name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
    return full
  }

  const fake = (files: Record<string, string>): string => {
    const root = tempDir()
    for (const [name, content] of Object.entries(files)) write(root, name, content)
    setFileIndexRoots([root])
    resetFileIndex()
    return root
  }

  const cand = (name: string, p: string): FileCandidate => ({ name, path: p, source: 'index' })

  it('唯一命中就直接给路径', () => {
    const root = fake({ '报告.docx': 'x' })
    const planned = planFile('报告.docx')
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.file.path).toBe(path.resolve(path.join(root, '报告.docx')))
  })

  it('同名多个 → 列候选，不猜', () => {
    fake({ 'a/报告.docx': 'x', 'b/报告.docx': 'y' })
    const planned = planFile('报告.docx')
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.candidates).toHaveLength(2)
  })

  it('候选按深浅排：浅的在前（用户自己的文件比深层副本更像）', () => {
    const root = tempDir()
    write(root, '报告.docx')
    write(root, 'project/deep/报告.docx')
    write(root, 'x/报告.docx')
    setFileIndexRoots([root])
    resetFileIndex()
    const planned = planFile('报告.docx')
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.candidates?.[0].path).toBe(path.resolve(path.join(root, '报告.docx')))
  })

  /**
   * 「打开报告」没有后缀：更可能是文件夹，或者用户说漏了后缀。
   * 这种情况下去找一个叫"报告"的文件，猜中的概率很低，猜错却很像猜对。
   */
  it('没有后缀就不当文件名找，并提示说清是哪个文件', () => {
    const planned = planFile('报告', [cand('报告', 'C:\\x\\报告')])
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toContain('后缀')
  })

  it('完全不存在的文件名 → 说清自己只在这三个目录里找', () => {
    const planned = planFile('根本没有.docx', [cand('别的.docx', 'C:\\x\\别的.docx')])
    expect(planned.ok).toBe(false)
    if (planned.ok) return
    expect(planned.reason).toContain('桌面')
    expect(planned.reason).toContain('完整路径')
  })

  it('完整路径不经名字匹配，直接校验', () => {
    const dir = tempDir()
    const file = write(dir, '直给.txt', 'hi')
    const planned = planFile(file, [])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.file.source).toBe('given')
  })

  it('目录名能当路径的一段（下载\\报表.txt 之类）：首段认不出时退回按末段名字找', () => {
    const dir = tempDir()
    const file = write(dir, '报表.txt', 'x')
    const planned = planFile('不存在的目录\\报表.txt', [cand('报表.txt', file)])
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.file.name).toBe('报表.txt')
    expect(planned.file.path).toBe(path.resolve(file))
  })
})

describe('文件 · 索引', () => {
  it('不跟进点开头的目录和构建产物', () => {
    const root = tempDir()
    mkdirSync(path.join(root, '.git'), { recursive: true })
    writeFileSync(path.join(root, '.git', 'config'), 'x')
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules', 'a.js'), 'x')
    writeFileSync(path.join(root, '正常.txt'), 'x')
    const names = scanFileIndex([root]).map((f) => f.name)
    expect(names).toEqual(['正常.txt'])
  })

  it('目录读不到 → 跳过，不抛错', () => {
    expect(scanFileIndex([path.join(os.tmpdir(), '根本没有-xyz')])).toEqual([])
  })
})
