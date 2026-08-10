import { describe, expect, it } from 'vitest'
import { grokOneShotSpawn } from './oneshot.js'

describe('Grok recap containment', () => {
  const options = { prompt: 'summarize this', model: 'grok-4.5', effort: 'low' as const, cwd: '/tmp/summary' }

  it('uses print JSON mode with bounded turns and no memory or plan', () => {
    const { args } = grokOneShotSpawn(options, '/tmp/isolated-grok', {})
    expect(args).toEqual([
      '--cwd', '/tmp/summary',
      '--always-approve', '--no-memory', '--no-plan', '--max-turns', '1',
      '--output-format', 'json', '--model', 'grok-4.5', '--reasoning-effort', 'low',
      '-p', 'summarize this',
    ])
  })

  it('isolates state and strips agent-discovery variables', () => {
    const { env } = grokOneShotSpawn(options, '/tmp/isolated-grok', {
      TMUX: 'socket', TMUX_PANE: '%9', MACHINE_ID: 'agent', HOME: '/real-home',
    })
    expect(env.GROK_HOME).toBe('/tmp/isolated-grok')
    expect(env.HOME).toBe('/real-home')
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
    expect(env.MACHINE_ID).toBeUndefined()
  })
})
