import { describe, expect, it } from 'vitest'
import { ENGINES, aliasesFor, engineCommand, resolveEngine } from './engineBin.js'

/**
 * Help text is the only place these names are ever seen, so the danger is advertising a command that
 * does not work — printing `harness cmd` while the parser only answers to `harness commandcode` would
 * be a help page that lies. These tests tie the two together.
 */
describe('engine command names', () => {
  it('advertises Command Code under the name its own CLI uses', () => {
    // `cmd <command> [options]` is command-code 1.6.0's usage line, and `cmd` its package's first bin.
    expect(engineCommand('commandcode')).toBe('cmd')
    // The id keeps working — it is what the web, the device and the DB call this engine.
    expect(aliasesFor('commandcode')).toContain('commandcode')
    expect(aliasesFor('commandcode')).not.toContain('cmd')
  })

  it('every name it prints is a name it accepts', () => {
    for (const engine of ENGINES) {
      expect(resolveEngine(engineCommand(engine)), `primary for ${engine}`).toBe(engine)
      for (const alias of aliasesFor(engine)) {
        expect(resolveEngine(alias), `alias ${alias}`).toBe(engine)
      }
    }
  })

  it('leaves engines whose CLI matches their id alone', () => {
    expect(engineCommand('claude')).toBe('claude')
    expect(aliasesFor('claude')).toEqual([])
    // Cursor ships extra binaries but is still called cursor here.
    expect(engineCommand('cursor')).toBe('cursor')
    expect(aliasesFor('cursor')).toEqual(['agent', 'cursor-agent'])
  })
})
