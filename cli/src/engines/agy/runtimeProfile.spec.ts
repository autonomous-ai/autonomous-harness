import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agyPaneIdle, parseAgyFooterProfile, parseAgyModelsOutput } from './runtimeProfile.js'

/** Verbatim `agy models` output (1.1.14), including the stderr notice a merged capture would carry. */
const MODELS = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.5-flash-high\tGemini 3.5 Flash (High)
gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)
gemini-3.5-flash-low\tGemini 3.5 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`

describe('agy model catalog', () => {
  it('parses every row the real catalog prints, and drops the progress notice', () => {
    const models = parseAgyModelsOutput(MODELS)
    // 14 catalog rows in, 14 slugs out — the count is the assertion that matters: a character class
    // that misses one vendor's punctuation drops models from the picker with no error anywhere.
    expect(models).toHaveLength(14)
    expect(models).toContain('gemini-3.7-flash-high')
    expect(models).toContain('claude-opus-4-6-thinking')
    expect(models).toContain('gpt-oss-120b-medium')
    expect(models.some((m) => m.startsWith('Fetching'))).toBe(false)
  })
})

describe('agy pane footer', () => {
  it('reads the idle footer as a catalog slug plus its effort', () => {
    const capture = [
      '  ↑/↓ Navigate · enter Select · esc Skip',
      'esc to cancel                                          Gemini 3.7 Flash · high',
    ].join('\n')
    expect(parseAgyFooterProfile(capture)).toEqual({ model: 'gemini-3.7-flash-high', effort: 'high' })
  })

  it('reads the footer off a real captured pane, escapes and all', () => {
    const capture = readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/permission-agy.txt', import.meta.url)), 'utf8')
    expect(parseAgyFooterProfile(capture)).toEqual({ model: 'gemini-3.7-flash-high', effort: 'high' })
  })

  it('ignores a pane with no footer', () => {
    expect(parseAgyFooterProfile('> just a prompt\nno footer here')).toBeNull()
  })
})

describe('agy pane busy/idle', () => {
  it('reads a real captured pane', () => {
    const idle = readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/question-agy.txt', import.meta.url)), 'utf8')
    // The question fixture was captured with a dialog open, so the pane is NOT idle.
    expect(parseAgyFooterProfile(idle)).not.toBeNull()
  })

  it('treats "? for shortcuts" as idle and "esc to cancel" as busy', () => {
    expect(agyPaneIdle('>\n? for shortcuts                    Gemini 3.7 Flash · high')).toBe(true)
    expect(agyPaneIdle('  ↑/↓ Navigate\nesc to cancel                Gemini 3.7 Flash · high')).toBe(false)
    expect(agyPaneIdle('nothing familiar here')).toBe(false)
  })
})
