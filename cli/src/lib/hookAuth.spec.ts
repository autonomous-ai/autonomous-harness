import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookCredentialMatches, hookCredentialPath, loadOrCreateHookCredential, readHookCredential } from './hookAuth.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('hook channel credential', () => {
  it('creates and reuses a high-entropy mode-0600 credential', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(root)
    const dir = join(root, 'data')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    const first = loadOrCreateHookCredential(dir)
    expect(first).toHaveLength(43)
    expect(loadOrCreateHookCredential(dir)).toBe(first)
    expect(readHookCredential(dir)).toBe(first)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(hookCredentialPath(dir)).mode & 0o777).toBe(0o600)
    expect(hookCredentialMatches(first, first)).toBe(true)
    expect(hookCredentialMatches(first, `${first.slice(0, -1)}x`)).toBe(false)
  })

  it('rejects a credential file with permissive mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    loadOrCreateHookCredential(dir)
    chmodSync(hookCredentialPath(dir), 0o644)
    expect(readHookCredential(dir)).toBeNull()
  })

  it('refuses to read or create credentials in a group-writable state directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    chmodSync(dir, 0o770)
    expect(readHookCredential(dir)).toBeNull()
    expect(() => loadOrCreateHookCredential(dir)).toThrow('unsafe owner, mode, or type')
  })

  it('rejects a credential FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-auth-'))
    dirs.push(dir)
    execFileSync('mkfifo', [hookCredentialPath(dir)])
    const script = `import('./src/lib/hookAuth.ts').then(({ readHookCredential }) => process.exit(readHookCredential(${JSON.stringify(dir)}) === null ? 0 : 2))`

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 1_500,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(statSync(hookCredentialPath(dir)).isFIFO()).toBe(true)
  })
})
