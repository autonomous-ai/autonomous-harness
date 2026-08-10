import { describe, expect, it } from 'vitest'
import { ENGINE_CLI_COMMANDS, ENGINES } from './engineBin.js'

describe('canonical engine CLI commands', () => {
  it('keeps the user-facing 12-engine command contract exact and ordered', () => {
    expect(ENGINES.map((engine) => [engine, ENGINE_CLI_COMMANDS[engine]])).toEqual([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['cursor', 'agent'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['hermes', 'hermes'],
      ['commandcode', 'cmd'],
      ['devin', 'devin'],
      ['muse', 'muse'],
      ['amp', 'amp'],
      ['kilo', 'kilo'],
      ['grok', 'grok'],
    ])
  })
})
