import { describe, expect, it } from 'vitest'
import { createTools } from '../../src/main/agent/tools'

/**
 * 模拟键鼠的三道闸。
 *
 * 这个能力的风险不在"实现对不对"，而在**它能点到屏幕上的任何东西**——
 * 包括长庚自己的授权卡、系统托盘的退出、别的程序的「确定」。
 * 所以这里逐条钉死那三道闸，任何一条失效，用户在手机上点的「允许」就罩不住后面的事：
 *
 * 1. 分档：一律 destroy、必须过卡、永不「始终允许」；
 * 2. 白名单：坐标落到的进程不在名单里，**在 plan 阶段就拒绝**（不弹卡、不执行）；
 * 3. 截图：卡上必须带画面，否则用户是在盲签。
 */

const baseDeps = (allowed: string[]) => ({
  desktopInput: {
    listWindows: async () => [
      { title: '某个网页', process: 'chrome', x: 0, y: 0, width: 800, height: 600 },
      { title: '记事本', process: 'notepad', x: 900, y: 0, width: 400, height: 300 }
    ],
    click: async () => ({ ok: true, detail: 'clicked' }),
    type: async () => ({ ok: true, detail: 'typed' }),
    press: async () => ({ ok: true, detail: 'pressed' }),
    allowedProcesses: () => allowed
  },
  captureScreen: async () => ({
    dataUrl: 'data:image/jpeg;base64,AAAA',
    width: 900,
    height: 500,
    originX: 0,
    originY: 0,
    scale: 0.5
  })
})

const tool = (name: string, deps: ReturnType<typeof baseDeps>) =>
  createTools(deps as never).find((t) => t.name === name)!

describe('模拟键鼠 · 分档与授权要求', () => {
  it('三个输入工具都是 destroy 档，且必须过卡、永不「始终允许」', () => {
    const deps = baseDeps(['chrome'])
    for (const name of ['click_screen', 'type_text', 'press_keys']) {
      const t = tool(name, deps)
      expect(t.effect, name).toBe('destroy')
      expect(t.requiresConfirmation, name).toBe(true)
      expect(t.allowAlways, name).toBe(false)
    }
  })

  it('screen_capture 是只读但标为读取私密内容（整块屏幕什么都可能有）', () => {
    const t = tool('screen_capture', baseDeps([]))
    expect(t.effect).toBe('read')
    expect(t.readsPrivateData).toBe(true)
  })

  it('三个输入工具都声明了 verify（如实说查不到效果，不假装核对过）', async () => {
    const deps = baseDeps(['chrome'])
    for (const name of ['click_screen', 'type_text', 'press_keys']) {
      const v = await tool(name, deps).verify!({}, {} as never, {} as never)
      expect(v.state, name).toBe('unavailable')
      expect(v.fact, name).toContain('无法回查')
    }
  })
})

describe('模拟键鼠 · 白名单是代码层强制', () => {
  it('白名单为空时，点击在 plan 阶段就被拒（不弹卡、不执行）', async () => {
    const deps = baseDeps([])
    const planned = await tool('click_screen', deps).plan!({ x: 400, y: 300, reason: '点保存' }, {} as never)
    expect(planned.ok).toBe(false)
    expect(planned.ok === false && planned.reason).toContain('还没有允许任何程序')
  })

  it('坐标落在白名单外的窗口上 → 拒绝，并说出实际落在哪个程序上', async () => {
    const deps = baseDeps(['notepad'])
    const planned = await tool('click_screen', deps).plan!({ x: 400, y: 300, reason: '点按钮' }, {} as never)
    expect(planned.ok).toBe(false)
    if (planned.ok === false) {
      expect(planned.reason).toContain('chrome')
      expect(planned.reason).toContain('不在允许名单里')
    }
  })

  it('坐标落在白名单内的窗口上 → 放行，并在卡上写明目标窗口', async () => {
    const deps = baseDeps(['chrome', 'notepad'])
    const planned = await tool('click_screen', deps).plan!({ x: 400, y: 300, reason: '点保存' }, {} as never)
    expect(planned.ok).toBe(true)
    if (planned.ok) {
      expect(planned.target.target).toContain('chrome')
      expect(planned.target.impact).toContain('点保存')
    }
  })

  it('坐标上没有窗口（点在桌面空白处）→ 拒绝', async () => {
    const deps = baseDeps(['chrome'])
    const planned = await tool('click_screen', deps).plan!({ x: 5000, y: 5000, reason: '乱点' }, {} as never)
    expect(planned.ok).toBe(false)
    expect(planned.ok === false && planned.reason).toContain('没有可操作的窗口')
  })

  it('type_text / press_keys 也受白名单约束（不传坐标时也要检查名单非空）', async () => {
    const deps = baseDeps([])
    const a = await tool('type_text', deps).plan!({ text: '你好', reason: '填写' }, {} as never)
    const b = await tool('press_keys', deps).plan!({ combo: 'Ctrl+S', reason: '保存' }, {} as never)
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
  })
})

describe('模拟键鼠 · 授权卡必须带截图', () => {
  it('点击的卡上有截图（否则用户是盲签）', async () => {
    const deps = baseDeps(['chrome'])
    const planned = await tool('click_screen', deps).plan!({ x: 400, y: 300, reason: '点保存' }, {} as never)
    expect(planned.ok).toBe(true)
    if (planned.ok) expect(planned.target.screenshot).toContain('data:image/jpeg')
  })

  it('没有截图能力时（评测/离线）不硬编一张假图，而是不给图', async () => {
    const deps = baseDeps(['chrome'])
    delete (deps as { captureScreen?: unknown }).captureScreen
    const planned = await tool('click_screen', deps).plan!({ x: 400, y: 300, reason: '点保存' }, {} as never)
    expect(planned.ok).toBe(true)
    if (planned.ok) expect(planned.target.screenshot).toBeUndefined()
  })
})

describe('模拟键鼠 · 没有注入能力时如实拒绝', () => {
  it('评测环境（没注入 desktopInput）→ 明确说"当前环境不支持"', async () => {
    const t = createTools().find((x) => x.name === 'click_screen')!
    const planned = await t.plan!({ x: 10, y: 10, reason: '测试' }, {} as never)
    expect(planned.ok).toBe(false)
    expect(planned.ok === false && planned.reason).toContain('当前环境不支持')
  })

  it('评测环境截不了图 → screen_capture 如实失败，不是静默返回空', async () => {
    const t = createTools().find((x) => x.name === 'screen_capture')!
    const r = await t.run({ reason: '看看' }, {} as never)
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不支持截屏')
  })
})
