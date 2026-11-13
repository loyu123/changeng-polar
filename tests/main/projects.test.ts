import { describe, expect, it } from 'vitest'
import {
  normalizeProject,
  projectsBlock,
  sameRoot,
  upsertProject,
  validateProjectPath
} from '../../src/main/node/projects'
import { PROJECT_MAX_ENTRIES, type ProjectEntry } from '../../src/shared/types'

/**
 * 项目档案的校验与提示词生成。
 *
 * 这层是"模型会去读哪个目录"的**唯一入口**：收错一个路径，模型就会去读一个
 * 不相干的地方，而用户看不出为什么。所以边界要逐条钉住，特别是
 * 网络路径和相对路径这两类——它们看起来像路径，实际会让读取落到别处。
 */

const ctx = { id: 'p1', now: '2026-11-13T00:00:00.000Z' }
const entry = (patch: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id: 'x',
  name: '报告',
  root: 'D:\\工作\\报告',
  createdAt: ctx.now,
  updatedAt: ctx.now,
  ...patch
})

describe('validateProjectPath', () => {
  it('收本机绝对路径，并归一化末尾分隔符', () => {
    expect(validateProjectPath('D:\\工作\\报告\\', '根目录', false)).toEqual({ ok: true, value: 'D:\\工作\\报告' })
    expect(validateProjectPath('C:/Users/jiabi/Desktop/x', '根目录', false)).toEqual({
      ok: true,
      value: 'C:\\Users\\jiabi\\Desktop\\x'
    })
  })

  it('盘符根目录不被削成空（D:\\ 不是 D:）', () => {
    const r = validateProjectPath('D:\\', '根目录', false)
    expect(r.ok && r.value).toBe('D:\\')
  })

  /**
   * UNC 是重点：连共享目录等于向对方提交本机凭据，
   * 而"看一个项目"用不着付这个代价（和 open_folder / read_file 同一口径）。
   */
  it('拒网络共享路径（两种写法都拒）', () => {
    const a = validateProjectPath('\\\\NAS\\share\\proj', '根目录', false)
    const b = validateProjectPath('//NAS/share/proj', '根目录', false)
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    // 理由要说清代价，不能只说"不允许"
    expect(!a.ok && a.reason).toContain('凭据')
  })

  it('拒相对路径（相对路径的解析基准不确定，会落到不可预期的位置）', () => {
    expect(validateProjectPath('工作\\报告', '根目录', false).ok).toBe(false)
    expect(validateProjectPath('.\\报告', '根目录', false).ok).toBe(false)
    expect(validateProjectPath('报告', '根目录', false).ok).toBe(false)
  })

  it('根目录必填，日志位置可选', () => {
    expect(validateProjectPath('', '根目录', false).ok).toBe(false)
    expect(validateProjectPath('   ', '根目录', false).ok).toBe(false)
    expect(validateProjectPath('', '日志位置', true)).toEqual({ ok: true, value: '' })
  })

  it('空白的可选字段归一成空串，档案里不会留下 logPath: ""', () => {
    const r = normalizeProject({ name: 'x', root: 'D:\\a', logPath: '   ' })
    expect(r.ok).toBe(true)
    expect(r.ok && 'logPath' in r.value).toBe(false)
  })
})

describe('normalizeProject', () => {
  it('项目名折叠空白并去掉首尾空格', () => {
    const r = normalizeProject({ name: '  开题   报告  ', root: 'D:\\a' })
    expect(r.ok && r.value.name).toBe('开题 报告')
  })

  it('没有名字就拒，理由说明为什么要起名', () => {
    const r = normalizeProject({ name: '  ', root: 'D:\\a' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('名字')
  })

  it('名字和说明都有上限', () => {
    expect(normalizeProject({ name: 'x'.repeat(41), root: 'D:\\a' }).ok).toBe(false)
    expect(normalizeProject({ name: 'x', root: 'D:\\a', note: 'y'.repeat(301) }).ok).toBe(false)
    expect(normalizeProject({ name: 'x'.repeat(40), root: 'D:\\a' }).ok).toBe(true)
  })

  it('说明保留换行（进度描述常常是几行）', () => {
    const r = normalizeProject({ name: 'x', root: 'D:\\a', note: '第一行\r\n第二行' })
    expect(r.ok && r.value.note).toBe('第一行\n第二行')
  })

  it('空的说明不进档案', () => {
    const r = normalizeProject({ name: 'x', root: 'D:\\a', note: '   ' })
    expect(r.ok && 'note' in r.value).toBe(false)
  })
})

describe('sameRoot', () => {
  it('Windows 路径比较不区分大小写、不在意分隔符与末尾斜杠', () => {
    expect(sameRoot('D:\\Work\\Proj', 'd:/work/proj/')).toBe(true)
    expect(sameRoot('D:\\Work\\Proj', 'D:\\Work\\Other')).toBe(false)
  })

  it('不会把前缀相同的两个目录判成同一个（D:\\a 与 D:\\ab）', () => {
    expect(sameRoot('D:\\a', 'D:\\ab')).toBe(false)
  })
})

describe('upsertProject', () => {
  it('新增：拿到调用方给的 id 和时间', () => {
    const r = upsertProject([], { name: '报告', root: 'D:\\工作\\报告' }, ctx)
    expect(r.ok).toBe(true)
    expect(r.ok && r.replaced).toBe(false)
    expect(r.ok && r.entry).toMatchObject({ id: 'p1', createdAt: ctx.now, updatedAt: ctx.now })
    expect(r.ok && r.list).toHaveLength(1)
  })

  /**
   * 判据是根目录而不是名字：用户把"报告"改叫"开题报告"是**改名**，
   * 不该变成两条指向同一目录的档案——那会让模型汇报时说两遍。
   */
  it('根目录相同视为同一条：改名不会堆出第二条', () => {
    const first = upsertProject([], { name: '报告', root: 'D:\\工作\\报告' }, ctx)
    if (!first.ok) throw new Error('前置失败')
    const again = upsertProject(first.list, { name: '开题报告', root: 'd:/工作/报告/' }, {
      id: 'p2',
      now: '2026-11-14T00:00:00.000Z'
    })
    expect(again.ok).toBe(true)
    expect(again.ok && again.replaced).toBe(true)
    expect(again.ok && again.list).toHaveLength(1)
    // id 与 createdAt 保留，只有内容与 updatedAt 变
    expect(again.ok && again.entry.id).toBe('p1')
    expect(again.ok && again.entry.createdAt).toBe(ctx.now)
    expect(again.ok && again.entry.updatedAt).toBe('2026-11-14T00:00:00.000Z')
  })

  it('同一条改名后，新的名字要真的生效', () => {
    const first = upsertProject([], { name: '报告', root: 'D:\\a' }, ctx)
    if (!first.ok) throw new Error('前置失败')
    const again = upsertProject(first.list, { name: '开题报告', root: 'D:\\a' }, ctx)
    expect(again.ok && again.list[0].name).toBe('开题报告')
  })

  it('根目录不同就是两个项目（名字撞了也一样）', () => {
    const first = upsertProject([], { name: '报告', root: 'D:\\a' }, ctx)
    if (!first.ok) throw new Error('前置失败')
    const second = upsertProject(first.list, { name: '报告', root: 'D:\\b' }, { id: 'p2', now: ctx.now })
    expect(second.ok && second.list).toHaveLength(2)
  })

  it('有上限，且超限时不给一条半成品', () => {
    const full: ProjectEntry[] = Array.from({ length: PROJECT_MAX_ENTRIES }, (_, i) =>
      entry({ id: `e${i}`, root: `D:\\p${i}` })
    )
    const r = upsertProject(full, { name: '新的', root: 'D:\\new' }, { id: 'new', now: ctx.now })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain(String(PROJECT_MAX_ENTRIES))
  })

  it('超限时，改已有的那条仍然允许（不然满了就动不了）', () => {
    const full: ProjectEntry[] = Array.from({ length: PROJECT_MAX_ENTRIES }, (_, i) =>
      entry({ id: `e${i}`, root: `D:\\p${i}` })
    )
    const r = upsertProject(full, { name: '改个名', root: 'D:\\p0' }, { id: 'ignored', now: ctx.now })
    expect(r.ok).toBe(true)
    expect(r.ok && r.list).toHaveLength(PROJECT_MAX_ENTRIES)
  })

  it('校验失败时原列表一个字都不动', () => {
    const before = [entry()]
    const r = upsertProject(before, { name: 'x', root: '\\\\nas\\share' }, ctx)
    expect(r.ok).toBe(false)
    expect(before).toHaveLength(1)
  })
})

describe('projectsBlock', () => {
  it('空档案不产出任何段落（提示词里不该出现一个空标题）', () => {
    expect(projectsBlock([])).toBe('')
  })

  it('路径原样出现，模型才能直接去读', () => {
    const block = projectsBlock([entry({ logPath: 'D:\\工作\\报告\\log.md' })])
    expect(block).toContain('D:\\工作\\报告')
    expect(block).toContain('D:\\工作\\报告\\log.md')
  })

  it('没填日志/说明时不多出空行', () => {
    const block = projectsBlock([entry()])
    expect(block).not.toContain('进度日志')
    expect(block).not.toContain('说明：')
  })

  /**
   * 这段提示词的成败就在这两句：说成"用户声明的坐标"而不是"已核实的事实"。
   * 少了它，模型会把档案原样复述成现状（"你的项目有 8 个文件"），
   * 而它一个文件都没读过。
   */
  it('明确写出"没读过就不要当成现状"', () => {
    const block = projectsBlock([entry()])
    expect(block).toContain('不是你已经核实过的事实')
    expect(block).toContain('先真的去读')
    expect(block).toContain('读不到就如实说读不到')
  })

  it('多个项目都在，各自带自己的路径', () => {
    const block = projectsBlock([
      entry({ id: 'a', name: '报告', root: 'D:\\a' }),
      entry({ id: 'b', name: '代码', root: 'D:\\b' })
    ])
    expect(block).toContain('D:\\a')
    expect(block).toContain('D:\\b')
    expect(block).toContain('报告')
    expect(block).toContain('代码')
  })
})

describe('盘上的形状不可信（projects.json 那个位置曾是已删除功能的）', () => {
  /**
   * 这条守的是一个真实的升级路径：`projects.json` 这个文件名曾经属于
   * 已删除的「项目/方案/待办」功能，它的 ProjectDef 有 name 没有 root。
   * 档案换了文件名，但从别处拷来的、手改过的半截数据仍可能进来。
   * 缺 root 的条目要是被拼进提示词，模型看到的是「根目录 `undefined`」。
   */
  it('缺 root 的条目不进提示词', () => {
    const broken = [{ id: 'a', name: '老数据', createdAt: '', updatedAt: '' } as unknown as ProjectEntry]
    expect(projectsBlock(broken)).toBe('')
  })

  it('root 是空白字符串的也不进', () => {
    expect(projectsBlock([entry({ root: '   ' })])).toBe('')
  })

  it('好条目旁边有坏条目时，好的照常显示', () => {
    const list = [
      { id: 'bad', name: '老数据', createdAt: '', updatedAt: '' } as unknown as ProjectEntry,
      entry({ id: 'good', name: '报告', root: 'D:\ok' })
    ]
    const block = projectsBlock(list)
    expect(block).toContain('D:\ok')
    expect(block).not.toContain('undefined')
  })

  it('坏条目不会让整段崩（缺 name 也能渲染）', () => {
    const list = [{ id: 'x', root: 'D:\a', createdAt: '', updatedAt: '' } as unknown as ProjectEntry]
    expect(() => projectsBlock(list)).not.toThrow()
    expect(projectsBlock(list)).toContain('D:\a')
  })
})
