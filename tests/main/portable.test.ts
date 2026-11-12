import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PORTABLE_DATA_DIR, resolvePortable } from '../../src/main/portable'

/**
 * 便携版判断。
 *
 * 这里要钉住的是「判断失败不能让配置悄悄写错地方」：
 * U 盘拔了、只读、路径被一个同名文件占了，都必须退回本机目录并说明原因，
 * 而不是抛异常、也不是假装便携。
 */
let base = ''
let userData = ''

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(tmpdir(), 'butler-portable-test-'))
  userData = path.join(base, 'userData')
  await fsp.mkdir(userData, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('便携版判断', () => {
  it('没有 PORTABLE_EXECUTABLE_DIR 时不是便携版，配置仍在 userData', () => {
    const state = resolvePortable({}, userData)
    expect(state.active).toBe(false)
    expect(state.configDir).toBe(userData)
    expect(state.reason).toBeUndefined()
  })

  it('便携版 exe 目录存在时，配置目录建在它下面', () => {
    const usb = path.join(base, 'E')
    fs.mkdirSync(usb, { recursive: true })
    const state = resolvePortable({ PORTABLE_EXECUTABLE_DIR: usb }, userData)
    expect(state.active).toBe(true)
    expect(state.configDir).toBe(path.join(usb, PORTABLE_DATA_DIR))
    expect(state.exeDir).toBe(usb)
    // 目录要真建出来，否则第一次保存配置才会失败
    expect(fs.existsSync(state.configDir)).toBe(true)
  })

  it('U 盘拔了（目录不存在）：退回本机，并说明原因', () => {
    const state = resolvePortable({ PORTABLE_EXECUTABLE_DIR: path.join(base, 'gone') }, userData)
    expect(state.active).toBe(false)
    expect(state.configDir).toBe(userData)
    expect(state.reason).toContain('U 盘')
  })

  it('配置目录建不出来（同名文件占位 / 只读）：退回本机，不抛异常', () => {
    const usb = path.join(base, 'E2')
    fs.mkdirSync(usb, { recursive: true })
    // 用一个同名文件把目录位置占住，mkdir 必然失败——模拟只读盘上的效果
    fs.writeFileSync(path.join(usb, PORTABLE_DATA_DIR), 'x')
    const state = resolvePortable({ PORTABLE_EXECUTABLE_DIR: usb }, userData)
    expect(state.active).toBe(false)
    expect(state.configDir).toBe(userData)
    expect(state.reason).toContain('写不进去')
  })

  it('探测文件不会留在配置目录里', () => {
    const usb = path.join(base, 'E3')
    fs.mkdirSync(usb, { recursive: true })
    const state = resolvePortable({ PORTABLE_EXECUTABLE_DIR: usb }, userData)
    expect(fs.readdirSync(state.configDir)).toEqual([])
  })

  it('路径里的多余空白不算数', () => {
    const state = resolvePortable({ PORTABLE_EXECUTABLE_DIR: '   ' }, userData)
    expect(state.active).toBe(false)
    expect(state.configDir).toBe(userData)
  })
})
