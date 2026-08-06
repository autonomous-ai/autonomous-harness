import { describe, expect, it } from 'vitest'
import {
  devinFooterModel,
  devinModelCommandResult,
  devinModelLabel,
  parseDevinModelsOutput,
  splitDevinModelId,
} from './runtimeProfile.js'

// Copied verbatim from `devin models list` on this computer (devin 3000.3.22) — families with efforts in
// the id, a Fast tier, a "No Thinking" row, families with no effort at all, and an opaque upper-case id.
const OUTPUT = [
  'Available models (38 families)',
  '',
  'Claude Opus 5 (claude-opus-5)',
  '  aliases: opus',
  '  claude-opus-5-medium                   Claude Opus 5 Medium  [$5 / MTok In · $25 / MTok Out]',
  '  claude-opus-5-xhigh                    Claude Opus 5 XHigh  [$5 / MTok In · $25 / MTok Out]',
  '  claude-opus-5-max-fast                 Claude Opus 5 Max Fast  [$10 / MTok In · $50 / MTok Out]',
  '',
  'GPT-5.6 Sol (gpt-5.6-sol)',
  '  gpt-5-6-sol-none                       GPT-5.6 Sol No Thinking  [$5 / MTok In · $30 / MTok Out]',
  '  gpt-5-6-sol-high                       GPT-5.6 Sol High Thinking  [$5 / MTok In · $30 / MTok Out]',
  '',
  'SWE-1.6 Slow (swe-1.6-slow)',
  '  swe-1-6-slow                           SWE-1.6 Slow  [200K context, $0.3 / MTok In · $1.5 / MTok Out]',
  '',
  'Gemini 3 Flash (gemini-3-flash)',
  '  MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL  Gemini 3 Flash Minimal  [$0.5 / MTok In · $3 / MTok Out]',
].join('\n')

describe('devin model catalog', () => {
  it('splits the effort out of a model id, keeping Fast as part of the model', () => {
    expect(splitDevinModelId('claude-opus-5-medium', 'claude-opus-5')).toEqual({
      modelKey: 'claude-opus-5', effort: 'medium', fast: false,
    })
    expect(splitDevinModelId('claude-opus-5-max-fast', 'claude-opus-5')).toEqual({
      modelKey: 'claude-opus-5-fast', effort: 'max', fast: true,
    })
    // `-priority` is the same premium tier as `-fast` on OpenAI families; missing it collapsed three
    // distinct models onto one effort-less row when the parser guessed from the trailing token.
    expect(splitDevinModelId('gpt-5-6-sol-low-priority', 'gpt-5.6-sol')).toEqual({
      modelKey: 'gpt-5-6-sol-priority', effort: 'low', fast: true,
    })
    // `slow` is part of the family name, not an effort — the row must stay a single `auto` option.
    expect(splitDevinModelId('swe-1-6-slow', 'swe-1.6-slow')).toEqual({
      modelKey: 'swe-1-6-slow', effort: 'auto', fast: false,
    })
    // No family to anchor on (devin's opaque ids) → kept whole, applied verbatim.
    expect(splitDevinModelId('MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL', 'gemini-3-flash')).toEqual({
      modelKey: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL', effort: 'auto', fast: false,
    })
  })

  it('parses the catalog into model + effort, ignoring the header and alias lines', () => {
    const targets = parseDevinModelsOutput(OUTPUT)

    expect(targets.map((t) => `${t.label} / ${t.effort}`)).toEqual([
      'Claude Opus 5 / medium',
      'Claude Opus 5 / xhigh',
      'Claude Opus 5 Fast / max',
      'GPT-5.6 Sol / none',
      'GPT-5.6 Sol / high',
      // No effort in the id → devin's own display is kept whole, which is what separates the variants
      // it packs into one family (`GLM-5.2 High` vs `GLM-5.2 High 1M`).
      'SWE-1.6 Slow / auto',
      'Gemini 3 Flash Minimal / auto',
    ])
    // The model key follows the label, so effort never splits one model into two.
    expect(targets.filter((t) => t.modelKey === 'claude-opus-5')).toHaveLength(2)
    // The id is what `/model` is given, verbatim.
    expect(targets.find((t) => t.effort === 'max')?.id).toBe('claude-opus-5-max-fast')
  })

  it('hoists only the effort the id proves, so a family named after one survives', () => {
    // `Qwen 3.6 Max Preview` has no effort suffix in its id — "Max" is part of its name.
    expect(devinModelLabel('Qwen 3.6 Max Preview', 'auto')).toBe('Qwen 3.6 Max Preview')
    expect(devinModelLabel('GPT-5.6 Sol Low Thinking Fast', 'low')).toBe('GPT-5.6 Sol Fast')
    expect(devinModelLabel('GPT-5.6 Sol No Thinking', 'none')).toBe('GPT-5.6 Sol')
    expect(devinModelLabel('GLM-5.2 Max 1M', 'max')).toBe('GLM-5.2 1M')
    // `Max` inside `MiniMax` is not a word of its own.
    expect(devinModelLabel('MiniMax M3', 'auto')).toBe('MiniMax M3')
  })

  it('ignores rows that arrive before any family heading', () => {
    expect(parseDevinModelsOutput('  orphan-row   Orphan  [x]\n')).toEqual([])
    expect(parseDevinModelsOutput('Available models (38 families)\n')).toEqual([])
  })

  it('reads the outcome devin prints after /model', () => {
    expect(devinModelCommandResult('❭ /model swe-1-6-slow\n✓ Model set to SWE-1.6 Slow')).toBe('ok')
    expect(devinModelCommandResult('❭ /model adaptive\n✗ Model not available\n  /upgrade to access this model'))
      .toBe('unavailable')
    expect(devinModelCommandResult('❭ Ask Devin to build features')).toBeNull()
  })

  it('reads the current model out of the footer, whichever hint it is showing', () => {
    const pane = (hint: string) => [
      '❭ Ask Devin to build features, fix bugs, or work on your code',
      '─────────────────────────────────────',
      `SWE-1.6 Slow                                    ${hint}`,
      '',
    ].join('\n')

    // The right-hand hint rotates, so it cannot anchor the read — both of these are real footers.
    expect(devinFooterModel(pane('See all keyboard shortcuts: /shortcuts'))).toBe('SWE-1.6 Slow')
    expect(devinFooterModel(pane('Type while the agent works to queue messages'))).toBe('SWE-1.6 Slow')
    expect(devinFooterModel('')).toBeNull()
  })

  it('reads past an overlay that devin draws BELOW the footer', () => {
    // Captured from a live pane with `/model` typed: the slash-command menu renders under the footer, so
    // "the last non-empty line" was the menu, the label never resolved, and the chip stayed blank.
    const pane = [
      '❭ /model',
      '─────────────────────────────────────',
      'SWE-1.6 Slow                                    tab next · shift+tab prev · ↵ accept · esc close',
      '● /model [adaptive|claude-fable-5|claude-haiku-4.5|...] - Interactively choose a model',
      '',
    ].join('\n')
    // The menu line has no second cell; the footer's two-cell shape is what identifies it.
    expect(devinFooterModel(pane)).toBe('SWE-1.6 Slow')
  })

  it('reads a footer straight off a raw capture, escape codes and all', () => {
    // ingestPane strips ANSI before calling, but nothing enforces that on other callers — and a label
    // carrying SGR codes matches no catalogue entry, which fails silently as "no model".
    const raw = '\u001b[38;2;124;124;124mSWE-1.6 Slow\u001b[39m      \u001b[2mesc close\u001b[0m'
    expect(devinFooterModel(raw)).toBe('SWE-1.6 Slow')
  })
})
