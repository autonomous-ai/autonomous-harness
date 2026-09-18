/**
 * The suite must never read or write the developer's real `~/.harness`.
 *
 * `vitest.setup.ts` moved the DATA dir to a throwaway after a spec wrote a fixture into the live
 * registry. The RUNTIME dir is the same hazard in the other direction: a real `current-grid` or
 * `current-node` pointer there outranks the fakes a spec puts on PATH (`gridExec.ts` resolves the
 * managed runtime BEFORE PATH, by design), so the suite would measure this machine's managed
 * binaries instead of the code under test.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { env } from './env.js'
import { AUTH_DIR } from '../lib/authSession.js'

const productRoot = join(homedir(), '.harness')

describe('test environment isolation', () => {
  it('keeps the data dir off the developer\'s ~/.harness', () => {
    expect(env.ADAPTER_DATA_DIR.startsWith(productRoot)).toBe(false)
  })

  it('keeps the runtime dir off the developer\'s ~/.harness, so no real managed grid or node outranks a fake on PATH', () => {
    expect(env.ADAPTER_RUNTIME_DIR.startsWith(productRoot)).toBe(false)
  })
  it('keeps account reads and refreshes in the test-owned auth directory', () => {
    expect(AUTH_DIR).toBe(join(env.ADAPTER_DATA_DIR, 'auth'))
    expect(AUTH_DIR.startsWith(productRoot)).toBe(false)
  })
})
