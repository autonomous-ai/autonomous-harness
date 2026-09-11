// The device renders these on a round 466px screen, so the caps and the never-an-ellipsis rule are
// the point — not the happy path.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn())
vi.mock('./client.js', () => ({ fetchRecap: call }))

const { BODY_MAX_CHARS, RECAP_MAX_CHARS, deriveRecap, fetchProviderRecap, toRecapEvent } =
  await import('./recap.js')

beforeEach(() => vi.clearAllMocks())

describe('toRecapEvent', () => {
  it('needs a headline — an entry without one renders as nothing', () => {
    expect(toRecapEvent({ text: 'a body but no headline' })).toBeNull()
    expect(toRecapEvent(undefined)).toBeNull()
    expect(toRecapEvent({ recap: '   ' })).toBeNull()
  })

  it('falls back to the headline so the reader never opens on an empty pane', () => {
    expect(toRecapEvent({ recap: 'Fixed it' })).toEqual({ kind: 'summary', recap: 'Fixed it', text: 'Fixed it' })
  })

  it('flattens whitespace — the tile is one line and newlines waste it', () => {
    expect(toRecapEvent({ recap: 'a\n\n  b\tc' })!.recap).toBe('a b c')
  })

  it('caps without ever appending an ellipsis', () => {
    const long = 'word '.repeat(200)
    const out = toRecapEvent({ recap: long, text: long })!
    expect(out.recap.length).toBeLessThanOrEqual(RECAP_MAX_CHARS)
    expect(out.text.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
    // A truncated line that ADVERTISES its truncation reads worse than one that simply ends.
    expect(out.recap.endsWith('…')).toBe(false)
    expect(out.recap.endsWith('...')).toBe(false)
  })

  it('cuts at a word boundary, but not so far back that the line collapses', () => {
    const unbroken = 'x'.repeat(RECAP_MAX_CHARS + 50)
    expect(toRecapEvent({ recap: unbroken })!.recap.length).toBe(RECAP_MAX_CHARS)
  })
})

describe('deriveRecap — the gap-fill when a provider declares nothing', () => {
  it('uses the opening sentence as the headline', () => {
    const out = deriveRecap('Acme is at 118%. There is more detail after this.')!
    expect(out.recap).toBe('Acme is at 118%.')
    expect(out.text).toBe('Acme is at 118%. There is more detail after this.')
  })

  it('uses the whole thing when there is no sentence terminator', () => {
    expect(deriveRecap('no terminator here')!.recap).toBe('no terminator here')
  })

  it('says nothing rather than inventing a tile for a silent turn', () => {
    expect(deriveRecap('')).toBeNull()
    expect(deriveRecap('   \n  ')).toBeNull()
  })
})

describe('fetchProviderRecap', () => {
  const opts = { url: 'u', credential: 'k' }

  it('asks for the agent’s LAST recap and maps it', async () => {
    call.mockResolvedValue({ recap: 'Did the thing', text: 'Did the thing, at length' })
    const out = await fetchProviderRecap(opts, 'alpha')
    // No `n`: the method returns one recap, so there is nothing to page through and nothing to clamp.
    expect(call).toHaveBeenCalledWith(opts, 'alpha')
    expect(out).toEqual({ kind: 'summary', recap: 'Did the thing', text: 'Did the thing, at length' })
  })

  it('takes the SAME object shape the turn stream pushes', async () => {
    // `agent.recap` and `recap_end` carry `{recap, text}` alike, which is what lets one mapper serve
    // both. A pull that needed its own field names would need its own mapper, and two mappers are how
    // the live tile and the restored tile end up saying different things about the same turn.
    call.mockResolvedValue({ recap: 'Headline' })
    expect(await fetchProviderRecap(opts, 'alpha')).toEqual(toRecapEvent({ recap: 'Headline' }))
  })

  it('NOTHING is legitimate — the caller then excerpts the turn instead', async () => {
    // A provider that does not summarise says so by answering with no `recap`. There is no capability
    // to declare and nothing to refuse; absence IS the answer.
    call.mockResolvedValue({ agentId: 'alpha' })
    expect(await fetchProviderRecap(opts, 'alpha')).toBeNull()
  })

  it('drops a recap belonging to a DIFFERENT turn', async () => {
    // `agent.recap` is scoped to an agent and cannot be scoped to a turn, so the last recap a provider
    // holds the instant a turn ends is very often the PREVIOUS turn's.
    call.mockResolvedValue({ recap: 'stale', turnId: 't-old' })
    expect(await fetchProviderRecap(opts, 'alpha', { turnId: 't-now' })).toBeNull()
  })

  it('keeps a recap that names no turn — the field is optional', async () => {
    call.mockResolvedValue({ recap: 'untagged' })
    const out = await fetchProviderRecap(opts, 'alpha', { turnId: 't-now' })
    expect(out?.recap).toBe('untagged')
  })

  it('keeps a recap whose turn MATCHES', async () => {
    call.mockResolvedValue({ recap: 'mine', turnId: 't-now' })
    expect((await fetchProviderRecap(opts, 'alpha', { turnId: 't-now' }))?.recap).toBe('mine')
  })

  it('survives a provider answering with nothing at all', async () => {
    call.mockResolvedValue(undefined)
    expect(await fetchProviderRecap(opts, 'alpha')).toBeNull()
  })
})
