import type { ButlerConfig } from '../../shared/types'

/**
 * 密钥在磁盘上的加解密。
 *
 * config.json 里躺着三类真凭据：模型 apiKey、检索 Key、邮箱 IMAP 授权码。
 * 原来它们就是明文 JSON，任何能读到 userData 目录的程序都能直接拿走。
 *
 * 这里只定义"怎么改一个值"，具体算法由主进程注入（Electron 的 safeStorage，
 * 底层是 Windows DPAPI，绑当前用户）。Store 不依赖 Electron——评测脚本也用
 * 同一个 Store，那边没有 safeStorage，注入 PLAIN_CODEC 即可。
 */
export interface SecretCodec {
  /** 明文 → 落盘字符串 */
  encrypt: (plain: string) => string
  /** 落盘字符串 → 明文 */
  decrypt: (stored: string) => string
  /** true = 真在加密；界面据此决定"明文 JSON"那句提示怎么写 */
  active: boolean
}

/** 不加密（脚本、无安全存储的机器） */
export const PLAIN_CODEC: SecretCodec = {
  encrypt: (plain) => plain,
  decrypt: (stored) => stored,
  active: false
}

export const ENC_PREFIX = 'enc:v1:'

export function makeSafeStorageCodec(api: {
  isEncryptionAvailable: () => boolean
  encryptString: (s: string) => Buffer
  decryptString: (b: Buffer) => string
}): SecretCodec {
  return {
    active: testAvailable(api),
    encrypt: (plain) => {
      // 空值不加密：省得把一个空字符串也撑成一段密文，读起来更难排查
      if (!plain) return plain
      try {
        if (!api.isEncryptionAvailable()) return plain
        return `${ENC_PREFIX}${api.encryptString(plain).toString('base64')}`
      } catch {
        // 加密失败不能挡住保存：宁可这次落明文，也不要让用户存不下配置
        return plain
      }
    },
    decrypt: (stored) => {
      if (!stored || !stored.startsWith(ENC_PREFIX)) return stored
      try {
        return api.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
      } catch {
        // 换了机器 / 换了用户，DPAPI 解不开：返回空串，让用户重填，而不是崩在启动
        return ''
      }
    }
  }
}

function testAvailable(api: { isEncryptionAvailable: () => boolean }): boolean {
  try {
    return api.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 配置里所有算密钥的字段；加新密钥时只改这里 */
function mapSecrets(config: ButlerConfig, fn: (value: string) => string): ButlerConfig {
  return {
    ...config,
    apiKey: fn(config.apiKey ?? ''),
    searchKey: fn(config.searchKey ?? ''),
    ...(config.mail ? { mail: { ...config.mail, authCode: fn(config.mail.authCode ?? '') } } : {}),
    ...(config.mailAccounts
      ? {
          mailAccounts: config.mailAccounts.map((acc) => ({
            ...acc,
            authCode: fn(acc.authCode ?? '')
          }))
        }
      : {})
  }
}

/** 落盘前：密钥全部加密 */
export function encodeConfigSecrets(config: ButlerConfig, codec: SecretCodec): ButlerConfig {
  return mapSecrets(config, codec.encrypt)
}

/** 读盘后：密钥全部还原成明文（内存里才用） */
export function decodeConfigSecrets(config: ButlerConfig, codec: SecretCodec): ButlerConfig {
  return mapSecrets(config, codec.decrypt)
}
