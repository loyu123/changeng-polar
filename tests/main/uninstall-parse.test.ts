import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { parseUninstallCommand } from '../../src/main/node/uninstall'

/**
 * 注册表 UninstallString 的解析。
 * 这里的用例全部来自真机：解析错的代价是"批准 A、执行 B"或干脆卸不掉。
 */
describe('parseUninstallCommand', () => {
  it('无引号、路径带空格：从最长组合往短试，找到真实存在的 .exe', () => {
    // 真机症状：按第一个空格截断会得到 "C:\Program"，卸载程序永远找不到
    const notepad = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
    const parsed = parseUninstallCommand(`${notepad} /S`)
    expect(typeof parsed).not.toBe('string')
    if (typeof parsed !== 'string') {
      expect(parsed.exe).toBe(notepad)
      expect(parsed.args).toEqual(['/S'])
    }
  })

  it('带引号的标准写法', () => {
    const notepad = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
    const parsed = parseUninstallCommand(`"${notepad}" /uninstall /quiet`)
    expect(typeof parsed).not.toBe('string')
    if (typeof parsed !== 'string') {
      expect(parsed.exe).toBe(notepad)
      expect(parsed.args).toEqual(['/uninstall', '/quiet'])
    }
  })

  it('引号没有闭合：拒绝', () => {
    expect(parseUninstallCommand('"C:\\Program Files\\X\\unins.exe /S')).toMatch(/引号/)
  })

  it('脚本宿主一律拒绝（那等于执行任意字符串）', () => {
    // 这些宿主会把后面的参数当脚本跑，等于绕开"只启动 exe"的约定
    for (const host of ['cmd.exe', 'powershell.exe', 'wscript.exe', 'mshta.exe', 'rundll32.exe']) {
      const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', host)
      const result = parseUninstallCommand(`"${exe}" /x`)
      expect(typeof result, host).toBe('string')
      expect(result as string).toMatch(/脚本宿主|不在原位置/)
    }
  })

  it('不是 .exe 的一律拒绝', () => {
    expect(parseUninstallCommand('C:\\Windows\\System32\\cmd.bat /x')).toMatch(/不是 \.exe/)
  })

  it('空命令拒绝', () => {
    expect(parseUninstallCommand('   ')).toBe('命令为空')
  })

  it('磁盘上不存在的 exe：给出明确原因，而不是静默通过', () => {
    const result = parseUninstallCommand('"C:\\Nope\\NotThere\\unins.exe" /S')
    expect(typeof result).toBe('string')
    expect(result as string).toMatch(/不在原位置/)
  })
})
