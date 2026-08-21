import { describe, expect, it } from 'vitest'
import { ensureUtf8Locale } from './childLocale.js'

const linux = process.platform === 'linux'

describe('ensureUtf8Locale', () => {
  /**
   * The measured failure it prevents (Ubuntu 24.04, tmux 3.4, procps-ng 4.0.4, LANG unset):
   *   tmux list-panes -a -F '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'  →  "%0_510_/home/app/proj"
   * The TAB separator comes back as `_` (0x5F, checked with od -c), parsePanes splits on \t and yields
   * ZERO panes, so discovery has nowhere to attach the engine process it did find and no agent is ever
   * created. Under LC_ALL=C.UTF-8 the same call returns real tabs.
   */
  it.skipIf(!linux)('supplies a UTF-8 locale when the environment has none', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBe('C.UTF-8')
  })

  it.skipIf(!linux)('overrides a non-UTF-8 locale', () => {
    const env: NodeJS.ProcessEnv = { LANG: 'POSIX' }
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBe('C.UTF-8')
  })

  it.skipIf(!linux)('leaves a UTF-8 locale the user configured alone', () => {
    for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG'] as const) {
      const env: NodeJS.ProcessEnv = { [key]: 'en_US.UTF-8' }
      ensureUtf8Locale(env)
      expect(env.LC_ALL).toBe(key === 'LC_ALL' ? 'en_US.UTF-8' : undefined)
    }
    const lowercase: NodeJS.ProcessEnv = { LANG: 'C.utf8' }
    ensureUtf8Locale(lowercase)
    expect(lowercase.LC_ALL).toBeUndefined()
  })

  // macOS passes every byte through regardless of locale (verified: default, C.UTF-8 and POSIX all
  // return `⌘` intact from ps), so there is nothing to fix and nothing to risk changing.
  it.skipIf(linux)('does nothing off Linux', () => {
    const env: NodeJS.ProcessEnv = {}
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBeUndefined()
  })
})
