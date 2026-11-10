import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, parseClaudeOutput } from '../../src/main/orchestrator/backends/claude'
import {
  buildCodebuddyArgs,
  parseCodebuddyOutput,
  resolveCodebuddyInvocation
} from '../../src/main/orchestrator/backends/codebuddy'
import { buildCodexArgs, parseCodexJsonl } from '../../src/main/orchestrator/backends/codex'
import { buildPiArgs } from '../../src/main/orchestrator/backends/pi'
import { ALL_BACKENDS, BACKEND_INFO, assertWorkerConfig, createBackend } from '../../src/main/orchestrator/worker'

/**
 * 后端适配层锁的几条，都是真机上踩出来的：
 * 1. 提示词不能进命令行参数（Windows 过 shell 会被拆碎）
 * 2. 变参选项会吞掉后面的位置参数
 * 3. 警告不等于失败
 * 4. 永远不放开权限
 */

describe('pi 后端', () => {
  it('必须显式带 provider 和 model', () => {
    const args = buildPiArgs({ provider: 'eepseek', model: 'deepseek-v4-flash', tools: ['read'], timeoutMs: 1000 })
    expect(args).toEqual(expect.arrayContaining(['--provider', 'eepseek', '--model', 'deepseek-v4-flash']))
  })

  it('工具清单为空时传 --no-tools', () => {
    const args = buildPiArgs({ provider: 'p', model: 'm', tools: [], timeoutMs: 1000 })
    expect(args).toContain('--no-tools')
  })

  it('带空格或引号的值直接拒绝（给 shell 开口子）', () => {
    expect(() => buildPiArgs({ provider: 'a b', model: 'm', tools: [], timeoutMs: 1 })).toThrow(/非法字符/)
  })
})

describe('codex 后端', () => {
  it('沙箱只在这两档之间选，绝不出现危险档', () => {
    const ro = buildCodexArgs({ write: false, timeoutMs: 1 })
    const rw = buildCodexArgs({ write: true, timeoutMs: 1 })
    expect(ro).toEqual(expect.arrayContaining(['-s', 'read-only']))
    expect(rw).toEqual(expect.arrayContaining(['-s', 'workspace-write']))
    for (const args of [ro, rw]) {
      expect(args.join(' ')).not.toContain('danger-full-access')
      expect(args.join(' ')).not.toContain('dangerously-bypass')
    }
  })

  it('提示词不进参数（走 stdin）', () => {
    const args = buildCodexArgs({ write: false, timeoutMs: 1 })
    expect(args.some((a) => a.includes('提示词'))).toBe(false)
  })

  it('非 git 目录要跳过 git 检查', () => {
    expect(buildCodexArgs({ write: false, timeoutMs: 1 })).toContain('--skip-git-repo-check')
  })

  it('配置警告不算失败（codex 把它发成 error 项，实测踩过）', () => {
    const stdout = [
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting. `disable_response_storage` is ignored.' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '可用' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } })
    ].join('\n')
    const r = parseCodexJsonl(stdout)
    expect(r.hardError).toBeUndefined()
    expect(r.text).toBe('可用')
    expect(r.usage).toEqual({ input_tokens: 10 })
  })

  it('真正的错误才算硬错', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'error', message: 'authentication failed: invalid api key' }
    })
    expect(parseCodexJsonl(stdout).hardError).toMatch(/authentication/i)
  })

  it('命令执行会被数成工具调用', () => {
    const stdout = [
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'completed' } })
    ].join('\n')
    const r = parseCodexJsonl(stdout)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('command_execution')
    expect(r.toolCalls[0].ok).toBe(true)
  })
})

describe('claude 后端', () => {
  it('提示词不进参数，且 --allowedTools 放最后（它是变参，会吞掉后面的东西）', () => {
    const args = buildClaudeArgs({ tools: ['Read', 'Write'], timeoutMs: 1 })
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThan(0)
    // --allowedTools 之后只有工具名
    expect(args.slice(idx + 1)).toEqual(['Read', 'Write'])
    // -p 之后没有提示词（靠 stdin）
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('--output-format')
  })

  it('工具清单为空时给一个不存在的工具名，等于一个都不允许', () => {
    const args = buildClaudeArgs({ tools: [], timeoutMs: 1 })
    const idx = args.indexOf('--allowedTools')
    expect(args.slice(idx + 1)).toEqual(['__polar_no_tools__'])
  })

  it('永不传跳过权限的参数', () => {
    const args = buildClaudeArgs({ tools: ['Read'], timeoutMs: 1 }).join(' ')
    expect(args).not.toContain('dangerously-skip-permissions')
    expect(args).not.toContain('bypassPermissions')
  })

  it('解析 JSON 结果，并把花费单独提出来', () => {
    const r = parseClaudeOutput(
      JSON.stringify({ result: '可用', total_cost_usd: 0.067, usage: { input_tokens: 100 } })
    )
    expect(r.text).toBe('可用')
    expect((r.usage as { total_cost_usd?: number }).total_cost_usd).toBeCloseTo(0.067)
  })
})

describe('codebuddy 后端', () => {
  it('提示词不进参数，且工具清单用逗号连成一个参数', () => {
    const args = buildCodebuddyArgs({ tools: ['Read'], timeoutMs: 1 })
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--tools', 'Read'])
  })

  it('给了写工具才加 acceptEdits（非交互下不写这个，Write 会被权限拦住）', () => {
    expect(buildCodebuddyArgs({ tools: ['Read'], timeoutMs: 1 })).not.toContain('--permission-mode')
    const withWrite = buildCodebuddyArgs({ tools: ['Read', 'Write'], timeoutMs: 1 })
    expect(withWrite).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']))
  })

  it('用 acceptEdits 而不是 bypassPermissions：只放行文件编辑，不放行危险命令', () => {
    const args = buildCodebuddyArgs({ tools: ['Read', 'Write'], timeoutMs: 1 }).join(' ')
    expect(args).not.toContain('bypassPermissions')
    expect(args).not.toContain('dangerously-skip-permissions')
  })

  it('工具清单为空时用哨兵名，不用空串（空串会被 shell 吃掉）', () => {
    const args = buildCodebuddyArgs({ tools: [], timeoutMs: 1 })
    const idx = args.indexOf('--tools')
    expect(args[idx + 1]).toBe('__polar_no_tools__')
    expect(args[idx + 1]).not.toBe('')
  })

  it('默认走独立版 codebuddy 命令；binPath 指向 .mjs 时才过 node', () => {
    expect(resolveCodebuddyInvocation({ tools: [], timeoutMs: 1 })).toEqual({
      bin: 'codebuddy',
      args: expect.any(Array),
      bundled: false
    })
    expect(
      resolveCodebuddyInvocation({ binPath: 'D:/WorkBuddy/cli/dist/codebuddy-lite-wb.mjs', tools: [], timeoutMs: 1 })
    ).toEqual({ bin: 'node', args: expect.any(Array), bundled: true })
  })

  it('能解析数组形状（实测就是数组，之前只认对象就漏了）', () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: '可用', total_cost_usd: 0 }
    ])
    expect(parseCodebuddyOutput(stdout).text).toBe('可用')
  })

  it('也能解析单个对象和纯文本', () => {
    expect(parseCodebuddyOutput(JSON.stringify({ result: '能用' })).text).toBe('能用')
    expect(parseCodebuddyOutput('就是一段话').text).toBe('就是一段话')
  })

  it('空结果不冒充回答', () => {
    const stdout = JSON.stringify([{ type: 'result', result: '' }])
    expect(parseCodebuddyOutput(stdout).text).toBe('')
  })
})

describe('后端注册表', () => {
  it('四个后端都有说明，且能实例化', () => {
    for (const kind of ALL_BACKENDS) {
      expect(BACKEND_INFO[kind].label).toBeTruthy()
      expect(BACKEND_INFO[kind].note).toBeTruthy()
      const b = createBackend({ backend: kind, provider: 'p', model: 'm', tools: [] })
      expect(b.kind).toBe(kind)
    }
  })

  it('codex 的写权限由工具白名单推出来', () => {
    // 只给 read → read-only；给 write → workspace-write
    const ro = createBackend({ backend: 'codex', tools: ['read'] })
    const rw = createBackend({ backend: 'codex', tools: ['read', 'write'] })
    expect(ro.kind).toBe('codex')
    expect(rw.kind).toBe('codex')
    expect(buildCodexArgs({ write: false, timeoutMs: 1 })).toContain('read-only')
    expect(buildCodexArgs({ write: true, timeoutMs: 1 })).toContain('workspace-write')
  })

  it('pi 缺 provider/model 直接拒绝；其他后端不要求', () => {
    expect(() => assertWorkerConfig({ backend: 'pi', tools: [] })).toThrow()
    expect(() => assertWorkerConfig({ backend: 'codex', tools: [] })).not.toThrow()
    expect(() => assertWorkerConfig({ backend: 'claude', tools: [] })).not.toThrow()
    expect(() => assertWorkerConfig({ backend: 'codebuddy', tools: [] })).not.toThrow()
  })

  it('未知后端报错，不静默回落到 pi', () => {
    expect(() => createBackend({ backend: 'gpt' as never, tools: [] })).toThrow(/未知的工作体后端/)
  })
})
