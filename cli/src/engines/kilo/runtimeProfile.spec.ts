import { describe, expect, it } from 'vitest'
import { kiloFooterModelId, parseKiloModelsOutput } from './runtimeProfile.js'

/** Ids exactly as `kilo models` printed them on kilo 7.4.20 — including the two shapes opencode's parser drops. */
const CATALOG = [
  'kilo/~anthropic/claude-opus-latest',
  'kilo/~openai/gpt-latest',
  'kilo/ai21/jamba-large-1.7',
  'kilo/kilo-auto/free',
  'kilo/kilo-auto/frontier',
  'kilo/stepfun/step-3.7-flash',
  'kilo/stepfun/step-3.7-flash:free',
].join('\n')

describe('kilo model catalog', () => {
  /**
   * The regression this parser exists for. Opencode's character class has neither `~` nor `:`, and on the
   * real catalog that silently dropped 23 of 299 ids — the floating `~vendor/model-latest` aliases and
   * every `:free` / `:discounted` / `:thinking` variant. One of the casualties was the model the live
   * session was actually running, so the picker would have omitted the user's own current model.
   */
  it('keeps the ids that carry a ~ alias or a : variant', () => {
    const ids = parseKiloModelsOutput(CATALOG).map((t) => t.id)
    expect(ids).toHaveLength(7)
    expect(ids).toContain('kilo/~anthropic/claude-opus-latest')
    expect(ids).toContain('kilo/stepfun/step-3.7-flash:free')
  })

  it('splits provider from model at the FIRST slash, leaving the vendor in the model', () => {
    const entry = parseKiloModelsOutput(CATALOG).find((t) => t.id === 'kilo/stepfun/step-3.7-flash')!
    expect(entry.provider).toBe('kilo')
    expect(entry.model).toBe('stepfun/step-3.7-flash')
  })

  it('ignores anything that is not a provider/model line', () => {
    expect(parseKiloModelsOutput('loading…\n\nnot-a-model\n')).toEqual([])
  })
})

describe('kilo footer → model', () => {
  const catalog = parseKiloModelsOutput(CATALOG)

  /**
   * Measured composer footer. Note the trailing working directory: the footer is a full-width status bar,
   * so the model name has to be read as the span BETWEEN the agent separator and the provider label —
   * stripping the label alone leaves the path attached and matches nothing.
   */
  it('resolves the model kilo shows in its composer footer', () => {
    const footer = '  ┃  Code  · Auto Free Kilo Gateway                    /private/tmp/kilo-probe'
    expect(kiloFooterModelId(footer, catalog)).toBe('kilo/kilo-auto/free')
  })

  it('resolves a plain vendor model by its leaf', () => {
    expect(kiloFooterModelId('┃  Code  · Step 3.7 Flash Kilo Gateway   /tmp/x', catalog))
      .toBe('kilo/stepfun/step-3.7-flash')
  })

  /**
   * The TURN footer (`▣ Code · Auto Free · Step 3.7 Flash · 17.9s`) names the model the router resolved
   * to, not the one the user selected — and those differ whenever a `kilo-auto/*` alias is in play. It
   * carries no provider label, which is exactly what keeps it out.
   */
  it('ignores the turn footer, which names the resolved model rather than the selected one', () => {
    expect(kiloFooterModelId('▣ Code · Auto Free · Step 3.7 Flash · 17.9s', catalog)).toBeNull()
  })

  it('answers null rather than guessing when nothing matches', () => {
    expect(kiloFooterModelId('┃  Code  · Nonsense Model Kilo Gateway  /tmp/x', catalog)).toBeNull()
    expect(kiloFooterModelId('┃  Code  · Auto Free Kilo Gateway  /tmp/x', [])).toBeNull()
    expect(kiloFooterModelId('no footer here', catalog)).toBeNull()
  })
})
