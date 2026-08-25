import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHerdrSessions, parseTerminalBackends, parseTerminalConfig } from './terminalConfig.js'

afterEach(() => vi.restoreAllMocks())

describe('terminal backend configuration', () => {
  it('watches every supported backend when nothing is configured — tmux, and only tmux', () => {
    expect(parseTerminalConfig({})).toEqual({
      backends: ['tmux'],
      herdrSessions: [],
      backendsExplicit: false,
      herdrSessionsExplicit: false,
    })
  })

  it('treats an explicit value as a pin', () => {
    expect(parseTerminalConfig({ TERMINAL_BACKENDS: 'tmux' })).toMatchObject({
      backends: ['tmux'],
      herdrSessions: [],
      backendsExplicit: true,
    })
  })

  /**
   * Herdr is retired, and a machine that still names it must keep running. The daemon SELF-UPDATES:
   * refusing to start on a retired name would take down an unattended computer at the moment it picked
   * up a new build, for a setting the user cannot be there to fix. So it is dropped, loudly, not fatal.
   */
  it('drops the retired herdr backend with a warning instead of refusing to start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseTerminalBackends('tmux,herdr')).toEqual(['tmux'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer a supported backend'))
  })

  it('falls back to tmux when herdr was the only backend named', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(parseTerminalBackends('herdr')).toEqual(['tmux'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to tmux'))
  })

  it('never reports herdr sessions, even when HERDR_SESSIONS is set', () => {
    // The variable still validates so an existing environment does not fail boot, but there is no
    // backend left to name sessions for, so the resolved list is empty.
    expect(parseTerminalConfig({ HERDR_SESSIONS: 'work,default' })).toMatchObject({
      backends: ['tmux'],
      herdrSessions: [],
      herdrSessionsExplicit: true,
    })
  })

  it.each(['', ' ', 'tmux,', 'tmux,,tmux', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })

  it.each(['', 'default,', 'default,default', '../socket', '/tmp/socket', 'work space'])('rejects invalid HERDR_SESSIONS=%j', (value) => {
    expect(() => parseHerdrSessions(value)).toThrow(/HERDR_SESSIONS/)
  })
})
