import { describe, expect, it } from 'vitest'
import {
  commandcodeBannerModel,
  commandcodeEffortRefusal,
  countCommandcodeRefusals,
  parseCommandcodeModelsOutput,
} from './runtimeProfile.js'

// Verbatim from `commandcode --list-models` (Command Code 1.6.0): the counter line, two sections, the
// `(default)` marker, and the two id shapes — vendor-prefixed and bare.
const OUTPUT = [
  'Available models  ·  50 models',
  '',
  'Open Source',
  '',
  'deepseek/deepseek-v4-pro             hybrid-attention long-context reasoning',
  'deepseek/deepseek-v4-flash           fast hybrid-attention reasoning (default)',
  'moonshotai/kimi-k2.7-code-highspeed  high-speed long-horizon coding with vision',
  '',
  'Anthropic',
  '',
  'claude-sonnet-5                      best combo of speed & intelligence (recommended)',
  'claude-haiku-4-5                     fastest & most compact, great for quick tasks',
].join('\n')

describe('command code model catalog', () => {
  it('reads ids and sections, and keeps the short name the device labels by', () => {
    const targets = parseCommandcodeModelsOutput(OUTPUT)

    expect(targets.map((t) => `${t.section}:${t.shortId}`)).toEqual([
      'Open Source:deepseek-v4-pro',
      'Open Source:deepseek-v4-flash',
      'Open Source:kimi-k2.7-code-highspeed',
      'Anthropic:claude-sonnet-5',
      'Anthropic:claude-haiku-4-5',
    ])
    // `/model` needs the full id back — the short form is only what the profile and the chip carry.
    expect(targets[2].id).toBe('moonshotai/kimi-k2.7-code-highspeed')
    // A bare id is its own short form.
    expect(targets[3]).toMatchObject({ id: 'claude-sonnet-5', shortId: 'claude-sonnet-5' })
    expect(targets.filter((t) => t.isDefault).map((t) => t.id)).toEqual(['deepseek/deepseek-v4-flash'])
  })

  it('ignores the counter line and never mistakes a heading for a model', () => {
    expect(parseCommandcodeModelsOutput('Available models  ·  50 models')).toEqual([])
    expect(parseCommandcodeModelsOutput('Open Source\n\nAnthropic\n')).toEqual([])
  })

  it('reads the words Command Code refuses an unsupported effort with', () => {
    expect(commandcodeEffortRefusal('◼ Reasoning effort not supported for Kimi K2.6.'))
      .toBe('Reasoning effort not supported for Kimi K2.6')
    expect(commandcodeEffortRefusal('❯ Ask your question...')).toBeNull()
  })

  it('counts refusals so an older one cannot be read as this command being refused', () => {
    const pane = [
      '◼ Reasoning effort not supported for Kimi K2.6.',
      '❯ /effort high',
      '◼ Reasoning effort not supported for Kimi K2.6.',
    ].join('\n')
    expect(countCommandcodeRefusals(pane)).toBe(2)
    expect(countCommandcodeRefusals('❯ Ask your question...')).toBe(0)
  })

  it('reads the running model out of the session banner', () => {
    const banner = [
      '# Command Code v1.6.0',
      '# models: kimi-k2.6 · taste-1',
      '# /private/tmp/rp2/cc',
    ].join('\n')

    expect(commandcodeBannerModel(banner)).toBe('kimi-k2.6')
    expect(commandcodeBannerModel('# Command Code v1.6.0')).toBeNull()
  })
})
