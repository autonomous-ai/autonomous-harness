import { describe, expect, it } from 'vitest'
import { BACKEND_ONLY_DOWN_TYPES } from './webWs.js'

/**
 * `handleFrame` forwards anything it does not recognise straight to the adapter
 * (`client.sendDown(frame)`), so the only thing standing between a web client and a frame the
 * adapter obeys as the backend's own is the refusal list. `handleFrame` itself needs a live socket
 * to exercise, so what is pinned here is that list — the realistic regression is an entry being
 * dropped during a tidy-up, which reopens the hole silently.
 */
describe('frames a web client may never forge', () => {
  it('refuses the two backend-authoritative frames that are not `__`-prefixed', () => {
    // machine_meta names the account's private grid — the inference endpoint every agent on that
    // computer is then pointed at. machine_revoked makes the adapter clear its session and exit.
    expect([...BACKEND_ONLY_DOWN_TYPES].sort()).toEqual(['machine_meta', 'machine_revoked'])
  })

  it('covers only frames that are NOT already caught by the `__` rule', () => {
    // A `__`-prefixed type here would be dead weight: handleFrame drops those earlier, and listing
    // one would suggest this set is the whole rule rather than the exception to it.
    for (const type of BACKEND_ONLY_DOWN_TYPES) expect(type.startsWith('__')).toBe(false)
  })
})
