import { appendFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

/**
 * 主进程的错误落盘。
 *
 * 打包之后没有终端可看：审计写失败、未处理的 Promise 拒绝如果只 console.error，
 * 等于什么都没留下。而这类错误恰恰是最需要事后查的（磁盘满、文件被占用）。
 *
 * 三条边界：
 * - 本函数自身绝不抛。写日志失败就放弃，不能让它变成新的错误源。
 * - 有上限。真出了循环报错时，不该由日志把磁盘写满。
 * - 只记错误，不记业务数据（记录页那套审计仍然是 records.jsonl 的职责）。
 */

const MAX_LOG_BYTES = 1024 * 1024
/** 单次运行最多写这么多条，防止某个每秒抛一次的循环刷爆磁盘 */
const MAX_WRITES_PER_SESSION = 500

let logPath: string | null = null
let writes = 0
/** 超限后只在控制台提一次，避免每次错误都尝试 stat */
let capped = false

function resolvePath(): string | null {
  if (logPath) return logPath
  try {
    logPath = path.join(app.getPath('userData'), 'errors.log')
    return logPath
  } catch {
    // 极早期（userData 还不可用）就只留控制台
    return null
  }
}

/**
 * 造一个「可预期的失败」。
 *
 * 这类错误的消息本身就是给人看的诊断（"端口 7474 已被占用"），堆栈没有用。
 * 用它包一层，logError 就只记那句话。
 */
export function expectedError(message: string): Error {
  const err = new Error(message)
  err.name = 'ExpectedError'
  return err
}

/** 记一条错误：控制台 + userData/errors.log（尽力而为） */
export function logError(scope: string, err: unknown): void {
  /**
   * 可预期的失败只记一句话。
   *
   * 「端口被占用」「文件不存在」这类错误的堆栈全是 node:net / node:events 的
   * 内部帧——用户读它得不到任何信息，开发者也一眼能定位，唯一作用是让真正
   * 意外的崩溃淹没在噪音里。区分靠 expectedError() 造的 name 标记，
   * 不去猜错误消息里有没有某个词。
   */
  const expected = err instanceof Error && err.name === 'ExpectedError'
  const detail = expected
    ? (err as Error).message
    : err instanceof Error
      ? (err.stack ?? err.message)
      : String(err)
  console.error(`[${scope}]`, detail)

  if (writes >= MAX_WRITES_PER_SESSION) {
    if (!capped) {
      capped = true
      console.error(`[log] 本次运行已写满 ${MAX_WRITES_PER_SESSION} 条错误日志，后续只打到控制台`)
    }
    return
  }
  writes += 1

  const file = resolvePath()
  if (!file) return
  const line = `${new Date().toISOString()} [${scope}] ${detail}\n`
  void (async () => {
    try {
      // 超过上限就整个重来：错误日志不需要历史，只要最近这一段
      const size = await stat(file).then((s) => s.size).catch(() => 0)
      if (size > MAX_LOG_BYTES) await writeFile(file, '', 'utf8')
      await appendFile(file, line, 'utf8')
    } catch {
      /* 写日志失败不再上报，否则就是自己调自己 */
    }
  })()
}
