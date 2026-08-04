// The conformance runner is the artifact partners are told to trust, so it needs the same regression
// cover as the provider itself. Without this it only ran when somebody remembered to run it by hand.
//
// These tests boot the reference provider in-process and run the real suite against it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.STEP_DELAY_MS = '0'
const { start } = await import('./server.js')
const { runConformance, CHECKS } = await import('./conformance.js')

let base: string
let stop: () => Promise<void>

beforeAll(async () => {
  const s = await start(0)
  base = s.url
  stop = s.close
}, 30_000)
afterAll(async () => { await stop() })

const FULL = { key: 'conformance', badKey: 'bad-key', askPhrase: 'ask me something' }

describe('the runner against a conformant provider', () => {
  it('reports zero failures', async () => {
    const summary = await runConformance({ url: base, ...FULL })
    const failures = summary.results.filter((r) => r.outcome === 'FAIL')
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([])
    expect(summary.pass).toBeGreaterThan(20)
  }, 30_000)

  it('gives every skipped clause a reason — nothing is dropped silently', async () => {
    const summary = await runConformance({ url: base, ...FULL })
    const mute = summary.results.filter((r) => (r.outcome === 'SKIP' || r.outcome === 'WARN') && !r.detail?.trim())
    expect(mute.map((m) => m.id)).toEqual([])
  }, 30_000)

  it('treats an undeclared extension as SKIP, never as FAIL', async () => {
    // The reference provider declares session-recap only, so workspace-files/-write/voice are absent.
    const summary = await runConformance({ url: base, ...FULL })
    const byId = new Map(summary.results.map((r) => [r.id, r]))
    for (const id of ['HP-300', 'HP-301', 'HP-303']) {
      expect(byId.get(id)?.outcome, `${id} should skip when undeclared`).toBe('SKIP')
    }
    // …and the one that IS declared must be genuinely exercised, not waved through.
    expect(byId.get('HP-302')?.outcome).toBe('PASS')
  }, 30_000)

  it('has a unique, non-empty id and title for every check', () => {
    const ids = CHECKS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CHECKS.filter((c) => !c.title.trim())).toEqual([])
  })
})

describe('the runner degrades honestly when it is given less', () => {
  it('skips the credential clause instead of guessing when --bad-key is absent', async () => {
    const summary = await runConformance({ url: base, key: 'conformance', askPhrase: FULL.askPhrase })
    const hp013 = summary.results.find((r) => r.id === 'HP-013')
    expect(hp013?.outcome).toBe('SKIP')
    expect(hp013?.detail).toMatch(/--bad-key/)
    expect(summary.fail).toBe(0)
  }, 30_000)

  it('skips the cancel and input-required clauses when --ask-phrase is absent', async () => {
    const summary = await runConformance({ url: base, key: 'conformance', badKey: FULL.badKey })
    for (const id of ['HP-103', 'HP-104']) {
      const r = summary.results.find((x) => x.id === id)
      expect(r?.outcome, id).toBe('SKIP')
      expect(r?.detail, id).toMatch(/--ask-phrase/)
    }
    expect(summary.fail).toBe(0)
  }, 30_000)
})

describe('the runner fails loudly against a provider that is not there', () => {
  it('does not report success when the endpoint is unreachable', async () => {
    // A conformance suite that goes green against a dead URL is worse than no suite.
    const summary = await runConformance({ url: 'http://127.0.0.1:1', ...FULL })
    expect(summary.fail).toBeGreaterThan(0)
    expect(summary.results.find((r) => r.id === 'HP-020')?.outcome).toBe('FAIL')
  }, 30_000)
})
