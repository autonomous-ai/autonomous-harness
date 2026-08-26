import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const REAL_PATH = process.env.PATH
const REAL_HOME = process.env.HOME

afterEach(() => {
  process.env.PATH = REAL_PATH
  if (REAL_HOME) process.env.HOME = REAL_HOME
  vi.resetModules()
})

function fakeHomeWithOpencode(): string {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
  const bin = join(home, '.opencode', 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'opencode')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return home
}

describe('opencodeBin', () => {
  it('finds the install when PATH does not have it', async () => {
    // The daemon is started by the desktop app, so it gets the GUI's PATH — no shell profile, and
    // therefore not the ~/.opencode/bin entry OpenCode's installer appends there. Every recap spun
    // on `spawn opencode ENOENT` while the same command worked fine from a terminal.
    const home = fakeHomeWithOpencode()
    process.env.HOME = home
    process.env.PATH = '/usr/bin:/bin'

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe(join(home, '.opencode', 'bin', 'opencode'))
  })

  it('leaves a PATH install alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-empty-'))
    const dir = mkdtempSync(join(tmpdir(), 'oc-path-'))
    const file = join(dir, 'opencode')
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
    process.env.HOME = home
    process.env.PATH = `${dir}:/usr/bin`

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe('opencode')
  })

  it('still says `opencode` when nothing is installed, so the error is the usual one', async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'oc-none-'))
    process.env.PATH = '/nonexistent'

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe('opencode')
  })
})
