import { describe, expect, it } from 'vitest'
import { scrubTerminalContext, TERMINAL_CONTEXT_VARIABLES } from './terminalEnvironment.js'

describe('scrubTerminalContext', () => {
  it('removes the complete tmux and Herdr routing context without touching unrelated values', () => {
    const environment = Object.fromEntries([
      ...TERMINAL_CONTEXT_VARIABLES.map((key) => [key, `value-${key}`]),
      ['PATH', '/bin'],
    ])
    expect(scrubTerminalContext(environment)).toEqual({ PATH: '/bin' })
  })
})
