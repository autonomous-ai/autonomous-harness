import { describe, expect, it } from 'vitest'
import { parsePsEnviron } from './processEnv.js'

describe('parsePsEnviron', () => {
  it('reads the variables out of a ps line that begins with argv', () => {
    const env = parsePsEnviron('/usr/local/bin/opencode -m grid/x FOO=1 OPENCODE_CONFIG=/tmp/a.json')
    expect(env.FOO).toBe('1')
    expect(env.OPENCODE_CONFIG).toBe('/tmp/a.json')
  })

  it('shows what a PARTIAL ps answer looks like, which is why the cache merges', () => {
    // macOS prints argv and the environment into one field, so a long argv can push the trailing
    // variables out of it. `ps` still exits 0, so the loss is invisible: the caller gets a map that
    // simply lacks a key, indistinguishable from a process that never had it. The merge in
    // readProcessEnv is what makes that harmless, and this is the shape it is defending against.
    const full = parsePsEnviron('opencode FOO=1 OPENCODE_CONFIG=/tmp/a.json')
    const cut = parsePsEnviron('opencode FOO=1')
    expect(full.OPENCODE_CONFIG).toBe('/tmp/a.json')
    expect(cut.OPENCODE_CONFIG).toBeUndefined()
    expect({ ...full, ...cut }.OPENCODE_CONFIG).toBe('/tmp/a.json')
  })
})
