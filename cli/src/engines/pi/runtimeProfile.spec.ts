import { describe, expect, it } from 'vitest'
import {
  parsePiFooterProfile,
  parsePiModelsOutput,
  parsePiThinkingSelection,
  piThinkingSteps,
} from './runtimeProfile.js'

// The real `pi --list-models` table on this computer (pi 0.82), plus a second row with thinking off to
// prove the column is read rather than assumed.
const OUTPUT = [
  'provider  model               context  max-out  thinking  images',
  'vibe      minimax/minimax-m3  500K     65.5K    yes       no    ',
  'openai    gpt-5.6             400K     100K     no        yes   ',
].join('\n')

describe('pi model catalog', () => {
  it('reads provider, model and the thinking column', () => {
    expect(parsePiModelsOutput(OUTPUT)).toEqual([
      { id: 'vibe/minimax/minimax-m3', provider: 'vibe', model: 'minimax/minimax-m3', thinking: true },
      { id: 'openai/gpt-5.6', provider: 'openai', model: 'gpt-5.6', thinking: false },
    ])
  })

  it('skips the header and any short or noisy line', () => {
    expect(parsePiModelsOutput('provider  model  context  max-out  thinking  images')).toEqual([])
    expect(parsePiModelsOutput(' Warning: tmux extended-keys is off.')).toEqual([])
    expect(parsePiModelsOutput('')).toEqual([])
  })
})

describe('pi footer + thinking ladder', () => {
  it('reads model and thinking level from the idle footer', () => {
    const capture = [
      '/private/tmp/rp-probe/pi',
      '0.0%/500k (auto)                                          minimax/minimax-m3 • high',
    ].join('\n')

    expect(parsePiFooterProfile(capture)).toEqual({ model: 'minimax/minimax-m3', effort: 'high' })
  })

  it('refuses a footer whose level is not on the ladder', () => {
    expect(parsePiFooterProfile('0.0%/500k (auto)      minimax/minimax-m3 • nonsense')).toBeNull()
    expect(parsePiFooterProfile('nothing here')).toBeNull()
  })

  it('counts arrow steps along the ladder, and refuses to guess off it', () => {
    expect(piThinkingSteps('medium', 'high')).toBe(1)
    expect(piThinkingSteps('medium', 'off')).toBe(-3)
    expect(piThinkingSteps('max', 'max')).toBe(0)
    expect(piThinkingSteps('auto', 'high')).toBeNull()
  })

  it('reads the level pi marks as current in the Thinking Level list', () => {
    const capture = [
      'Thinking Level',
      'Select reasoning depth for thinking-capable models',
      '  off         No reasoning',
      '  low         Light reasoning (~2k tokens)',
      '→ medium      Moderate reasoning (~8k tokens)',
      '  high        Deep reasoning (~16k tokens)',
    ].join('\n')

    expect(parsePiThinkingSelection(capture)).toBe('medium')
    expect(parsePiThinkingSelection('no selection marker here')).toBeNull()
  })
})
