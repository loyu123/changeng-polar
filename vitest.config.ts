import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 评测与冒烟脚本会真的连网、读注册表，不放进单测
    exclude: ['node_modules/**', 'out/**']
  }
})
