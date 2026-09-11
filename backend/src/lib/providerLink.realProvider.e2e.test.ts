// The WHOLE chain, across both repositories:
//
//   client frame → providerLink → HTTP/SSE → the real reference-provider → frames back
//
// `providerLink.e2e.test.ts` drives a provider this repository defines in-test, which proves our
// client against OUR reading of the protocol. That is exactly the test that cannot notice when the
// two readings drift. This one talks to the published implementation instead.
//
// GATED ON `PROVIDER_E2E=1`, and deliberately not skipped by default when the checkout is missing —
// see the resolution block. A test that quietly does nothing reports green forever.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ENABLED = process.env.PROVIDER_E2E === '1'
const HERE = dirname(fileURLToPath(import.meta.url))
/** The published contract lives in a sibling checkout. */
const PROVIDER_DIR = resolve(HERE, '../../../../../autonomous-harness/provider/reference-provider')

const published = vi.hoisted(() => [] as Array<{ machineId: string; frame: { type?: string; payload?: Record<string, unknown> } }>)
const binding = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('../config/env.js', () => ({ env: { PROVIDER_ALLOW_INSECURE_URLS: true } }))
vi.mock('./prisma.js', () => ({ prisma: { machine: { findUnique: vi.fn(async () => binding.current) } } }))
vi.mock('./bus.js', () => ({
  publishUp: vi.fn(async (machineId: string, msg: { frame: unknown }) => {
    published.push({ machineId, frame: msg.frame as { type?: string } })
    return 1
  }),
  pushMachineRecap: vi.fn(async () => {}),
  getMachineRecaps: vi.fn(async () => []),
}))
vi.mock('./machineCredential.js', () => ({ decryptMachineCredential: (v: string) => v.replace('enc:', '') }))
vi.mock('./billingState.js', () => ({ machineBillingAllowsDataPlane: () => true }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { dispatch, forgetMachineMode } = await import('./providerLink.js')

let child: ChildProcess | undefined
let baseUrl = ''

/**
 * Boot the published reference provider and wait for it to announce its URL.
 *
 * Its own stdout is the handshake: parsing it is more reliable than guessing a free port and racing
 * the listen.
 */
async function bootPublishedProvider(): Promise<string> {
  return new Promise<string>((ok, reject) => {
    const proc = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: PROVIDER_DIR,
      // A small per-step pause, not zero. A turn that completes inside one tick cannot be cancelled
      // mid-flight, and the cancel path is the one thing here that only exists for a RUNNING turn.
      env: { ...process.env, PORT: '0', STEP_DELAY_MS: '15' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc
    const timer = setTimeout(() => reject(new Error('reference-provider did not start within 60s')), 60_000)
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(chunk.toString())
      if (match) { clearTimeout(timer); ok(match[0]) }
    })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`reference-provider exited ${code}: ${stderr.slice(0, 500)}`)) })
  })
}

const describeIf = ENABLED ? describe : describe.skip

if (!ENABLED) {
  console.log('[provider-e2e] SKIPPED — set PROVIDER_E2E=1 to run the cross-repository chain against the published provider.')
}

describeIf('the real chain, against the published reference-provider', () => {
  beforeAll(async () => {
    // Set but unresolvable is a FAILURE, not a skip. Once CI opts in, a missing checkout has to be
    // loud — otherwise the tier silently stops existing and nobody notices for months.
    if (!existsSync(PROVIDER_DIR)) {
      throw new Error(
        `PROVIDER_E2E=1 but the published provider is not at ${PROVIDER_DIR}. `
        + 'Check out autonomous-ai/autonomous-harness beside this repository, or unset PROVIDER_E2E.',
      )
    }
    baseUrl = await bootPublishedProvider()
  }, 90_000)

  afterAll(() => { child?.kill('SIGKILL') })

  beforeEach(() => {
    published.length = 0
    binding.current = {
      machineId: 'h1',
      userId: 'u1',
      authMode: 'provider',
      deletedAt: null,
      providerUrl: baseUrl,
      providerCredentialEncrypted: 'enc:e2e',
      createdAt: new Date('2026-08-06T00:00:00Z'),
    }
    forgetMachineMode('h1')
  })

  const types = (): string[] => published.map((p) => p.frame.type ?? '')
  const send = (text: string, payload: Record<string, unknown> = {}): Promise<void> =>
    dispatch('h1', { connId: '', frame: { type: 'message', payload: { text, agentId: 'alpha', ...payload } } })

  it('runs a full turn end to end and hands the clients their own frames', async () => {
    await send('hello')

    // The vocabulary the WEB speaks. If the published provider and our client ever disagree about the
    // protocol, this is where it shows — as a missing frame rather than as a subtle mismatch.
    const web = types().filter((t) => t !== 'commander_event')
    expect(web).toContain('turn_started')
    expect(web).toContain('text_delta')
    expect(web).toContain('turn_ended')
    // …and the DEVICE's half, which speaks a different vocabulary off the same stream.
    expect(types()).toContain('commander_event')
  }, 60_000)

  it('carries tool events through with their ids intact', async () => {
    await send('hello')
    const start = published.find((p) => p.frame.type === 'tool_start')
    const end = published.find((p) => p.frame.type === 'tool_end')
    expect(start?.frame.payload?.id).toBeTruthy()
    expect(end?.frame.payload?.id).toBe(start?.frame.payload?.id)
  }, 60_000)

  it('closes a turn the provider cut without a terminal frame', async () => {
    // The `die` scenario breaks the one-terminal rule on purpose. The client must not be left on a spinner.
    await send('die')
    expect(types()).toContain('error')
    expect(types().filter((t) => t !== 'commander_event').at(-1)).toBe('turn_ended')
  }, 60_000)

  it('reports a failed turn as an error, not as a silent finish', async () => {
    await send('fail')
    expect(types()).toContain('error')
    const ended = published.filter((p) => p.frame.type === 'turn_ended').at(-1)
    expect(ended?.frame.payload).toMatchObject({ reason: 'error' })
  }, 60_000)

  it('rebuilds a transcript the client can render', async () => {
    await send('hello')
    published.length = 0
    await dispatch('h1', { connId: '', frame: { type: 'session_get', payload: { requestId: 'r1', sessionId: 'alpha' } } })
    const reply = published.at(-1)!.frame.payload!
    expect(reply.id).toBe('alpha')
    expect((reply.events as unknown[]).length).toBeGreaterThan(0)
    // The dead branch stays dead: anything here is silently dropped by the web.
    expect(reply.messages).toEqual([])
  }, 60_000)

  it('lists the provider’s agents as the client’s agents', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'agents_list', payload: { requestId: 'r2' } } })
    const agents = published.at(-1)!.frame.payload!.agents as Array<{ id: string }>
    expect(agents.map((a) => a.id)).toEqual(['alpha', 'beta'])
  }, 60_000)

  it('reports a rejected credential in words the owner can act on', async () => {
    binding.current = { ...binding.current!, providerCredentialEncrypted: 'enc:bad-key' }
    await send('hello')
    const error = published.find((p) => p.frame.type === 'error')
    expect(String(error?.frame.payload?.message)).toMatch(/credential/i)
  }, 60_000)

  it('accepts every kind the published provider can emit', async () => {
    // THE cross-repository check. Both repositories keep their own copy of the vocabulary — ours in
    // `ALLOWED_KINDS`, theirs in the scenarios — and nothing but this notices when they drift. The
    // `everything` scenario emits all of them in one turn, so a kind we silently drop shows up here
    // as a missing client frame rather than as an empty row in production.
    await send('everything')
    const web = types().filter((t) => t !== 'commander_event')
    for (const expected of ['turn_started', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'turn_ended']) {
      expect(web, expected).toContain(expected)
    }
    // Nothing was dropped as unrenderable: an unmapped kind produces no frame at all.
    expect(published.some((p) => p.frame.type === 'error')).toBe(false)
  }, 60_000)

  it('stops a turn the user interrupted while it was still speaking', async () => {
    // The Stop button, end to end and across the repository boundary: our `cancel` frame becomes
    // `turn.cancel` on the published provider, whose stream terminates with `turn_cancelled`, which
    // has to come back to the client as an INTERRUPT — not as an error, and not as a normal finish.
    const turn = send('everything')
    // Wait for real output rather than sleeping: a fixed delay is how this test becomes flaky on a
    // loaded machine, and cancelling before the turn starts exercises a different path entirely.
    for (let i = 0; i < 200 && !published.some((p) => p.frame.type === 'text_delta'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(published.some((p) => p.frame.type === 'text_delta'), 'turn never started speaking').toBe(true)

    await dispatch('h1', { connId: '', frame: { type: 'cancel', payload: {} } })
    await turn

    const ended = published.filter((p) => p.frame.type === 'turn_ended').at(-1)
    expect(ended?.frame.payload).toMatchObject({ reason: 'interrupt', aborted: true })
    // An interrupted turn is not a broken one. An error toast here tells the user something went
    // wrong when in fact they are the thing that went wrong.
    expect(published.some((p) => p.frame.type === 'error')).toBe(false)
  }, 60_000)

  it('restores the device’s tiles from the recap the provider pushed', async () => {
    // `agent_recent` is the device's cold-start path: it has no stream to read, so this is the only
    // way yesterday's work reaches the screen.
    await send('recap')
    published.length = 0
    await dispatch('h1', { connId: '', frame: { type: 'agent_recent', payload: { requestId: 'r9', agentId: 'alpha', n: 2 } } })
    const events = published.at(-1)!.frame.payload!.events as Array<{ recap?: string }>
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.recap).toBeTruthy()
  }, 60_000)

  it('creates, renames and deletes an agent on the published provider', async () => {
    await dispatch('h1', { connId: '', frame: { type: 'agent_create', payload: { requestId: 'c1', name: 'Cross Repo' } } })
    const created = published.at(-1)!.frame.payload!.agent as { id: string; name: string }
    expect(created).toMatchObject({ name: 'Cross Repo' })

    await dispatch('h1', { connId: '', frame: { type: 'agent_update', payload: { requestId: 'u1', agentId: created.id, name: 'Renamed' } } })
    expect((published.at(-1)!.frame.payload!.agent as { name: string }).name).toBe('Renamed')

    // The freshly created agent is addressable, which is the trap a snapshotted id list falls into.
    published.length = 0
    await send('hello', { agentId: created.id })
    expect(types()).toContain('turn_ended')
    expect(published.some((p) => p.frame.type === 'error')).toBe(false)

    await dispatch('h1', { connId: '', frame: { type: 'agent_delete', payload: { requestId: 'd1', agentId: created.id } } })
    await dispatch('h1', { connId: '', frame: { type: 'agents_list', payload: { requestId: 'r3' } } })
    const agents = published.at(-1)!.frame.payload!.agents as Array<{ id: string }>
    expect(agents.map((a) => a.id)).not.toContain(created.id)
  }, 60_000)
})
