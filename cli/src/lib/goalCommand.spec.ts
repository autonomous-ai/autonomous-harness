import { describe, expect, it } from 'vitest'
import { adaptGoalCommand, adaptSlashCommand, engineSupportsGoal, engineSupportsLoop } from './goalCommand.js'

const ALL_ENGINES = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok'] as const
const NON_LOOP = ['codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok'] as const

describe('adaptGoalCommand', () => {
  it('keeps /goal verbatim for engines with a native /goal (claude, codex)', () => {
    for (const engine of ['claude', 'codex'] as const) {
      expect(engineSupportsGoal(engine)).toBe(true)
      expect(adaptGoalCommand('/goal fix the bug', engine)).toBe('/goal fix the bug')
      expect(adaptGoalCommand('/goal', engine)).toBe('/goal')
    }
  })

  it('drops the leading slash for engines without a verified native /goal', () => {
    for (const engine of ALL_ENGINES.filter((candidate) => candidate !== 'claude' && candidate !== 'codex')) {
      expect(engineSupportsGoal(engine)).toBe(false)
      expect(adaptGoalCommand('/goal fix the bug', engine)).toBe('goal fix the bug')
      expect(adaptGoalCommand('/goal', engine)).toBe('goal')
      expect(adaptGoalCommand('/goal\nmulti line', engine)).toBe('goal\nmulti line')
    }
  })

  it('leaves non-/goal content untouched for every engine', () => {
    for (const engine of ALL_ENGINES) {
      expect(adaptGoalCommand('just a normal message', engine)).toBe('just a normal message')
      expect(adaptGoalCommand('/model gpt-5', engine)).toBe('/model gpt-5')
      expect(adaptGoalCommand('/goalkeeper stats', engine)).toBe('/goalkeeper stats') // /goal must be a whole token
      expect(adaptGoalCommand('tell me the /goal', engine)).toBe('tell me the /goal') // only a LEADING token is adapted
    }
  })
})

describe('adaptSlashCommand — /loop', () => {
  it('keeps /loop verbatim for claude, the only engine that has one', () => {
    expect(engineSupportsLoop('claude')).toBe(true)
    expect(adaptSlashCommand('/loop keep fixing tests', 'claude')).toBe('/loop keep fixing tests')
    expect(adaptSlashCommand('/loop', 'claude')).toBe('/loop')
  })

  it('drops the WHOLE token elsewhere — "loop" left behind is not an instruction', () => {
    for (const engine of NON_LOOP) {
      expect(engineSupportsLoop(engine)).toBe(false)
      expect(adaptSlashCommand('/loop keep fixing tests', engine)).toBe('keep fixing tests')
      expect(adaptSlashCommand('/loop\nmulti line', engine)).toBe('multi line')
    }
  })

  it('never turns a bare /loop into an empty message', () => {
    // An empty submission looks like the turn was sent and then does nothing at all, which is worse
    // than a stray word.
    for (const engine of NON_LOOP) expect(adaptSlashCommand('/loop', engine)).toBe('loop')
  })

  it('leaves non-/loop content untouched for every engine', () => {
    for (const engine of ALL_ENGINES) {
      expect(adaptSlashCommand('/loopback through the proxy', engine)).toBe('/loopback through the proxy')
      expect(adaptSlashCommand('run it in a /loop', engine)).toBe('run it in a /loop')
      expect(adaptSlashCommand('just a normal message', engine)).toBe('just a normal message')
    }
  })

  it('adapts goal and loop independently on the same engine', () => {
    // codex has /goal but not /loop — the two rules must not interfere.
    expect(adaptSlashCommand('/goal ship it', 'codex')).toBe('/goal ship it')
    expect(adaptSlashCommand('/loop ship it', 'codex')).toBe('ship it')
    expect(adaptSlashCommand('/goal ship it', 'cursor')).toBe('goal ship it')
    expect(adaptSlashCommand('/loop ship it', 'cursor')).toBe('ship it')
  })
})
