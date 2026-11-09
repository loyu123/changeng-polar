import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * winget 的 argv 装配。
 *
 * 这一层不测就没人测：`installWinget` 只把参数摆好交给 execFile，
 * 上面所有测试都把整个模块 mock 掉了，于是"到底带什么标志"这么关键的一件事，
 * 谁都没真看过它发出去的数组。
 *
 * 现在只有一种模式：**必须带 `--interactive`、必须不带 `--silent`**。
 * 曾经有个静默模式，已经删掉——静默安装等于替用户接受了安装器所有默认勾选，
 * 连装到哪个盘都替他决定了，而他批准时什么都没看到。
 * 这条断言就是防止 `--silent` 哪天被顺手加回来。
 */

const captured = vi.hoisted(() => ({
  calls: [] as Array<{ exe: string; args: string[] }>,
  /** 下一次 execFile 回调怎么应答：成功、非零退出码 */
  reply: { stdout: '已成功安装\n', stderr: '', fail: false }
}))

vi.mock('node:child_process', () => ({
  execFile: (
    exe: string,
    args: string[],
    _opts: unknown,
    cb: (err: { code?: number } | null, stdout: string, stderr: string) => void
  ) => {
    captured.calls.push({ exe, args })
    // 同步回调：runWingetOnce 在返回前就 finish，避免测试里出现悬空 timer
    if (captured.reply.fail) {
      // execFile 的失败回调：err.code 是数字退出码
      ;(cb as unknown as (e: { code: number }, o: string, s: string) => void)(
        { code: 1618 },
        captured.reply.stdout,
        captured.reply.stderr
      )
    } else {
      cb(null, captured.reply.stdout, captured.reply.stderr)
    }
    return { kill: () => {} }
  }
}))

const { installWinget } = await import('../../src/main/node/install')

const lastArgs = (): string[] => captured.calls.at(-1)?.args ?? []

beforeEach(() => {
  captured.calls = []
  captured.reply = { stdout: '已成功安装\n', stderr: '', fail: false }
})

describe('installWinget · 参数装配', () => {
  it('带 --interactive，不带 --silent（安装器必须弹给用户看）', async () => {
    await installWinget('Bilibili.Bilibili')
    const args = lastArgs()
    expect(args).toContain('--interactive')
    expect(args).not.toContain('--silent')
    // 仍然是精确 Id，不能退回按名字搜（那会把装的东西交给仓库的匹配结果）
    expect(args).toContain('--exact')
    expect(args[args.indexOf('--id') + 1]).toBe('Bilibili.Bilibili')
  })

  it('保留 --disable-interactivity（管的是 winget 自己的 y/n，不是安装器界面）', async () => {
    // 去掉它会在命令行里等一个用户看不见的确认，脚本直接卡死
    await installWinget('A.B')
    expect(lastArgs()).toContain('--disable-interactivity')
  })

  it('非法包 Id 在发出去之前就被拒绝', async () => {
    await expect(installWinget('..\\evil & calc')).rejects.toThrow(/非法字符/)
    expect(captured.calls).toHaveLength(0)
  })

  it('用户取消安装器时按「取消」上报，不当成失败', async () => {
    // 交互式下这很常见：用户在向导里点了取消，winget 只给一个非零退出码。
    // 不区分的话模型会把用户自己的取消当成"安装失败"念给他听，还劝他再试一次
    captured.reply = { stdout: '安装程序已取消\n', stderr: '', fail: true }
    const outcome = await installWinget('A.B')
    expect(outcome.ok).toBe(false)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.detail).toMatch(/取消/)
  })

  it('没有取消措辞的失败仍然按失败上报（不把任何失败都当取消）', async () => {
    captured.reply = { stdout: '网络连接失败 0x8A150017\n', stderr: '', fail: true }
    const outcome = await installWinget('A.B')
    expect(outcome.ok).toBe(false)
    expect(outcome.cancelled).toBeUndefined()
    expect(outcome.detail).toMatch(/winget 安装失败/)
  })
})
