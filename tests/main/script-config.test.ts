import { describe, expect, it } from 'vitest'
import { mergeScriptConfig } from '../../scripts/lib/load-config'
import { ENC_PREFIX } from '../../src/main/node/secrets'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * 脚本读配置时的凭据解析。
 *
 * 这里锁的是一个真实事故：`npm run eval` 跑出 0/36，报
 * `401 LiteLLM Virtual Key expected. Received=enc:v1:...`。
 * 原因是脚本把盘上的密文当成 apiKey 直接用，而调用方的守卫
 * `if (!config.apiKey)` 看到密文非空就放行了——失败的样子像"模型挂了"，
 * 实际是传参数传错了，查了很久。
 *
 * 所以这一组的核心断言只有一句：**密文永远不许出现在 config.apiKey 里**。
 */

const ENC = (payload: string): string => `${ENC_PREFIX}${payload}`

function merge(parsed: Partial<ButlerConfig>, env: NodeJS.ProcessEnv = {}, decrypted?: Partial<ButlerConfig>) {
  return mergeScriptConfig({
    parsed,
    decrypted: decrypted ?? null,
    decryptedCount: decrypted ? 4 : 0,
    decryptFailed: 0,
    decryptFailure: null,
    env,
    hasConfigFile: true
  })
}

describe('密文绝不当凭据用', () => {
  it('盘上是密文、又没有环境变量：apiKey 为空且报缺', () => {
    const out = merge({ apiKey: ENC('abc123==') })
    expect(out.config.apiKey).toBe('')
    expect(out.missing).toContain('模型 Key（BUTLER_API_KEY）')
  })

  it('同样的密文，给了环境变量就用环境变量', () => {
    const out = merge({ apiKey: ENC('abc123==') }, { BUTLER_API_KEY: 'sk-real' })
    expect(out.config.apiKey).toBe('sk-real')
    expect(out.fromEnv).toContain('模型 Key ← BUTLER_API_KEY')
    expect(out.missing).toEqual([])
  })

  it('盘上是明文就直接用，不报缺', () => {
    const out = merge({ apiKey: 'sk-plain' })
    expect(out.config.apiKey).toBe('sk-plain')
    expect(out.missing).toEqual([])
  })

  it('解出来的明文优先于盘上密文', () => {
    const out = merge({ apiKey: ENC('abc123==') }, {}, { apiKey: 'sk-decrypted' })
    expect(out.config.apiKey).toBe('sk-decrypted')
    expect(out.secretSource).toContain('已从应用配置解密')
    expect(out.missing).toEqual([])
  })

  it('解密失败要写在来源里，而不是静默当没配', () => {
    const out = mergeScriptConfig({
      parsed: { apiKey: ENC('abc123==') },
      decrypted: null,
      decryptedCount: 0,
      decryptFailed: 1,
      decryptFailure: 'Error while decrypting the ciphertext provided',
      env: {},
      hasConfigFile: true
    })
    expect(out.config.apiKey).toBe('')
    expect(out.secretSource).toContain('解密失败')
    expect(out.secretSource).toContain('ciphertext')
  })

  it('只解开一部分时：用解开的，解不开的按缺项报出来', () => {
    const out = mergeScriptConfig({
      parsed: { apiKey: ENC('abc123=='), searchKey: ENC('c2VhcmNo') },
      // 解不开的凭据原样留密文（decrypt-config.cjs 就是这么返回的）
      decrypted: { apiKey: 'sk-ok', searchKey: ENC('c2VhcmNo') },
      decryptedCount: 1,
      decryptFailed: 1,
      decryptFailure: '没找到可用的 safeStorage 密钥',
      env: {},
      hasConfigFile: true
    })
    expect(out.config.apiKey).toBe('sk-ok')
    expect(out.config.searchKey).toBe('')
    expect(out.missing).toContain('检索 Key（BUTLER_SEARCH_KEY）')
    expect(out.secretSource).toContain('解不开')
    expect(out.secretSource).toContain('1 个解不开')
  })
})

describe('各凭据分别解析', () => {
  it('检索 Key 与模型 Key 互不影响', () => {
    const out = merge({ apiKey: 'sk-a', searchKey: ENC('c2VhcmNo') })
    expect(out.config.apiKey).toBe('sk-a')
    expect(out.config.searchKey).toBe('')
    expect(out.missing).toEqual(['检索 Key（BUTLER_SEARCH_KEY）'])
  })

  it('判分 Key 单独解析，没配 judge 时不无中生有', () => {
    const without = merge({ apiKey: 'sk-a' })
    expect(without.config.judge).toBeFalsy()

    const withJudge = merge({
      apiKey: 'sk-a',
      judge: { baseUrl: 'https://judge.example/v1', model: 'judge-m', apiKey: ENC('andn'), stream: false, temperature: 0 }
    })
    expect(withJudge.config.judge?.apiKey).toBe('')
    expect(withJudge.missing).toContain('判分 Key（BUTLER_JUDGE_API_KEY）')
  })

  it('判分 Key 的环境变量覆盖生效', () => {
    const out = merge(
      { judge: { baseUrl: 'https://judge.example/v1', model: 'judge-m', apiKey: ENC('andn'), stream: false, temperature: 0 } },
      { BUTLER_JUDGE_API_KEY: 'sk-judge' }
    )
    expect(out.config.judge?.apiKey).toBe('sk-judge')
    expect(out.missing).toEqual([])
  })

  it('mail 与 mailAccounts 是同一份授权码时只报一次', () => {
    const code = ENC('aW1hcA==')
    const out = merge({
      mail: { address: 'a@qq.com', authCode: code, host: 'imap.qq.com', port: 993 },
      mailAccounts: [{ id: 'm1', address: 'a@qq.com', authCode: code, host: 'imap.qq.com', port: 993 }]
    })
    expect(out.missing.filter((m) => m.startsWith('邮箱授权码'))).toHaveLength(1)
    expect(out.config.mail?.authCode).toBe('')
    expect(out.config.mailAccounts?.[0].authCode).toBe('')
  })

  it('邮箱授权码的环境变量覆盖到 mail 与每个账号', () => {
    const code = ENC('aW1hcA==')
    const out = merge(
      {
        mail: { address: 'a@qq.com', authCode: code, host: 'imap.qq.com', port: 993 },
        mailAccounts: [
          { id: 'm1', address: 'a@qq.com', authCode: code, host: 'imap.qq.com', port: 993 },
          { id: 'm2', address: 'b@qq.com', authCode: code, host: 'imap.qq.com', port: 993 }
        ]
      },
      { BUTLER_MAIL_AUTHCODE: 'real-code' }
    )
    expect(out.config.mail?.authCode).toBe('real-code')
    expect(out.config.mailAccounts?.map((a) => a.authCode)).toEqual(['real-code', 'real-code'])
    expect(out.fromEnv.filter((n) => n.startsWith('邮箱授权码'))).toHaveLength(1)
  })
})

describe('兜底行为', () => {
  it('完全没有配置文件时落在默认值上，并说清凭据只来自默认值', () => {
    const out = mergeScriptConfig({
      parsed: {},
      decrypted: null,
      decryptedCount: 0,
      decryptFailed: 0,
      decryptFailure: null,
      env: {},
      hasConfigFile: false
    })
    expect(out.secretSource).toBe('仅默认值')
    expect(out.config.apiKey).toBe('')
  })

  it('环境变量能整段换掉模型地址与模型名', () => {
    const out = merge(
      { baseUrl: 'http://old/v1', model: 'old-model', apiKey: 'sk-a' },
      { BUTLER_BASE_URL: 'http://127.0.0.1:11434/v1', BUTLER_MODEL: 'qwen' }
    )
    expect(out.config.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(out.config.model).toBe('qwen')
    expect(out.fromEnv).toEqual(['模型地址 ← BUTLER_BASE_URL', '模型名 ← BUTLER_MODEL'])
  })

  it('空白的环境变量不算覆盖', () => {
    const out = merge({ apiKey: 'sk-plain' }, { BUTLER_API_KEY: '   ' })
    expect(out.config.apiKey).toBe('sk-plain')
    expect(out.fromEnv).toEqual([])
  })
})
