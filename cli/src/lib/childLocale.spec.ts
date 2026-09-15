import { describe, expect, it } from 'vitest'
import { ensureUtf8Locale, psEnv } from './childLocale.js'

const supported = process.platform === 'linux' || process.platform === 'darwin'

describe('ensureUtf8Locale', () => {
  /**
   * The measured failure it prevents (Ubuntu 24.04, tmux 3.4, procps-ng 4.0.4, LANG unset):
   *   tmux list-panes -a -F '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'  →  "%0_510_/home/app/proj"
   * The TAB separator comes back as `_` (0x5F, checked with od -c), parsePanes splits on \t and yields
   * ZERO panes, so discovery has nowhere to attach the engine process it did find and no agent is ever
   * created. Under LC_ALL=C.UTF-8 the same call returns real tabs.
   */
  it.skipIf(!supported)('supplies a UTF-8 locale when the environment has none', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBe('C.UTF-8')
  })

  it.skipIf(!supported)('overrides a non-UTF-8 locale', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'POSIX' }
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBe('C.UTF-8')
  })

  it.skipIf(!supported)('leaves a UTF-8 locale the user configured alone', () => {
    for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG'] as const) {
      const env: NodeJS.ProcessEnv = { [key]: 'en_US.UTF-8' }
      ensureUtf8Locale(env)
      expect(env.LC_ALL).toBe(key === 'LC_ALL' ? 'en_US.UTF-8' : undefined)
    }
    const lowercase: NodeJS.ProcessEnv = { LANG: 'C.utf8' }
    ensureUtf8Locale(lowercase)
    expect(lowercase.LC_ALL).toBeUndefined()
  })

  it.skipIf(supported)('does nothing on unsupported platforms', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBeUndefined()
  })
})

describe('psEnv', () => {
  /**
   * The bug this exists for, measured on macOS 15.5 with LANG=en_US.UTF-8 and LC_TIME=en_AU.UTF-8 (macOS
   * keeps language and region separate, so the split is a two-click setting): `ps -axo lstart=` prints
   * `Tue 15 Sep 23:54:57 2026`, parseProcessRow accepts 0 of 594 rows, processRows returns `[]` rather
   * than null, and every pane probe reports no engine — for ten minutes, then START_TIMEOUT.
   */
  it('pins LC_TIME to C so lstart keeps the shape parseProcessRow documents', () => {
    expect(psEnv({ LANG: 'en_US.UTF-8', LC_TIME: 'en_AU.UTF-8' }).LC_TIME).toBe('C')
  })

  it('clears the LC_ALL that would otherwise outrank LC_TIME', () => {
    expect(psEnv({ LC_ALL: 'de_DE.UTF-8' }).LC_ALL).toBe('')
  })

  /** LC_CTYPE is the half ensureUtf8Locale protects: lose it and Linux procps returns `?` for `⌘`. */
  it('keeps a configured UTF-8 locale as LC_CTYPE, and supplies one when there is none', () => {
    expect(psEnv({ LC_ALL: 'de_DE.UTF-8' }).LC_CTYPE).toBe('de_DE.UTF-8')
    expect(psEnv({ LANG: 'fr_FR.utf8' }).LC_CTYPE).toBe('fr_FR.utf8')
    expect(psEnv({}).LC_CTYPE).toBe('C.UTF-8')
    expect(psEnv({ LANG: 'POSIX' }).LC_CTYPE).toBe('C.UTF-8')
  })

  it('returns a copy — the daemon\'s own locale is not rewritten', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', LC_TIME: 'en_AU.UTF-8' }
    psEnv(env)
    expect(env.LC_TIME).toBe('en_AU.UTF-8')
  })
})
