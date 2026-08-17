import { describe, expect, it } from 'vitest'
import { parseHerdrSessions, parseTerminalBackends, parseTerminalConfig } from './terminalConfig.js'

describe('terminal backend configuration', () => {
  it('defaults to tmux without requiring Herdr', () => {
    expect(parseTerminalConfig({})).toEqual({ backends: ['tmux'], herdrSessions: [] })
  })

  it('preserves backend and named-session order for deterministic ranking', () => {
    expect(parseTerminalConfig({
      TERMINAL_BACKENDS: 'herdr,tmux',
      HERDR_SESSIONS: 'work,default',
    })).toEqual({ backends: ['herdr', 'tmux'], herdrSessions: ['work', 'default'] })
  })

  it.each(['', ' ', 'tmux,', 'tmux,,herdr', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })

  it.each(['', 'default,', 'default,default', '../socket', '/tmp/socket', 'work space'])('rejects invalid HERDR_SESSIONS=%j', (value) => {
    expect(() => parseHerdrSessions(value)).toThrow(/HERDR_SESSIONS/)
  })
})
