import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(mode: number): string {
  const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
  dirs.push(root)
  const dir = join(root, 'data')
  mkdirSync(dir)
  chmodSync(dir, mode)
  return dir
}

const modeOf = (dir: string) => statSync(dir).mode & 0o777

describe('secureStateDirectory', () => {
  it('creates a private directory regardless of the ambient umask', () => {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    const dir = join(root, 'a', 'b')
    const previous = process.umask(0o002)   // Ubuntu's default
    try { secureStateDirectory(dir) } finally { process.umask(previous) }
    expect(modeOf(dir)).toBe(0o700)
  })

  /**
   * A group-writable directory is refused, NOT tightened — if another account could write here it could
   * already have planted the registry or the token, and chmod-then-trust would keep the planted copy.
   * registry.spec.ts, hookAuth.spec.ts and terminalConfigSnapshot.spec.ts pin the same rule.
   *
   * What Ubuntu changed is where the mode comes from, not what to do about it: umask 0002 meant the
   * daemon's OWN `mkdirSync(..., { recursive: true })` produced 0775 and then refused to start on it —
   * measured on 24.04, on every entry point. The fix is above, at creation time. A pre-existing 0775
   * directory from an older build still lands here, so the message must be actionable.
   */
  it('refuses a group-writable directory and says how to fix it', () => {
    const dir = scratch(0o775)
    expect(() => secureStateDirectory(dir, false)).toThrow(/group\/world writable/)
    expect(() => secureStateDirectory(dir, false)).toThrow(new RegExp(`chmod 700 ${dir}`))
    expect(modeOf(dir)).toBe(0o775)   // untouched: the caller decides, we do not paper over it
  })

  it('refuses a world-writable directory too', () => {
    expect(() => secureStateDirectory(scratch(0o707), false)).toThrow(/group\/world writable/)
  })

  it('leaves an already-private directory alone', () => {
    const dir = scratch(0o700)
    secureStateDirectory(dir, false)
    expect(modeOf(dir)).toBe(0o700)
  })

  it('tightens a group/other-readable directory too', () => {
    const dir = scratch(0o755)
    secureStateDirectory(dir, false)
    expect(modeOf(dir)).toBe(0o700)
  })
})

describe('readPrivateStateFile', () => {
  function file(mode: number): string {
    const root = mkdtempSync(join(tmpdir(), 'secure-state-'))
    dirs.push(root)
    const path = join(root, 'token')
    writeFileSync(path, 'secret')
    chmodSync(path, mode)
    return path
  }

  // Same rule as the directory: refuse, never chmod-then-trust. Every writer under ADAPTER_DATA_DIR
  // passes mode 0o600, so Ubuntu's umask 0002 cannot produce a 0664 state file in the first place.
  it('refuses a group-writable state file rather than tightening it', () => {
    const path = file(0o664)
    expect(() => readPrivateStateFile(path)).toThrow(/group\/world writable/)
    expect(statSync(path).mode & 0o777).toBe(0o664)
  })

  it('reads a private state file', () => {
    expect(readPrivateStateFile(file(0o600))).toBe('secret')
  })
})
