import { describe, expect, it, vi } from 'vitest'
import { InstallJobs } from '../../src/main/node/install-jobs'

/**
 * 后台安装的任务清单。
 *
 * 这份清单是"安装不占住整轮对话"的全部状态：界面靠它显示还在装什么，
 * 用户靠它取消，装完靠它通知。所以重点不是"能不能存一条"，而是
 * 状态不会被写歪——取消之后又正常退出，不能翻成"装好了"。
 */

const spec = { name: '网易云音乐', pkgId: 'NetEase.CloudMusic', version: '2.10.6' }

describe('InstallJobs', () => {
  it('开始时就在清单里，状态是 running', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    const list = jobs.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: job.id,
      name: '网易云音乐',
      pkgId: 'NetEase.CloudMusic',
      version: '2.10.6',
      status: 'running'
    })
    expect(list[0].finishedAt).toBeUndefined()
    expect(jobs.runningCount()).toBe(1)
  })

  it('结束之后状态和那句话都留下，runningCount 归零', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    job.finish('ok', '已通过 winget 安装「网易云音乐」（NetEase.CloudMusic）')
    const [view] = jobs.list()
    expect(view.status).toBe('ok')
    expect(view.detail).toContain('已通过 winget 安装')
    expect(view.finishedAt).toBeTruthy()
    expect(jobs.runningCount()).toBe(0)
  })

  it('取消只对还在跑的生效；已经结束的返回 false，状态不被改写', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    job.finish('cancelled', '用户点了取消')
    expect(jobs.cancel(job.id)).toBe(false)
    expect(jobs.list()[0].status).toBe('cancelled')
  })

  it('取消会把交给调用方的那个 signal 打断', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    const onAbort = vi.fn()
    job.signal.addEventListener('abort', onAbort)
    expect(jobs.cancel(job.id)).toBe(true)
    expect(job.signal.aborted).toBe(true)
    expect(onAbort).toHaveBeenCalledOnce()
  })

  it('取消只打断等待，不改状态：装没装以 finish 说的话为准', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    expect(jobs.cancel(job.id)).toBe(true)
    // 按了「不等了」不等于机器上什么都没发生——状态要等安装器给答案
    expect(jobs.list()[0].status).toBe('running')
    job.finish('cancelled', '安装被中止（用户停止）')
    expect(jobs.list()[0].status).toBe('cancelled')
  })

  it('抢在取消那一刻装完了：如实记成装上了，不跟着按钮翻成「已取消」', () => {
    const jobs = new InstallJobs()
    const job = jobs.start(spec)
    jobs.cancel(job.id)
    // 这一点点窗口里 winget 其实已经装完了：真相优先于用户按了哪个按钮
    job.finish('ok', '已通过 winget 安装「网易云音乐」')
    expect(jobs.list()[0].status).toBe('ok')
    expect(jobs.list()[0].detail).toContain('已通过 winget 安装')
  })

  it('同一个 id 只收尾一次：重复 finish 不会改状态也不会重复通知', () => {
    const jobs = new InstallJobs()
    const onFinish = vi.fn()
    jobs.onFinish = onFinish
    const job = jobs.start(spec)
    job.finish('ok', '装好了')
    job.finish('failed', '又失败了')
    expect(jobs.list()[0].status).toBe('ok')
    expect(onFinish).toHaveBeenCalledOnce()
  })

  it('不存在的 id 取消返回 false，不抛错', () => {
    const jobs = new InstallJobs()
    expect(jobs.cancel('install_nope')).toBe(false)
  })

  it('正在跑的排在前面，同状态按开始时间倒序', () => {
    const jobs = new InstallJobs()
    const first = jobs.start({ ...spec, name: '第一个' })
    const second = jobs.start({ ...spec, name: '第二个' })
    first.finish('ok', '装好了')
    const list = jobs.list()
    expect(list[0].name).toBe('第二个')
    expect(list[0].status).toBe('running')
    expect(list[1].name).toBe('第一个')
    expect(second.id).not.toBe(first.id)
  })

  it('状态一变就广播一次当前清单；结束时另外通知一声', () => {
    const jobs = new InstallJobs()
    const changes: number[] = []
    const finished: string[] = []
    jobs.onChange = (list) => changes.push(list.length)
    jobs.onFinish = (view) => finished.push(`${view.name}:${view.status}`)

    const job = jobs.start(spec)
    job.finish('ok', '装好了')
    // 开始一次、结束一次；收尾那次的状态已经能在广播里看到了
    expect(changes).toEqual([1, 1])
    expect(finished).toEqual(['网易云音乐:ok'])
    expect(jobs.list()[0].status).toBe('ok')
  })

  it('clearFinished 只清已结束的，还在装的不动', () => {
    const jobs = new InstallJobs()
    const done = jobs.start({ ...spec, name: '装完了的' })
    const running = jobs.start({ ...spec, name: '还在装的' })
    done.finish('ok', '装好了')
    jobs.clearFinished()
    const list = jobs.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(running.id)
  })

  it('list 返回的是副本：外面改了不会影响清单自己', () => {
    const jobs = new InstallJobs()
    jobs.start(spec)
    const list = jobs.list()
    list[0].status = 'ok'
    expect(jobs.list()[0].status).toBe('running')
  })
})
