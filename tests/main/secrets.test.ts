import { describe, expect, it } from 'vitest'
import { decodeConfigSecrets, encodeConfigSecrets, makeSafeStorageCodec, PLAIN_CODEC } from '../../src/main/node/secrets'
import { DEFAULT_CONFIG } from '../../src/main/node/store'
import type { ButlerConfig } from '../../src/shared/types'

/**
 * 密钥加解密。
 * 真的 DPAPI 只能在 Electron 里跑，这里用假实现验"存密文、读明文、解不开时不崩"这三件事。
 */
const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`X${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(1)
}

function sampleConfig(): ButlerConfig {
  return {
    ...DEFAULT_CONFIG,
    apiKey: 'sk-secret',
    searchKey: 'serper-key',
    mail: { address: 'a@qq.com', authCode: 'imap-code', host: 'imap.qq.com', port: 993 },
    mailAccounts: [
      { id: 'x', label: '学校', address: 'b@edu.cn', authCode: 'imap-code-2', host: '', port: 993 }
    ]
  }
}

describe('密钥加解密', () => {
  it('落盘时三类密钥全部变成密文，且文件里搜不到明文', () => {
    const encoded = encodeConfigSecrets(sampleConfig(), makeSafeStorageCodec(fakeStorage))
    expect(encoded.apiKey).toMatch(/^enc:v1:/)
    expect(encoded.searchKey).toMatch(/^enc:v1:/)
    expect(encoded.mail?.authCode).toMatch(/^enc:v1:/)
    expect(encoded.mailAccounts?.[0].authCode).toMatch(/^enc:v1:/)
    expect(JSON.stringify(encoded)).not.toContain('sk-secret')
    expect(JSON.stringify(encoded)).not.toContain('imap-code')
  })

  it('非密钥字段保持原样', () => {
    const encoded = encodeConfigSecrets(sampleConfig(), makeSafeStorageCodec(fakeStorage))
    expect(encoded.baseUrl).toBe(DEFAULT_CONFIG.baseUrl)
    expect(encoded.mail?.address).toBe('a@qq.com')
    expect(encoded.mailAccounts?.[0].label).toBe('学校')
  })

  it('往返一次拿回原值', () => {
    const codec = makeSafeStorageCodec(fakeStorage)
    const back = decodeConfigSecrets(encodeConfigSecrets(sampleConfig(), codec), codec)
    expect(back.apiKey).toBe('sk-secret')
    expect(back.searchKey).toBe('serper-key')
    expect(back.mail?.authCode).toBe('imap-code')
    expect(back.mailAccounts?.[0].authCode).toBe('imap-code-2')
  })

  it('空值不加密（省得把空串撑成一段密文）', () => {
    const encoded = encodeConfigSecrets({ ...DEFAULT_CONFIG, apiKey: '' }, makeSafeStorageCodec(fakeStorage))
    expect(encoded.apiKey).toBe('')
  })

  it('换机器解不开时返回空串，不抛错（让用户重填，而不是启动就崩）', () => {
    const broken = makeSafeStorageCodec({
      ...fakeStorage,
      decryptString: () => {
        throw new Error('DPAPI 解不开')
      }
    })
    const encoded = encodeConfigSecrets(sampleConfig(), makeSafeStorageCodec(fakeStorage))
    const back = decodeConfigSecrets(encoded, broken)
    expect(back.apiKey).toBe('')
    expect(back.mail?.authCode).toBe('')
    // 非密钥字段不受影响
    expect(back.mail?.address).toBe('a@qq.com')
  })

  it('系统不支持加密时降级为明文，不能挡住保存', () => {
    const unavailable = makeSafeStorageCodec({ ...fakeStorage, isEncryptionAvailable: () => false })
    const encoded = encodeConfigSecrets(sampleConfig(), unavailable)
    expect(encoded.apiKey).toBe('sk-secret')
    expect(unavailable.active).toBe(false)
  })

  it('加密时抛错也降级为明文', () => {
    const throwing = makeSafeStorageCodec({
      ...fakeStorage,
      encryptString: () => {
        throw new Error('加密失败')
      }
    })
    expect(encodeConfigSecrets(sampleConfig(), throwing).apiKey).toBe('sk-secret')
  })

  it('明文 codec 下一切原样（评测脚本用这条路）', () => {
    const cfg = sampleConfig()
    ExpectNoChange(decodeConfigSecrets(encodeConfigSecrets(cfg, PLAIN_CODEC), PLAIN_CODEC), cfg)
    expect(PLAIN_CODEC.active).toBe(false)
  })
})

function ExpectNoChange(actual: ButlerConfig, expected: ButlerConfig): void {
  expect(actual.apiKey).toBe(expected.apiKey)
  expect(actual.searchKey).toBe(expected.searchKey)
  expect(actual.mail?.authCode).toBe(expected.mail?.authCode)
}
