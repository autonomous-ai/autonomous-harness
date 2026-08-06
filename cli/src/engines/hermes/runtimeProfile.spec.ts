import { describe, expect, it } from 'vitest'
import {
  hermesStatusModel,
  parseHermesConfig,
  parseHermesModelsCache,
  parseHermesPickerPage,
} from './runtimeProfile.js'

describe('hermes model catalog', () => {
  it('reads every provider page out of the picker cache', () => {
    // Shape of the real ~/.hermes/provider_models_cache.json.
    expect(parseHermesModelsCache({
      copilot: { fp: 'dd7c', at: 1785424593, models: ['gpt-5.4', 'gpt-5.4-mini'] },
      anthropic: { fp: 'bd6c', at: 1785424596, models: ['claude-fable-5', 'gpt-5.4'] },
      broken: { models: 'not a list' },
      alsoBroken: null,
    })).toEqual([
      { id: 'gpt-5.4', provider: 'copilot' },
      { id: 'gpt-5.4-mini', provider: 'copilot' },
      // Same id under a second provider is one model, kept where it was first seen.
      { id: 'claude-fable-5', provider: 'anthropic' },
    ])
    expect(parseHermesModelsCache(null)).toEqual([])
    expect(parseHermesModelsCache([])).toEqual([])
  })

  it('reads the two scalars it needs from config.yaml and nothing else', () => {
    const yaml = [
      'model:',
      '  default: minimax/minimax-m3',
      '  provider: custom',
      '  api_key: ${HERMES_SECRET}',
      'agent:',
      '  max_turns: 150',
      '  reasoning_effort: medium',
      '  personalities:',
      '    helpful: You are a helpful assistant.',
      'voice:',
      '  model: whisper-1',   // a `model` key in another section must not win
    ].join('\n')

    expect(parseHermesConfig(yaml)).toEqual({ model: 'minimax/minimax-m3', effort: 'medium' })
    expect(parseHermesConfig('model:\n  default: x\nagent:\n  reasoning_effort: nonsense'))
      .toEqual({ model: 'x', effort: null })
    expect(parseHermesConfig('')).toEqual({ model: null, effort: null })
  })

  it('reads the model out of the status line', () => {
    expect(hermesStatusModel(' ⚕ minimax-m3 │ ctx -- │ [░░░░░░░░░░] -- │ 4s │ ⏲ 0s'))
      .toBe('minimax-m3')
    expect(hermesStatusModel('no status here')).toBeNull()
  })
})

describe('hermes model picker pages', () => {
  it('reads the rows and the cursor of the provider page', () => {
    const capture = [
      '╭─ ⚙ Model Picker — Select Provider ─────────────╮',
      '│                                                │',
      '│ Current: minimax/minimax-m3 on custom          │',
      '│                                                │',
      '│   Mixture of Agents (1 model)                  │',
      '│ ❯ vibe (1 model)  ← current                    │',
      '│   GitHub Copilot (17 models)                   │',
      '│   Cancel                                       │',
      '╰────────────────────────────────────────────────╯',
    ].join('\n')

    expect(parseHermesPickerPage(capture)).toEqual({
      rows: ['Mixture of Agents (1 model)', 'vibe (1 model)', 'GitHub Copilot (17 models)', 'Cancel'],
      selected: 'vibe (1 model)',
    })
  })

  it('reads the model page, and refuses a capture with no picker in it', () => {
    const capture = [
      '╭─ ⚙ Model Picker — Anthropic ───────────────────╮',
      '│ ❯ claude-fable-5                               │',
      '│   claude-sonnet-5                              │',
      '│   ← Back                                       │',
      '╰────────────────────────────────────────────────╯',
    ].join('\n')

    expect(parseHermesPickerPage(capture)).toEqual({
      rows: ['claude-fable-5', 'claude-sonnet-5', '← Back'],
      selected: 'claude-fable-5',
    })
    expect(parseHermesPickerPage('❯ just a prompt')).toBeNull()
  })
})
