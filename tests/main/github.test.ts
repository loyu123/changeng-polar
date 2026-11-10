import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertUploadableFile, ghReady, searchRepos } from '../../src/main/node/github'

/**
 * GitHub 这块锁两条边界：
 * 1. 上传只认白名单目录（带 repo 权限 = 能往用户所有仓库写东西）
 * 2. 搜索空词不发请求（别拿空串去打 API 白烧限额）
 */

describe('assertUploadableFile', () => {
  const roots = ['C:\\Users\\x\\AppData\\Local\\Temp\\butler-sandbox', 'C:\\Users\\x\\orchestrator']

  it('白名单目录里的文件放行', () => {
    expect(assertUploadableFile(path.join(roots[0], '报告.md'), roots).ok).toBe(true)
    expect(assertUploadableFile(path.join(roots[1], 'proj', 'tasks', 'a', 'out.md'), roots).ok).toBe(true)
  })

  it('目录本身也放行（有些 API 要目录）', () => {
    expect(assertUploadableFile(roots[0], roots).ok).toBe(true)
  })

  it('白名单外的路径一律拒绝——这是最关键的一条', () => {
    // 桌面上的文件：这台机器上确实有这个文件，但它不该能被推到你公开仓库去
    expect(assertUploadableFile('C:\\Users\\x\\Desktop\\私密.docx', roots).ok).toBe(false)
    expect(assertUploadableFile('C:\\Windows\\System32\\drivers\\etc\\hosts', roots).ok).toBe(false)
    expect(assertUploadableFile('D:\\项目\\源码.ts', roots).ok).toBe(false)
  })

  it('前缀相同但不在目录里的也拒绝（不能靠字符串前缀蒙过去）', () => {
    // butler-sandbox-evil 和 butler-sandbox 前缀相同，但不是同一个目录
    const evil = path.join(`${roots[0]}-evil`, 'x.md')
    expect(assertUploadableFile(evil, roots).ok).toBe(false)
  })

  it('.. 穿越回白名单内是允许的（路径是真的在里面）', () => {
    expect(assertUploadableFile(path.join(roots[0], 'a', '..', 'b.md'), roots).ok).toBe(true)
  })

  it('.. 穿越出白名单被拒绝', () => {
    expect(assertUploadableFile(path.join(roots[0], '..', '..', 'Desktop', 'x.docx'), roots).ok).toBe(false)
  })

  it('拒绝时给出人话原因', () => {
    const r = assertUploadableFile('C:\\Users\\x\\Desktop\\x.docx', roots)
    expect(r.reason).toMatch(/只允许上传/)
    expect(r.reason).toMatch(/repo 权限/)
  })
})

describe('searchRepos 的前置校验', () => {
  it('空检索词直接返回失败，不去打 API（别白烧限额）', async () => {
    const r = await searchRepos('   ')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/没有给检索词/)
    expect(r.hits).toEqual([])
  })
})

describe('ghReady', () => {
  /**
   * 这条会真的调 `gh`，而 `gh auth status` 在本机偶尔要 5 秒以上
   * （它会顺带探一下网络）。所以给足超时——不然会因为网络慢而假红，
   * 那种红比不测更浪费人。
   */
  it('返回一个明确结论（不抛错），不可用时给出人话原因', async () => {
    const r = await ghReady()
    expect(typeof r.ok).toBe('boolean')
    if (!r.ok) expect(r.reason).toMatch(/gh auth login|登录/)
  }, 30_000)
})
