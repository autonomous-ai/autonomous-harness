/**
 * The recap contract, without spawning a model.
 *
 * `summariseTurn` is exercised only through its disabled path here — the package README is explicit
 * that this provider is not deterministic and belongs nowhere near CI, and a test that shells out to
 * `claude` would inherit exactly that problem.
 */
import { describe, expect, it } from 'vitest'
import { BODY_MAX_CHARS, RECAP_MAX_CHARS, excerptRecap, parseRecap, summariseTurn } from './recap.js'

describe('parseRecap', () => {
  it('splits the model’s two parts on the first blank line', () => {
    expect(parseRecap('Rebuilt the weekly pacing alert\n\nIt now runs at 08:00 and pages on 110%.')).toEqual({
      recap: 'Rebuilt the weekly pacing alert',
      body: 'It now runs at 08:00 and pages on 110%.',
    })
  })

  it('splits on the FIRST blank line, not the last', () => {
    // A body with its own paragraph breaks must not be mistaken for a second headline.
    expect(parseRecap('Headline\n\nOne.\n\nTwo.')!.body).toBe('One. Two.')
  })

  it('falls back to the headline when the model gives only one part', () => {
    expect(parseRecap('Just a headline')).toEqual({ recap: 'Just a headline', body: 'Just a headline' })
  })

  it('re-applies the caps — a model asked for 15 words will sometimes give 40', () => {
    const parsed = parseRecap(`${'word '.repeat(200)}\n\n${'body '.repeat(2000)}`)!
    expect(parsed.recap.length).toBeLessThanOrEqual(RECAP_MAX_CHARS)
    expect(parsed.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
  })

  it('NEVER appends an ellipsis when it truncates', () => {
    // The device renders this on a small round display; a line advertising its own truncation reads
    // worse than one that simply ends.
    expect(parseRecap('x '.repeat(300))!.recap).not.toMatch(/…|\.\.\.$/)
  })

  it('returns null for an empty answer rather than an empty tile', () => {
    expect(parseRecap('')).toBeNull()
    expect(parseRecap('   \n\n   ')).toBeNull()
  })
})

describe('excerptRecap — the no-model fallback', () => {
  it('takes the opening sentence as the headline', () => {
    expect(excerptRecap('Acme is at 118% of pacing. I rebuilt the alert too.')).toEqual({
      recap: 'Acme is at 118% of pacing.',
      body: 'Acme is at 118% of pacing. I rebuilt the alert too.',
    })
  })

  it('flattens newlines — the tile is one line', () => {
    expect(excerptRecap('Done\n\n  - one\n  - two')!.body).toBe('Done - one - two')
  })

  it('returns null for a turn that produced nothing', () => {
    expect(excerptRecap('   ')).toBeNull()
  })
})

describe('summariseTurn', () => {
  it('excerpts instead of spawning anything when disabled', async () => {
    const recap = await summariseTurn({
      claudeBin: '/nonexistent/claude', cwd: process.cwd(), turnText: 'Shipped it. Twice.', disabled: true,
    })
    expect(recap).toEqual({ recap: 'Shipped it.', body: 'Shipped it. Twice.' })
  })

  it('falls back rather than throwing when the binary cannot be spawned', async () => {
    // A recap must never be able to fail a turn that already succeeded.
    const recap = await summariseTurn({
      claudeBin: '/nonexistent/claude', cwd: process.cwd(), turnText: 'The answer is 42.',
    })
    expect(recap).toEqual({ recap: 'The answer is 42.', body: 'The answer is 42.' })
  })

  it('returns null for a silent turn', async () => {
    expect(await summariseTurn({ claudeBin: '/nonexistent/claude', cwd: process.cwd(), turnText: '' })).toBeNull()
  })
})
