import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readTail, TAIL_DEFAULT_LINES, TAIL_MAX_LINES } from '../../src/main/node/log-tail'

/**
 * 读日志尾部。
 *
 * 这个工具替代的是"read_file 先问长度、再带 offset 读第二次"那两步。
 * 它的三个错法都很安静：
 * 1. 从中间切断多字节字符 → 末尾多一行乱码，模型照抄进结论
 * 2. 把截断当成全文 → "上面还有 3000 行"这件事没人说
 * 3. 日志位置填成目录/二进制 → 解出一堆控制字符喂给模型
 */

let base = ''

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'logtail-'))
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
})

async function write(name: string, content: string | Buffer): Promise<string> {
  const p = path.join(base, name)
  await fs.writeFile(p, content)
  return p
}

describe('基本的取尾', () => {
  it('取最后 N 行，顺序不变', async () => {
    const p = await write('a.log', Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))
    const r = await readTail(p, { lines: 5 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.text).toBe(['line 45', 'line 46', 'line 47', 'line 48', 'line 49'].join('\n'))
    expect(r.value.lines).toBe(5)
  })

  it('行数不够时给全部，不报错', async () => {
    const p = await write('b.log', 'only\nthree\nlines')
    const r = await readTail(p, { lines: 100 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBe(3)
    expect(r.value.truncatedFromStart).toBe(false)
  })

  it('末尾的空行不算内容', async () => {
    const p = await write('c.log', 'a\nb\n\n\n')
    const r = await readTail(p, { lines: 10 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBe(2)
  })

  it('CRLF 也算换行', async () => {
    const p = await write('d.log', 'a\r\nb\r\nc\r\n')
    const r = await readTail(p, { lines: 2 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.text).toBe('b\nc')
  })

  it('空文件：返回空，不是错误', async () => {
    const p = await write('empty.log', '')
    const r = await readTail(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBe(0)
    expect(r.value.text).toBe('')
  })

  it('不存在的文件：如实说读不到', async () => {
    const r = await readTail(path.join(base, 'nope.log'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('读不到')
  })
})

describe('截断（这是它比 read_file 强的唯一理由）', () => {
  /**
   * 一遍就够：read_file 要问总长、再带 offset 读第二次，一轮预算 5 步。
   * 这个工具一次拿到尾巴，并且明确说"上面还有"。
   */
  it('文件比要求看的长：标 truncatedFromStart', async () => {
    const p = await write('t.log', Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'))
    const r = await readTail(p, { lines: 10 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBe(10)
    expect(r.value.truncatedFromStart).toBe(true)
    expect(r.value.text).toContain('l499')
    expect(r.value.text).not.toContain('l480')
  })

  it('超出读取字节上限时也从尾巴读，且不吐半行', async () => {
    // 每行 200 字节 × 5000 行 ≈ 1MB，超过 TAIL_MAX_BYTES
    const big = Array.from({ length: 5000 }, (_, i) => `line-${i}-` + 'x'.repeat(180)).join('\n')
    const p = await write('big.log', big)
    const r = await readTail(p, { lines: 20 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.truncatedFromStart).toBe(true)
    // 每一行都应该是完整的：不能出现半截的 line-N-xxxx
    for (const line of r.value.text.split('\n')) {
      expect(line).toMatch(/^line-\d+-x{180}$/)
    }
  })

  it('行数上限被夹住（不会因为传 99999 就读整个文件）', async () => {
    const p = await write('cap.log', Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n'))
    const r = await readTail(p, { lines: 99_999 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBeLessThanOrEqual(TAIL_MAX_LINES)
  })

  it('默认行数是 TAIL_DEFAULT_LINES', async () => {
    const p = await write('def.log', Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'))
    const r = await readTail(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.lines).toBe(TAIL_DEFAULT_LINES)
  })
})

describe('编码：复用 decodeText 的阶梯', () => {
  /**
   * 日志是中文记事本 / IDE 重定向都可能产出的。UTF-8 解 GBK 会得到替换符，
   * 而模型会把替换符照抄进结论——所以必须走和 read_file 同一条阶梯。
   */
  it('UTF-8 中文正常', async () => {
    const p = await write('u8.log', ['第一行', '第二行', '第三行'].join('\n'))
    const r = await readTail(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.text).toContain('第三行')
    expect(r.value.encoding).toContain('utf-8')
  })

  it('GBK 中文正常（中文 Windows 记事本的老默认编码）', async () => {
    // 「进展顺利」的 GBK 字节
    const gbk = Buffer.from([0xbd, 0xf8, 0xd5, 0xb9, 0xcb, 0xb3, 0xc0, 0xfb])
    const p = await write('gbk.log', Buffer.concat([gbk, Buffer.from('\n'), gbk]))
    const r = await readTail(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.text).toBe('进展顺利\n进展顺利')
    expect(r.value.encoding).toBe('gb18030')
  })

  it('UTF-8 BOM 不留在正文里', async () => {
    const p = await write('bom.log', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题\n内容')]))
    const r = await readTail(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.text.startsWith('﻿')).toBe(false)
    expect(r.value.text).toContain('标题')
  })

  /**
   * 从文件中间开始读时，第一个字符可能是被切断的多字节字符。
   * 丢掉那半行，而不是让它变成替换符出现在结论里。
   */
  it('中文被切断时丢掉首行残片，不吐乱码', async () => {
    const line = '这是一行比较长的中文日志内容用来把文件撑大\n'
    const p = await write('cut.log', line.repeat(600))
    const r = await readTail(p, { lines: 5 })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.truncatedFromStart).toBe(true)
    for (const l of r.value.text.split('\n')) {
      expect(l).toBe('这是一行比较长的中文日志内容用来把文件撑大')
      expect(l).not.toContain('�')
    }
  })
})

describe('日志位置填成目录或二进制', () => {
  /**
   * 真实形态：这个报告项目的进度日志就是 .workbuddy/memory/ 下按天分文件。
   * 让模型自己翻"哪个是今天的"是白烧往返次数，而"最近改的"就是"最近的进展"。
   */
  it('目录：自动挑里面最新的文件，并说明挑的是哪个', async () => {
    const dir = path.join(base, 'logs')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'old.md'), '旧的')
    await new Promise((r) => setTimeout(r, 15))
    await fs.writeFile(path.join(dir, 'new.md'), '新的进展')
    const r = await readTail(dir)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.pickedNewest).toBe('new.md')
    expect(r.value.text).toBe('新的进展')
  })

  it('空目录：如实说没有可读的文件', async () => {
    const dir = path.join(base, 'emptydir')
    await fs.mkdir(dir, { recursive: true })
    const r = await readTail(dir)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('没有文件')
  })

  /**
   * 日志位置填错成 .docx：解出来是控制字符。让模型去总结只会得到幻觉，
   * 所以判掉并说明"这不像文本日志"，而不是把乱码喂进去。
   */
  it('二进制内容：拒掉，不喂给模型', async () => {
    const binary = Buffer.alloc(2048)
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) % 256
    const p = await write('not-a-log.bin', binary)
    const r = await readTail(p)
    expect(r.ok).toBe(false)
    // 断言具体原因，不放宽成"任意失败"：区分"不像文本"和"读不到"是这条测试的意义，
    // 放宽之后走错分支也会通过
    expect(!r.ok && r.reason).toContain('不像文本日志')
  })
})
