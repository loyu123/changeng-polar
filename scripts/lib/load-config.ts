import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { ButlerConfig, MailAccount } from '../../src/shared/types'
import { DEFAULT_CONFIG } from '../../src/main/node/store'
import { ENC_PREFIX } from '../../src/main/node/secrets'

/**
 * 命令行脚本读配置。
 *
 * 为什么不能直接 `JSON.parse(config.json)` 就完事：
 * 内置凭据（模型 Key、检索 Key、邮箱授权码）落盘前都经过 safeStorage 加密，
 * 盘上是 `enc:v1:...`。纯 Node 进程里根本没有 safeStorage 这个 API，
 * 直接读只能拿到密文。
 *
 * 所以凭据走三条路，从上到下：
 *   1. 环境变量（显式指定，CI / 换机器 / 想临时覆盖模型时用）
 *   2. 子进程解密（`decrypt-config.cjs`，跑在 Electron 里，见那个文件的注释）
 *   3. 盘上明文（PLAIN_CODEC 的机器，或用户从没经过 safeStorage）
 *
 * 这里最要紧的一条是**别把密文当密钥用**：
 * 原来的写法直接把 JSON 塞给调用方，`if (!config.apiKey)` 看到密文非空就放行，
 * 于是密文被当成 Bearer token 发出去，服务端回 401。评测跑出来 0/36，
 * 看起来像"模型挂了"，实际是传参传错了——这种失败最难查。
 */

export interface ScriptConfigResult {
  config: ButlerConfig
  /** 从环境变量补上来的键（人要知道自己覆盖了什么） */
  fromEnv: string[]
  /** 盘上是密文、又没有别的办法拿到明文的键（调用方须据此判断能不能跑） */
  missing: string[]
  /** 凭据怎么来的，人看得懂的一句话 */
  secretSource: string
}

const MARKER = '__BUTLER_CONFIG__'
const HELPER = path.join(__dirname, 'decrypt-config.cjs')

interface DecryptOutcome {
  config: Partial<ButlerConfig> | null
  /** 失败原因（只讲原因，不讲数量）；空串 = 全解开了 */
  reason: string
  decrypted: number
  /** 解不开的个数 */
  failed: number
}

export interface MergeInput {
  /** 盘上的原始配置（凭据可能还是密文） */
  parsed: Partial<ButlerConfig>
  /** 解密成功的那份；null = 没解密或解密失败 */
  decrypted: Partial<ButlerConfig> | null
  /** 解出来几个凭据 */
  decryptedCount: number
  /** 几个凭据解不开 */
  decryptFailed: number
  /** 解密报出的问题；null = 一路顺利。部分解不开也算（这时仍会用解出来的部分） */
  decryptFailure: string | null
  env: NodeJS.ProcessEnv
  /** 盘上到底有没有 config.json */
  hasConfigFile: boolean
}

/**
 * 纯逻辑：盘上原始配置 + 解密结果 + 环境变量 → 最终配置。
 *
 * 单独拆出来是为了能测——这条路上真正的坑（密文被当成 Key 用）不需要
 * 起 Electron 也能复现，测试只要给一段 `enc:v1:xxx` 就行。
 */
export function mergeScriptConfig(input: MergeInput): ScriptConfigResult {
  const { env, hasConfigFile } = input
  const result: ScriptConfigResult = {
    config: { ...DEFAULT_CONFIG },
    fromEnv: [],
    missing: [],
    secretSource: '仅默认值'
  }

  let parsed = input.parsed
  if (input.decrypted) {
    // 解出来的跟 parsed 是同一份文件，只是凭据换成了明文
    parsed = input.decrypted
    // 部分解不开时，解出来的那部分照样用，但来源那句必须把问题带上——
    // 只写"已解密（N 个凭据）"，N 为 0 的时候读起来像是成功了
    result.secretSource = input.decryptFailure
      ? `解开了 ${input.decryptedCount} 个，${input.decryptFailed} 个解不开（${input.decryptFailure}）`
      : `已从应用配置解密（${input.decryptedCount} 个凭据）`
  } else if (input.decryptFailure) {
    result.secretSource = `解密失败：${input.decryptFailure}`
  } else if (hasConfigFile) {
    result.secretSource = '配置文件里没有加密凭据'
  }

  const merged: ButlerConfig = { ...DEFAULT_CONFIG, ...parsed }

  const envText = (name: string): string => (env[name] ?? '').trim()
  /**
   * 某个密钥的覆盖顺序：环境变量 > 已解密的明文 > 盘上明文。
   * 密文在任何情况下都不返回——返回它等于把一个必然 401 的字符串发出去。
   */
  const resolveSecret = (label: string, stored: string, envName: string): string => {
    const envValue = envText(envName)
    if (envValue) {
      result.fromEnv.push(`${label} ← ${envName}`)
      return envValue
    }
    const value = (stored ?? '').trim()
    if (value && !value.startsWith(ENC_PREFIX)) return value
    // 同一个密钥可能同时出现在 mail 与 mailAccounts 里：只报一次
    if (value.startsWith(ENC_PREFIX) && !result.missing.includes(`${label}（${envName}）`)) {
      result.missing.push(`${label}（${envName}）`)
    }
    return ''
  }

  merged.baseUrl = envText('BUTLER_BASE_URL') || merged.baseUrl
  if (envText('BUTLER_BASE_URL')) result.fromEnv.push('模型地址 ← BUTLER_BASE_URL')
  merged.model = envText('BUTLER_MODEL') || merged.model
  if (envText('BUTLER_MODEL')) result.fromEnv.push('模型名 ← BUTLER_MODEL')
  merged.apiKey = resolveSecret('模型 Key', merged.apiKey ?? '', 'BUTLER_API_KEY')
  merged.searchKey = resolveSecret('检索 Key', merged.searchKey ?? '', 'BUTLER_SEARCH_KEY')

  if (merged.judge) {
    merged.judge = {
      ...merged.judge,
      baseUrl: envText('BUTLER_JUDGE_BASE_URL') || merged.judge.baseUrl,
      model: envText('BUTLER_JUDGE_MODEL') || merged.judge.model,
      apiKey: resolveSecret('判分 Key', merged.judge.apiKey ?? '', 'BUTLER_JUDGE_API_KEY')
    }
    if (envText('BUTLER_JUDGE_BASE_URL')) result.fromEnv.push('判分地址 ← BUTLER_JUDGE_BASE_URL')
    if (envText('BUTLER_JUDGE_MODEL')) result.fromEnv.push('判分模型 ← BUTLER_JUDGE_MODEL')
  }

  const mailCode = envText('BUTLER_MAIL_AUTHCODE')
  if (merged.mail) {
    merged.mail = {
      ...merged.mail,
      authCode: resolveSecret('邮箱授权码', merged.mail.authCode ?? '', 'BUTLER_MAIL_AUTHCODE')
    }
  }
  if (merged.mailAccounts?.length) {
    merged.mailAccounts = merged.mailAccounts.map((acc: MailAccount): MailAccount => {
      const value = (acc.authCode ?? '').trim()
      if (!value.startsWith(ENC_PREFIX) && !mailCode) return acc
      if (mailCode) {
        if (!result.fromEnv.some((n) => n.startsWith('邮箱授权码'))) {
          result.fromEnv.push('邮箱授权码 ← BUTLER_MAIL_AUTHCODE')
        }
        return { ...acc, authCode: mailCode }
      }
      // mail 与 mailAccounts 可能是同一份凭据：只报一次
      if (!result.missing.some((n) => n.startsWith('邮箱授权码'))) {
        result.missing.push('邮箱授权码（BUTLER_MAIL_AUTHCODE）')
      }
      return { ...acc, authCode: '' }
    })
  }

  result.config = merged
  return result
}

/** 拿到 electron 可执行文件的路径；没有（依赖没装）就返回 null */
function electronBinary(): string | null {
  try {
    const resolved = createRequire(__filename)('electron') as unknown
    return typeof resolved === 'string' ? resolved : null
  } catch {
    return null
  }
}

/** 起一个 Electron 子进程解凭据。同步：调用方（loadScriptConfig）是同步 API */
function decryptViaElectron(): DecryptOutcome {
  const binary = electronBinary()
  if (!binary) return { config: null, reason: '没找到 electron（npm install 没跑？）', decrypted: 0, failed: 0 }

  // 目录名给父进程定：子进程退干净之后由这里删。
  // 交给子进程自己删不掉——Chromium 收尾时会把 Local State 从内存再写一遍。
  const tmp = path.join(os.tmpdir(), `butler-decrypt-${process.pid}-${Date.now().toString(36)}`)
  const env: NodeJS.ProcessEnv = { ...process.env, BUTLER_DECRYPT_TMP: tmp }
  // 父进程若是 ELECTRON_RUN_AS_NODE 起的，子进程会继承成"纯 node"，
  // 那样 require('electron') 给的是路径字符串、app 不存在，解密必失败
  delete env.ELECTRON_RUN_AS_NODE

  try {
    const out = execFileSync(binary, [HELPER], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env
    })
    const line = out.split(/\r?\n/).find((l) => l.startsWith(MARKER))
    if (!line) return { config: null, reason: '解密子进程没有返回结果', decrypted: 0, failed: 0 }
    const parsed = JSON.parse(line.slice(MARKER.length)) as {
      ok: boolean
      reason: string
      config: Partial<ButlerConfig> | null
      decrypted: number
      failed: number
    }
    if (!parsed.ok || !parsed.config) {
      return { config: null, reason: parsed.reason || '解密失败', decrypted: 0, failed: 0 }
    }
    return { config: parsed.config, reason: parsed.reason, decrypted: parsed.decrypted, failed: parsed.failed }
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { config: null, reason: message, decrypted: 0, failed: 0 }
  } finally {
    try {
      // 子进程已经退出，这里删必定成功
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 删不掉下次 sweepStale 收 */
    }
  }
}

/** 应用落配置的位置；报错信息里要写给人看 */
export function configPath(): string {
  return path.join(process.env.APPDATA ?? os.homedir(), 'changeng-polar', 'config.json')
}

/** 读配置，把加密的密钥换成明文 */
export function loadScriptConfig(): ScriptConfigResult {
  const file = configPath()
  let parsed: Partial<ButlerConfig> = {}
  const hasConfigFile = existsSync(file)
  try {
    if (hasConfigFile) {
      parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<ButlerConfig>
    }
  } catch {
    /* 读不到就走默认值；mergeScriptConfig 会把缺什么报出来 */
  }

  // 盘上有密文才值得起子进程——明文机器上多启一个 Electron 是白花 1 秒
  const hasCiphertext = [
    parsed.apiKey,
    parsed.searchKey,
    parsed.judge?.apiKey,
    parsed.mail?.authCode,
    ...(parsed.mailAccounts ?? []).map((a) => a.authCode)
  ].some((value) => typeof value === 'string' && value.startsWith(ENC_PREFIX))

  const outcome: DecryptOutcome | null = hasCiphertext ? decryptViaElectron() : null

  return mergeScriptConfig({
    parsed,
    decrypted: outcome?.config ?? null,
    decryptedCount: outcome?.decrypted ?? 0,
    decryptFailed: outcome?.failed ?? 0,
    // 子进程只在"有凭据没解开"时才带 reason：全解开是空串
    decryptFailure: outcome?.reason ? outcome.reason : null,
    env: process.env,
    hasConfigFile
  })
}

/** 把"缺什么、怎么补"讲清楚，别让人对着 401 猜 */
export function describeMissing(result: ScriptConfigResult): string {
  const lines = [`凭据来源：${result.secretSource}。`]
  if (result.missing.length > 0) {
    lines.push(
      '',
      `缺少：${result.missing.join('、')}`,
      '解密拿不到时用环境变量补，或回到应用「设置」里把这一项重填一次（重填会重新加密，脚本就能解开了）。'
    )
  }
  lines.push(
    '',
    'PowerShell 示例：',
    '  $env:BUTLER_API_KEY="sk-..."',
    '  $env:BUTLER_JUDGE_API_KEY="sk-..."    # 可选，判分模型',
    '  npm run eval'
  )
  return lines.join('\n')
}
