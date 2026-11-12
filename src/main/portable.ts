import fs from 'node:fs'
import path from 'node:path'

/**
 * 便携版：配置跟着 exe 走。
 *
 * 判断依据是 electron-builder 的 portable target 注入的环境变量
 * `PORTABLE_EXECUTABLE_DIR`——它指向**用户在资源管理器里双击的那个 exe 所在目录**
 * （U 盘上的真实位置），而不是 `process.execPath`。后者在便携版里指向自解压出来的
 * 临时目录，程序退出就没了，拿它当数据目录等于每次启动都从空白开始。
 *
 * **只搬配置，不搬别的**：会话、动作记录、记忆、编排项目、缓存仍然留在
 * `%APPDATA%\changeng-polar`。这样插到别人电脑上不会把历史记录一起带过去，
 * 也不会因为 U 盘慢而拖累读写。要改这个范围，只需要改 Store 的 configDir。
 */
export const PORTABLE_DATA_DIR = 'changeng-polar-data'

export interface PortableState {
  /** 是不是便携模式（配置在 exe 同级目录） */
  active: boolean
  /** config.json 实际所在目录 */
  configDir: string
  /** exe 所在目录；非便携模式时没有 */
  exeDir?: string
  /** 想启用但没启用成功的原因，或者是给用户看的说明 */
  reason?: string
}

/**
 * 判断当前是不是便携版，并给出配置目录。
 *
 * 每一步都可能失败（U 盘拔了、只读、写满），失败**不能让程序起不来**：
 * 退回本机 userData，并通过 `reason` 说清楚退回去了，而不是假装一切正常。
 */
export function resolvePortable(
  env: NodeJS.ProcessEnv,
  userDataDir: string
): PortableState {
  const exeDir = (env.PORTABLE_EXECUTABLE_DIR ?? '').trim()
  if (!exeDir) return { active: false, configDir: userDataDir }

  try {
    if (!fs.statSync(exeDir).isDirectory()) throw new Error('not a directory')
  } catch {
    return {
      active: false,
      configDir: userDataDir,
      reason: '便携版目录不存在（U 盘拔掉了？），已退回本机配置'
    }
  }

  const configDir = path.join(exeDir, PORTABLE_DATA_DIR)
  try {
    fs.mkdirSync(configDir, { recursive: true })
    /**
     * 真写一次而不是看权限位：U 盘常见"看着能写、写下去 EPERM"，
     * 而 0 字节的探测文件是这个目录里唯一不会造成损失的东西。
     */
    const probe = path.join(configDir, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch {
    return {
      active: false,
      configDir: userDataDir,
      exeDir,
      reason: '便携版目录写不进去（U 盘只读或已满？），已退回本机配置'
    }
  }

  return { active: true, configDir, exeDir }
}
