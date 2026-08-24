import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { binaryOnPath } from './binaryOnPath.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function dirWith(name: string | null, mode = 0o755): string {
  const dir = mkdtempSync(join(tmpdir(), 'bin-on-path-'))
  dirs.push(dir)
  if (name) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name), mode)
  }
  return dir
}

describe('binaryOnPath', () => {
  it('finds an executable by name on PATH', () => {
    expect(binaryOnPath('codex', { PATH: dirWith('codex') })).toBe(true)
  })

  // The case behind the report: the machine has claude but not codex, so "New agent → Codex" can only
  // fail. Saying WHICH is the whole point — tmux reports success for a command that does not exist.
  it('reports a name that is on no PATH entry', () => {
    expect(binaryOnPath('codex', { PATH: `${dirWith('claude')}${delimiter}${dirWith(null)}` })).toBe(false)
  })

  it('requires the executable bit, not just the file', () => {
    expect(binaryOnPath('codex', { PATH: dirWith('codex', 0o644) })).toBe(false)
  })

  it('checks an explicit path directly instead of searching PATH', () => {
    const dir = dirWith('codex')
    expect(binaryOnPath(join(dir, 'codex'), { PATH: '' })).toBe(true)
    expect(binaryOnPath(join(dir, 'nope'), { PATH: dir })).toBe(false)
  })

  it('handles an empty or absent PATH and an empty name', () => {
    expect(binaryOnPath('codex', {})).toBe(false)
    expect(binaryOnPath('', { PATH: dirWith('codex') })).toBe(false)
  })
})
