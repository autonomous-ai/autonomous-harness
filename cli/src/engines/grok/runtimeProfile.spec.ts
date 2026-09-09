import { describe, expect, it } from 'vitest'
import { parseGrokFooterProfile, parseGrokModelsOutput } from './runtimeProfile.js'

describe('Grok runtime profile', () => {
  it('reads the measured idle footer', () => {
    expect(parseGrokFooterProfile('--- Grok 4.5 (medium) · always-approve ---')).toEqual({
      model: 'grok-4.5',
      effort: 'medium',
    })
  })

  it('reads the model off the composer box edge current builds print it on', () => {
    // Measured on a live pane (grok 4.6, 2026-09-09). Current builds moved the cell out of a
    // standalone footer and into the bottom edge of the composer box, where the character after
    // `(xhigh)` is the rule closing the box rather than the `·` the old rule required — so this
    // returned null on every current pane. It is the ONLY source the runtime profile has for grok's
    // model and effort, so with it silent the app could never say which model an agent was on.
    expect(parseGrokFooterProfile(
      '  ╰──────────────────────────────── Grok 4.6 (xhigh) ─╯',
    )).toEqual({ model: 'grok-4.6', effort: 'xhigh' })
    // The old layouts still have to parse: a machine on an older grok is not a machine we stop
    // reading.
    expect(parseGrokFooterProfile('Grok 4.5 (high) | always-approve'))
      .toEqual({ model: 'grok-4.5', effort: 'high' })
    // The cell can also simply end the line.
    expect(parseGrokFooterProfile('Grok 4.6 (low)')).toEqual({ model: 'grok-4.6', effort: 'low' })
  })

  it('reads a grid model, whose name is not the vendor\'s and carries no effort', () => {
    // Measured on a live pane after moving a grok agent onto the autonomous.ai grid and picking
    // DeepSeek-V4-Flash-0731. Anchoring on the word "Grok" was safe only while every model was one of
    // xAI's: a grid model matches no `Grok …` pattern, so the scan fell THROUGH the box edge and kept
    // walking up the pane until it reached the transcript, where the model had written the words
    // "Grok 4.6 (xhigh)" about itself. The pane reported `grok-4.6` while actually running DeepSeek —
    // the app stating the wrong model with full confidence, which is worse than stating none.
    expect(parseGrokFooterProfile('  ╰──── DeepSeek-V4-Flash-0731 · always-approve ─╯'))
      .toEqual({ model: 'deepseek-v4-flash-0731', effort: 'auto' })
    expect(parseGrokFooterProfile('  ╰──────── DeepSeek-V4-Flash-0731 ─╯'))
      .toEqual({ model: 'deepseek-v4-flash-0731', effort: 'auto' })
    // The edge wins over anything the transcript above it happens to say about a model.
    expect(parseGrokFooterProfile([
      '  ┃  this session defaults to Grok 4.6 (xhigh), context 500k',
      '  ╭────────────────────────────────────╮',
      '  │ ❯                                  │',
      '  ╰──── DeepSeek-V4-Flash-0731 ─╯',
    ].join('\n'))).toEqual({ model: 'deepseek-v4-flash-0731', effort: 'auto' })
  })

  it('does not mistake prose that mentions a Grok version for the footer', () => {
    // With no box edge to anchor on, the vendor's name plus `(effort)` is the only thing separating
    // chrome from prose — so the fallback keeps requiring both, and a sentence satisfies neither.
    expect(parseGrokFooterProfile('I used Grok 4.6 to write this')).toBeNull()
    expect(parseGrokFooterProfile('Grok 4.6 (xhigh) was fast')).toBeNull()
  })

  it('reads the measured model catalog and skips prose', () => {
    expect(parseGrokModelsOutput([
      'You are logged in with grok.com.',
      '',
      'Default model: grok-4.5',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
    ].join('\n'))).toEqual(['grok-4.5'])
  })
})
