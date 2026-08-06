// Two questions about the conformance runner, and the second is the one that matters.
//
//  1. Does the reference provider pass its own suite? (If not, the spec and the reference disagree.)
//  2. **Does the suite actually CATCH anything?** A runner that only ever goes green is worse than no
//     runner: it converts "we did not check" into "we checked and it was fine". So every rule worth
//     asserting gets a deliberately broken provider aimed at it, and the check must fail.
//
// The runner is the artifact partners are told to trust, so it needs the same regression cover as the
// provider itself. Rows below name a check by its `id` SLUG, never by its title — a reworded title
// must not break this file.
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.STEP_DELAY_MS = '0'
const { start } = await import('./server.js')
const { runConformance } = await import('./conformance.js')

let base: string
let stop: () => Promise<void>

beforeAll(async () => {
  const s = await start(0)
  base = s.url
  stop = s.close
}, 30_000)
afterAll(async () => { await stop() })

const FULL = { key: 'conformance', badKey: 'bad-key', askPhrase: 'ask me' }

describe('the runner against a conformant provider', () => {
  it('reports zero failures', async () => {
    const summary = await runConformance({ url: base, ...FULL })
    const failures = summary.results.filter((r) => r.outcome === 'FAIL')
    // Named, not counted: a bare count tells whoever broke it nothing.
    expect(failures.map((f) => `${f.id}: ${f.detail ?? ''}`)).toEqual([])
    expect(summary.pass).toBeGreaterThan(12)
  })

  it('states a reason for every skip and every manual review', async () => {
    // The rule the runner is built on: nothing is silently skipped. A SKIP without a reason is
    // indistinguishable from a check nobody wrote.
    const summary = await runConformance({ url: base, key: 'conformance' })
    const mute = summary.results.filter((r) => (r.outcome === 'SKIP' || r.outcome === 'WARN') && !r.detail)
    expect(mute.map((r) => r.id)).toEqual([])
  })

  it('unlocks more checks when given a bad key and an ask phrase', async () => {
    const bare = await runConformance({ url: base, key: 'conformance' })
    const full = await runConformance({ url: base, ...FULL })
    expect(full.pass).toBeGreaterThan(bare.pass)
  })

  it('exits non-zero-worthy only on FAIL, never on SKIP or WARN', async () => {
    const summary = await runConformance({ url: base, ...FULL })
    expect(summary.fail).toBe(0)
    // Skips and warnings are expected and MUST NOT be treated as failures — otherwise a provider that
    // legitimately refuses a mutation, or one on loopback, looks non-conformant.
    expect(summary.skip + summary.warn).toBeGreaterThan(0)
  })
})

describe('an unreachable endpoint is reported, not thrown', () => {
  it('fails rather than crashing', async () => {
    // A runner that crashes when the provider is down is useless at exactly the moment it is needed.
    const summary = await runConformance({ url: 'http://127.0.0.1:1', key: 'k' })
    expect(summary.results.find((r) => r.id === 'reachable')?.outcome).toBe('FAIL')
    expect(summary.fail).toBeGreaterThan(0)
  })
})

// ── the negative matrix ──────────────────────────────────────────────────────────────────────────

type Reply = Record<string, unknown> & { __sse?: { events: unknown[] }; __json?: true; __error?: string }
type Mutate = (method: string, params: Record<string, unknown>) => Reply | undefined

/** A minimally-correct provider, so each case below breaks exactly ONE rule. */
const baseline: Mutate = (method) => {
  if (method === 'agent.list') return { agents: [{ id: 'a', name: 'A' }] }
  if (method === 'agent.history') return { agentId: 'a', events: [] }
  if (method === 'turn.cancel') return { cancelled: true }
  if (method === 'agent.recap') return { agentId: 'a' }
  if (method === 'agent.create') return { __error: 'invalid_request' }
  if (method === 'agent.delete') return { deleted: true }
  if (method === 'agent.send') return { __sse: { events: [{ kind: 'text_delta', text: 'hi' }, { kind: 'turn_completed' }] } }
  if (method.startsWith('agent.') || method.startsWith('turn.')) return { __error: 'unsupported' }
  return {}
}

function json(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function failuresOf(mutate: Mutate): Promise<string[]> {
  const summary = await runOf(mutate)
  return summary.results.filter((r) => r.outcome === 'FAIL').map((r) => r.id)
}

async function runOf(mutate: Mutate): Promise<Awaited<ReturnType<typeof runConformance>>> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      let body = ''
      for await (const chunk of req) body += chunk
      const rpc = JSON.parse(body || '{}') as { method?: string; params?: Record<string, unknown>; id?: unknown }
      const out = mutate(rpc.method ?? '', rpc.params ?? {})
      if (out?.__error) return json(res, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: out.__error } })
      if (out?.__sse) {
        // `__json` answers agent.send as ordinary JSON, which is the whole point of that one row.
        if (out.__json) return json(res, { jsonrpc: '2.0', id: rpc.id ?? null, result: { events: out.__sse.events } })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const e of out.__sse.events) res.write(`data: ${JSON.stringify(e)}\n\n`)
        return res.end()
      }
      return json(res, { jsonrpc: '2.0', id: rpc.id ?? null, result: out ?? {} })
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const summary = await runConformance({ url, key: 'k', badKey: 'bad-key' })
  await new Promise<void>((r) => server.close(() => r()))
  return summary
}

describe('the suite catches deliberate violations', () => {
  // Each row: what is broken, and the check slug that must notice. Other checks failing too is
  // expected — the fake is minimal — so this asserts CONTAINMENT, not an exact set.
  const cases: Array<[string, string, Mutate]> = [
    ['a stream with no terminal frame', 'terminal-frame', (m, p) =>
      (m === 'agent.send' ? { __sse: { events: [{ kind: 'text_delta', text: 'hi' }] } } : baseline(m, p))],
    ['a stream with TWO terminal frames', 'terminal-frame', (m, p) =>
      (m === 'agent.send' ? { __sse: { events: [{ kind: 'turn_completed' }, { kind: 'turn_completed' }] } } : baseline(m, p))],
    ['agent.send answering with ordinary JSON instead of SSE', 'streams-sse', (m, p) =>
      (m === 'agent.send' ? { __sse: { events: [{ kind: 'turn_completed' }] }, __json: true } : baseline(m, p))],
    ['a bad credential being accepted', 'credential-rejected', baseline],
    ['a bad credential getting a list back instead of an error', 'agent-list-authenticated', baseline],
    ['an empty agent list', 'agent-list', (m, p) => (m === 'agent.list' ? { agents: [] } : baseline(m, p))],
    ['tool events with no toolId', 'tool-pairing', (m, p) =>
      (m === 'agent.send' ? { __sse: { events: [{ kind: 'tool_start', tool: 'x' }, { kind: 'turn_completed' }] } } : baseline(m, p))],
    ['an early cancel being ignored', 'early-cancel', baseline],
    ['history disagreeing with the stream', 'history-matches-stream', (m, p) =>
      (m === 'agent.history' ? { agentId: 'a', events: [{ kind: 'text_delta', text: 'DIFFERENT' }] } : baseline(m, p))],
    ['an unknown method being answered instead of refused', 'unknown-method', (m, p) =>
      (m === 'agent.nonexistentMethod' ? { ok: true } : baseline(m, p))],
    ['an unknown request field being fatal', 'unknown-fields', (m, p) =>
      (m === 'agent.list' && p.somethingFromALaterRevision ? { __error: 'invalid_request' } : baseline(m, p))],
  ]

  it.each(cases)('catches %s as %s', async (_label, slug, mutate) => {
    expect(await failuresOf(mutate)).toContain(slug)
  }, 20_000)
})

describe('the runner does not leave state behind in a live tenant', () => {
  it('deletes the agent a lax provider creates from its empty-name probe', async () => {
    // `agent-mutations` probes with an EMPTY name, expecting a refusal. A provider that accepts it has
    // just created an agent nobody asked for — and this runner is pointed at production endpoints with
    // real credentials, so it has to clean up after itself rather than quietly adding a row to
    // somebody's product.
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const lax: Mutate = (method, params) => {
      calls.push({ method, params })
      if (method === 'agent.create') return { id: 'accidentally-created', name: '' }
      return baseline(method, params)
    }
    const summary = await runOf(lax)

    const deleted = calls.find((c) => c.method === 'agent.delete')
    expect(deleted, 'the accidentally-created agent was never deleted').toBeTruthy()
    expect(deleted!.params.agentId).toBe('accidentally-created')

    // Reported as a WARN, not a pass: loose validation is still worth telling the partner about.
    const mutations = summary.results.find((r) => r.id === 'agent-mutations')!
    expect(mutations.outcome).toBe('WARN')
    expect(mutations.detail).toContain('accidentally-created')
  }, 20_000)

  it('says so LOUDLY when the agent it created cannot be cleaned up', async () => {
    // Worst case: accepted the empty name and answered with no id. Nothing can be deleted, so the
    // partner has to be told by hand rather than left with an orphan they never hear about.
    const noId: Mutate = (method, params) =>
      (method === 'agent.create' ? { name: '' } : baseline(method, params))
    const summary = await runOf(noId)
    const mutations = summary.results.find((r) => r.id === 'agent-mutations')!
    expect(mutations.outcome).toBe('WARN')
    expect(mutations.detail).toMatch(/cannot be cleaned up|by hand/i)
  }, 20_000)
})
