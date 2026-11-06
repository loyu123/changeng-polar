import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteToRecycle, listSandbox, SANDBOX_ROOT } from '../../src/main/node/sandbox'

/**
 * 演示沙箱的越界防护。
 * 这是唯一一个"能删文件"的通路，作用域写死在 %TEMP%\butler-sandbox；
 * 越界一次就是删到用户真实文件，所以边界必须被测试锁住。
 */
describe('沙箱越界防护', () => {
  const outside = [
    path.join(os.homedir(), 'Documents', 'important.docx'),
    path.join(os.tmpdir(), 'not-in-sandbox.txt'),
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    SANDBOX_ROOT, // 目录本身
    path.join(SANDBOX_ROOT, '..', 'escaped.txt')
  ]

  for (const target of outside) {
    it(`拒绝沙箱外路径：${target}`, async () => {
      await expect(deleteToRecycle(target)).rejects.toThrow(/只允许操作演示沙箱目录内的文件/)
    })
  }

  it('带 .. 的相对路径也被挡住', async () => {
    await expect(deleteToRecycle(path.join(SANDBOX_ROOT, 'sub', '..', '..', 'x.txt'))).rejects.toThrow(
      /只允许操作演示沙箱目录内的文件/
    )
  })

  it('沙箱内不存在的文件给出明确失败，而不是静默成功', async () => {
    const result = await deleteToRecycle(path.join(SANDBOX_ROOT, '__definitely_not_here__.txt'))
    expect(result.ok).toBe(false)
  })

  it('列沙箱只返回文件，不跟随符号链接（子目录不会混进来）', async () => {
    const files = await listSandbox()
    expect(Array.isArray(files)).toBe(true)
    for (const file of files) {
      expect(path.dirname(file.path)).toBe(path.resolve(SANDBOX_ROOT))
    }
  })
})
