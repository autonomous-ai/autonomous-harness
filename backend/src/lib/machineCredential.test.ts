import { describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  env: { HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
}))

import { decryptMachineCredential, encryptMachineCredential } from './machineCredential.js'

describe('machine credential envelope', () => {
  it('round-trips without storing plaintext and rejects tampering', () => {
    const secret = 'campaign-secret'
    const encrypted = encryptMachineCredential(secret)
    expect(encrypted).not.toContain(secret)
    expect(decryptMachineCredential(encrypted)).toBe(secret)
    expect(() => decryptMachineCredential(`${encrypted.slice(0, -1)}x`)).toThrow()
  })
})
