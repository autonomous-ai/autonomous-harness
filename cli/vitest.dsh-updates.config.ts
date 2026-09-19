import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/dsh/**/*.spec.ts', 'src/backendSocket.dsh.spec.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      enabled: true,
      include: ['src/dsh/update.ts', 'src/dsh/updates.ts', 'src/dsh/lock.ts', 'src/dsh/service.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/dsh-updates',
    },
  },
})
