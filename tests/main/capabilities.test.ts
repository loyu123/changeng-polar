import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITIES,
  describeCapabilities,
  nativeTools,
  normalizeCapability
} from '../../src/main/orchestrator/capabilities'

/**
 * 工具名映射锁的是"换后端不会静默失灵"。
 *
 * 最坑的一种失败：任务写的是 read/write，派给 claude 时原样传过去，
 * claude 不认小写，结果一个工具都用不了——**不报错**，
 * 表现为"模型说什么都做不了"。这种事必须在单测里挡住。
 */

describe('normalizeCapability', () => {
  it('各家大小写写法都归一到同一个能力词', () => {
    for (const raw of ['read', 'Read', 'READ', 'read_file', 'readFile', 'ReadFile']) {
      expect(normalizeCapability(raw)).toBe('read')
    }
  })

  it('写和改分得开（不是所有后端都有独立的 edit）', () => {
    expect(normalizeCapability('write')).toBe('write')
    expect(normalizeCapability('WriteFile')).toBe('write')
    expect(normalizeCapability('edit')).toBe('edit')
    expect(normalizeCapability('apply_patch')).toBe('edit')
  })

  it('命令执行的各种叫法都算 bash', () => {
    for (const raw of ['bash', 'Bash', 'shell', 'exec', 'terminal']) {
      expect(normalizeCapability(raw)).toBe('bash')
    }
  })

  it('带命名空间前缀也能认', () => {
    expect(normalizeCapability('filesystem.read')).toBe('read')
    expect(normalizeCapability('mcp.filesystem.write')).toBe('write')
  })

  it('认不出的返回 null，不猜（猜错等于把工具全禁掉）', () => {
    expect(normalizeCapability('telepathy')).toBeNull()
    expect(normalizeCapability('')).toBeNull()
    expect(normalizeCapability('   ')).toBeNull()
  })
})

describe('nativeTools', () => {
  it('pi 用小写', () => {
    expect(nativeTools('pi', ['read', 'write'])).toEqual(['read', 'write'])
  })

  it('claude 和 codebuddy 用首字母大写（实测小写会一个工具都用不了）', () => {
    expect(nativeTools('claude', ['read', 'write'])).toEqual(['Read', 'Write'])
    expect(nativeTools('codebuddy', ['read', 'write'])).toEqual(['Read', 'Write'])
  })

  it('同一份能力词换个后端会自动翻译，任务本身不用改', () => {
    const caps = ['read', 'write']
    expect(nativeTools('pi', caps)).toEqual(['read', 'write'])
    expect(nativeTools('claude', caps)).toEqual(['Read', 'Write'])
    // 两边表达的是同一件事
    expect(nativeTools('pi', caps).map((s) => s.toLowerCase())).toEqual(
      nativeTools('claude', caps).map((s) => s.toLowerCase())
    )
  })

  it('认不出的能力词被丢掉，不会翻译成垃圾工具名', () => {
    expect(nativeTools('claude', ['read', 'telepathy'])).toEqual(['Read'])
  })

  it('空能力词表就是空工具名表（调用方据此传 --no-tools / 哨兵名）', () => {
    expect(nativeTools('pi', [])).toEqual([])
    expect(nativeTools('claude', [])).toEqual([])
  })

  it('重复写同一个能力只算一次', () => {
    expect(nativeTools('pi', ['read', 'Read', 'read'])).toEqual(['read'])
  })

  it('每个后端对每种能力都有映射，没有漏的', () => {
    for (const backend of ['pi', 'codex', 'codebuddy', 'claude'] as const) {
      for (const cap of ALL_CAPABILITIES) {
        expect(nativeTools(backend, [cap]).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('describeCapabilities', () => {
  it('给人看的说明', () => {
    expect(describeCapabilities(['read', 'write'])).toBe('读、写')
    expect(describeCapabilities(['read', 'write', 'bash'])).toBe('读、写、执行命令')
  })

  it('空表如实说"不给任何工具"', () => {
    expect(describeCapabilities([])).toBe('不给任何工具')
  })

  it('认不出的不算进说明', () => {
    expect(describeCapabilities(['read', 'telepathy'])).toBe('读')
  })
})
