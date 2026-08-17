import { describe, expect, it } from 'vitest'
import { parseHerdrSessions, parseTerminalBackends, parseTerminalConfig } from './terminalConfig.js'

describe('terminal backend configuration', () => {
  it('watches every backend when nothing is configured, and names no sessions', () => {
    // Unset is AUTO, not tmux: a second multiplexer that only works for people who know an env var is
    // not the same product as `tmux new` + engine. The empty session list is not "no Herdr" — it means
    // the names come from discovery, so a session started later is adopted without a restart.
    expect(parseTerminalConfig({})).toEqual({
      backends: ['tmux', 'herdr'],
      herdrSessions: [],
      backendsExplicit: false,
      herdrSessionsExplicit: false,
    })
  })

  it('treats an explicit value as a pin, and an explicit session list as a strict allowlist', () => {
    expect(parseTerminalConfig({
      TERMINAL_BACKENDS: 'herdr,tmux',
      HERDR_SESSIONS: 'work,default',
    })).toEqual({
      backends: ['herdr', 'tmux'],
      herdrSessions: ['work', 'default'],
      backendsExplicit: true,
      herdrSessionsExplicit: true,
    })
    // Turning Herdr off is still one variable, and it stays off whatever is running on the machine.
    expect(parseTerminalConfig({ TERMINAL_BACKENDS: 'tmux' })).toMatchObject({
      backends: ['tmux'],
      herdrSessions: [],
      backendsExplicit: true,
    })
    // An allowlist without a backend list still applies — auto-detects the backends, pins the sessions.
    expect(parseTerminalConfig({ HERDR_SESSIONS: 'work' })).toMatchObject({
      backends: ['tmux', 'herdr'],
      herdrSessions: ['work'],
      herdrSessionsExplicit: true,
    })
  })

  it.each(['', ' ', 'tmux,', 'tmux,,herdr', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })

  it.each(['', 'default,', 'default,default', '../socket', '/tmp/socket', 'work space'])('rejects invalid HERDR_SESSIONS=%j', (value) => {
    expect(() => parseHerdrSessions(value)).toThrow(/HERDR_SESSIONS/)
  })
})
