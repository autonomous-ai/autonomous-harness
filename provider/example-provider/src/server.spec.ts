/**
 * The wire, end to end: a real HTTP server, a fake `claude`, and a transcript on disk.
 *
 * Three things are pinned here that nothing else can pin:
 *   - The recap rides the turn's OWN stream, immediately before the terminal frame. Its position is
 *     the whole point: a recap that arrives after the stream closes cannot say which turn it belongs
 *     to.
 *   - The events `agent.history` returns are the ones the stream emitted. Two shapes is how the live
 *     view and the post-refresh view drift apart.
 *   - Windowing a transcript. The cursor is asserted concretely, because "page backwards" is easy to
 *     implement as something that never terminates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createProviderServer } from './server.js'
import { projectDir } from './jsonl.js'
import type { Config } from './config.js'
import type { ProviderEvent } from './types.js'

const ROOT = join(tmpdir(), `example-provider-spec-${process.pid}`)
const AGENT_CWD = join(ROOT, 'agent')
const PROJECTS = join(ROOT, 'projects')
const CLAUDE_SESSION = 'sess-1'
const TERMINAL = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required']

let turnSeq = 0
const nextTurnId = (): string => `t-${++turnSeq}`

/** A `claude` that prints the given stream-json lines and exits. */
function fakeClaude(name: string, lines: unknown[]): string {
  const path = join(ROOT, name)
  const body = lines.map((l) => `echo '${JSON.stringify(l)}'`).join('\n')
  // `cat > /dev/null` drains the stdin the provider writes the user's message to; without it the
  // script can exit before the write lands and node raises EPIPE.
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A `claude` that records the environment it was spawned with, then answers normally.
 *
 * Asserting on the config object would only prove we stored the credential; the thing that matters is
 * that the CHILD received it, because that is the whole mechanism — the CLI reads these variables
 * itself and we never see the request it makes.
 */
function envRecordingClaude(name: string, envDump: string, lines: unknown[]): string {
  const path = join(ROOT, name)
  const body = lines.map((l) => `echo '${JSON.stringify(l)}'`).join('\n')
  writeFileSync(
    path,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n%s\\n%s\\n' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_MODEL" > ${envDump}\n${body}\n`,
  )
  chmodSync(path, 0o755)
  return path
}

const textLine = (text: string): unknown => ({
  type: 'stream_event',
  session_id: CLAUDE_SESSION,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const resultLine = (failed = false): unknown => ({
  type: 'result',
  session_id: CLAUDE_SESSION,
  ...(failed ? { is_error: true, result: 'boom' } : { subtype: 'success', result: 'ok' }),
})

function config(claudeBin: string, anthropic?: Config['anthropic']): Config {
  return {
    agents: [
      { id: 'scratch', name: 'Scratch', description: 'test agent', cwd: AGENT_CWD },
      { id: 'agent-2', name: 'Second', description: 'second agent', cwd: AGENT_CWD },
    ],
    workspaceRoot: ROOT,
    agentsFile: join(ROOT, 'agents.json'),
    claudeBin,
    ...(anthropic ? { anthropic } : {}),
    model: 'test-model',
    port: 0,
    stateFile: join(ROOT, `state-${Math.random().toString(36).slice(2)}.json`),
    claudeProjectsDir: PROJECTS,
    recapModel: 'test-recap',
    // The recap one-shot would spawn a second `claude`. Disabled, `summariseTurn` excerpts the turn
    // instead — same code path into the stream, no model.
    recapDisabled: true,
  }
}

/** Boot, run one request against it, shut down. Port 0 so tests never collide. */
async function withServer<T>(
  claudeBin: string,
  fn: (port: number, deps: ReturnType<typeof createProviderServer>['deps']) => Promise<T>,
  anthropic?: Config['anthropic'],
): Promise<T> {
  const { server, deps } = createProviderServer(config(claudeBin, anthropic))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    return await fn(port, deps)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

async function rpc<T = Record<string, unknown>>(port: number, method: string, params: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: unknown }
  if (body.error) throw new Error(`rpc ${method} failed: ${JSON.stringify(body.error)}`)
  return body.result as T
}

async function rpcError(port: number, method: string, params: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { error?: { code?: string } }
  return body.error?.code ?? '(no error)'
}

/** Run a turn and collect every SSE event, in order. */
async function runTurn(
  port: number,
  text: string,
  opts: { agentId?: string; turnId?: string; attachments?: unknown[] } = {},
): Promise<ProviderEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'agent.send',
      params: {
        agentId: opts.agentId ?? 'scratch',
        turnId: opts.turnId ?? nextTurnId(),
        message: { text, ...(opts.attachments ? { attachments: opts.attachments } : {}) },
      },
    }),
  })
  const raw = await res.text()
  return raw
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as ProviderEvent)
}

const kinds = (events: ProviderEvent[]): string[] => events.map((e) => e.kind ?? '(none)')

beforeAll(() => {
  mkdirSync(AGENT_CWD, { recursive: true })
  mkdirSync(PROJECTS, { recursive: true })
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('agents', () => {
  it('serves no descriptor — there is nothing to discover', async () => {
    await withServer(fakeClaude('claude-desc.sh', [resultLine()]), async (port) => {
      // The endpoint that used to exist is gone rather than deprecated: a client still fetching it
      // must fail loudly at integration time instead of reading a stale document.
      expect((await fetch(`http://127.0.0.1:${port}/.well-known/autonomous-provider.json`)).status).toBe(404)
    })
  })

  it('lists agents on an authenticated call — the list is per-credential, so it cannot be public', async () => {
    await withServer(fakeClaude('claude-list.sh', [resultLine()]), async (port) => {
      const out = await rpc<{ agents: Array<{ id: string }> }>(port, 'agent.list', {})
      expect(out.agents.map((a) => a.id)).toEqual(['scratch', 'agent-2'])
    })
  })

  it('rejects a bad credential distinguishably from an outage', async () => {
    await withServer(fakeClaude('claude-auth.sh', [resultLine()]), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer bad-key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.list', params: {} }),
      })
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated')
    })
  })

  it('refuses a send to an agent it does not have', async () => {
    await withServer(fakeClaude('claude-ghost.sh', [resultLine()]), async (port) => {
      expect(await rpcError(port, 'agent.send', { agentId: 'ghost', turnId: 't', message: { text: 'hi' } }))
        .toBe('not_found')
    })
  })
})

describe('the endpoint the CLI runs against', () => {
  it('hands the configured credentials to the spawned claude', async () => {
    const envDump = join(ROOT, 'env-dump.txt')
    const bin = envRecordingClaude('claude-env.sh', envDump, [resultLine()])
    const anthropic = {
      baseUrl: 'https://gateway.example.com',
      authToken: 'sk-from-config',
      model: 'my-custom-model',
    }
    await withServer(bin, async (port) => {
      await runTurn(port, 'hello')
    }, anthropic)

    expect(readFileSync(envDump, 'utf8').split('\n').slice(0, 3)).toEqual([
      'https://gateway.example.com',
      'sk-from-config',
      'my-custom-model',
    ])
  })

  it('leaves the environment alone when nothing is configured', async () => {
    // The local-login path. If this ever started injecting an empty ANTHROPIC_BASE_URL, the CLI would
    // try to reach "" instead of falling back to whatever it is logged into.
    const envDump = join(ROOT, 'env-dump-bare.txt')
    const bin = envRecordingClaude('claude-env-bare.sh', envDump, [resultLine()])
    await withServer(bin, async (port) => {
      await runTurn(port, 'hello')
    })

    expect(readFileSync(envDump, 'utf8').split('\n').slice(0, 3)).toEqual(['', '', ''])
  })
})

describe('a turn on the wire', () => {
  it('opens with turn_started and closes with exactly one terminal frame', async () => {
    const bin = fakeClaude('claude-basic.sh', [textLine('hello there'), resultLine()])
    await withServer(bin, async (port) => {
      const events = await runTurn(port, 'hi')
      expect(events[0]!.kind).toBe('turn_started')
      expect(events.filter((e) => TERMINAL.includes(e.kind ?? ''))).toHaveLength(1)
      expect(events.at(-1)!.kind).toBe('turn_completed')
      expect(kinds(events)).toContain('text_delta')
    })
  })

  it('refuses image attachments LOUDLY rather than discarding them', async () => {
    // Silent loss reads to the user as the agent ignoring what they sent.
    const bin = fakeClaude('claude-img.sh', [resultLine()])
    await withServer(bin, async (port) => {
      const events = await runTurn(port, 'what is this?', { attachments: [{ mediaType: 'image/png', data: 'AAA' }] })
      expect(events.at(-1)!.kind).toBe('turn_failed')
      expect(events.at(-1)!.error?.message).toMatch(/image/i)
    })
  })

  it('a cancel BEFORE the turn starts stops it — the point of a client-minted turnId', async () => {
    const bin = fakeClaude('claude-cancel.sh', [textLine('should never run'), resultLine()])
    await withServer(bin, async (port) => {
      const turnId = nextTurnId()
      await rpc(port, 'turn.cancel', { turnId })
      const events = await runTurn(port, 'hi', { turnId })
      expect(events.at(-1)!.kind).toBe('turn_cancelled')
      expect(kinds(events)).not.toContain('text_delta')
    })
  })

  it('accepts a cancel for a turn it has never seen', async () => {
    await withServer(fakeClaude('claude-c2.sh', [resultLine()]), async (port) => {
      expect(await rpc<{ cancelled: boolean }>(port, 'turn.cancel', { turnId: 'never' })).toEqual({ cancelled: true })
    })
  })
})

describe('the recap rides the stream', () => {
  it('brackets the wait with recap_start/recap_end, then ends terminal', async () => {
    const bin = fakeClaude('claude-recap.sh', [textLine('Rebuilt the index across four shards.'), resultLine()])
    await withServer(bin, async (port) => {
      const events = await runTurn(port, 'rebuild it')
      const order = kinds(events)
      const start = order.indexOf('recap_start')
      const end = order.indexOf('recap_end')
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      // Both BEFORE the terminal frame: a recap after the stream closes cannot say which turn it is.
      expect(order.indexOf('turn_completed')).toBeGreaterThan(end)
    })
  })

  it('gives a FAILED turn neither half — a headline would read like an accomplishment', async () => {
    const bin = fakeClaude('claude-fail.sh', [textLine('starting'), resultLine(true)])
    await withServer(bin, async (port) => {
      const order = kinds(await runTurn(port, 'go'))
      expect(order).not.toContain('recap_start')
      expect(order).not.toContain('recap_end')
      expect(order.at(-1)).toBe('turn_failed')
    })
  })

  it('closes the indicator even when a silent turn produces no headline', async () => {
    // A recap_start with no recap_end leaves the client spinning forever.
    const bin = fakeClaude('claude-silent.sh', [resultLine()])
    await withServer(bin, async (port) => {
      const order = kinds(await runTurn(port, 'say nothing'))
      expect(order.filter((k) => k === 'recap_start')).toHaveLength(1)
      expect(order.filter((k) => k === 'recap_end')).toHaveLength(1)
    })
  })

  it('still persists the recap, so agent.recap keeps working for a device with no stream', async () => {
    const bin = fakeClaude('claude-persist.sh', [textLine('Fixed the rollback path.'), resultLine()])
    await withServer(bin, async (port) => {
      await runTurn(port, 'fix it')
      const out = await rpc<{ recap?: string; turnId?: string }>(port, 'agent.recap', { agentId: 'scratch' })
      expect(out.recap).toBeTruthy()
      // The turnId is what lets a client tell THIS turn's recap from the previous one's.
      expect(out.turnId).toBeTruthy()
    })
  })
})

describe('history', () => {
  const TURNS = 6 // → 12 events: user, assistant, user, assistant, …

  /** A transcript of `TURNS` complete turns, written where the provider looks for it. */
  function writeTranscript(): void {
    const dir = projectDir(PROJECTS, AGENT_CWD)
    mkdirSync(dir, { recursive: true })
    const lines: string[] = []
    for (let t = 0; t < TURNS; t++) {
      lines.push(JSON.stringify({
        type: 'user', uuid: `u${t}`, sessionId: CLAUDE_SESSION,
        timestamp: new Date(1_700_000_000_000 + t * 2000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `question ${t}` }] },
      }))
      lines.push(JSON.stringify({
        type: 'assistant', uuid: `a${t}`, sessionId: CLAUDE_SESSION,
        timestamp: new Date(1_700_000_000_000 + t * 2000 + 1000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: `answer ${t}` }] },
      }))
    }
    writeFileSync(join(dir, `${CLAUDE_SESSION}.jsonl`), `${lines.join('\n')}\n`)
  }

  /** A server whose store already knows this agent's Claude session — no turn needs to run. */
  async function withHistory<T>(fn: (port: number) => Promise<T>): Promise<T> {
    writeTranscript()
    return withServer(fakeClaude('claude-unused.sh', [resultLine()]), async (port, deps) => {
      deps.store.ensureAgent('scratch')
      deps.store.setClaudeSession('scratch', CLAUDE_SESSION)
      return fn(port)
    })
  }

  interface History { agentId: string; events: ProviderEvent[]; nextBefore?: string; truncated?: boolean }

  it('returns the agent’s WHOLE transcript when no window is asked for', async () => {
    const out = await withHistory((port) => rpc<History>(port, 'agent.history', { agentId: 'scratch' }))
    expect(out.events).toHaveLength(TURNS * 2)
    expect(out.events[0]).toMatchObject({ kind: 'user_message', text: 'question 0' })
    expect(out.events.at(-1)).toMatchObject({ kind: 'text_delta', text: 'answer 5' })
    // No `limit` asked → no cursor. Its absence is how a client tells a complete answer from a window.
    expect('nextBefore' in out).toBe(false)
  })

  it('windows to the NEWEST events and hands back a cursor', async () => {
    const out = await withHistory((port) => rpc<History>(port, 'agent.history', { agentId: 'scratch', limit: 4 }))
    expect(out.events).toHaveLength(4)
    expect(out.events[0]).toMatchObject({ text: 'question 4' })
    expect(out.nextBefore).toBeTruthy()
  })

  it('pages older with the cursor, without repeating the page already held', async () => {
    await withHistory(async (port) => {
      const first = await rpc<History>(port, 'agent.history', { agentId: 'scratch', limit: 4 })
      const older = await rpc<History>(port, 'agent.history', { agentId: 'scratch', limit: 4, before: first.nextBefore })
      expect(older.events).toHaveLength(4)
      expect(older.events.at(-1)).not.toEqual(first.events[0])
      expect(older.events[0]).toMatchObject({ text: 'question 2' })
    })
  })

  it('omits the cursor once the oldest event is in the window — otherwise paging never ends', async () => {
    const out = await withHistory((port) => rpc<History>(port, 'agent.history', { agentId: 'scratch', limit: 100 }))
    expect(out.events).toHaveLength(TURNS * 2)
    expect(out.nextBefore).toBeUndefined()
  })

  it('clamps an absurd limit rather than trusting the caller', async () => {
    const out = await withHistory((port) => rpc<History>(port, 'agent.history', { agentId: 'scratch', limit: 10_000 }))
    expect(out.events).toHaveLength(TURNS * 2)
  })

  it('refuses an unknown agent rather than answering empty', async () => {
    await withHistory(async (port) => {
      expect(await rpcError(port, 'agent.history', { agentId: 'ghost' })).toBe('not_found')
    })
  })

  it('an agent that has never run has an empty transcript, not an error', async () => {
    await withHistory(async (port) => {
      const out = await rpc<History>(port, 'agent.history', { agentId: 'agent-2' })
      expect(out.events).toEqual([])
    })
  })
})

describe('the method surface', () => {
  it('answers every method it defines — there are no optional ones to decline', async () => {
    await withServer(fakeClaude('claude-surface.sh', [resultLine()]), async (port) => {
      // Nothing is declared anywhere, so this list IS the surface. `agent.send` is exercised
      // throughout the file; the rest are checked here for "not refused outright".
      for (const method of ['agent.list', 'agent.history', 'turn.cancel', 'agent.recap']) {
        expect(await rpcError(port, method, { agentId: 'scratch', turnId: 't-surface' })).not.toBe('unsupported')
      }
    })
  })

  it('creates, renames and deletes agents, and refuses with a REASON rather than `unsupported`', async () => {
    await withServer(fakeClaude('claude-crud.sh', [resultLine()]), async (port) => {
      const created = await rpc<{ id: string; name: string }>(port, 'agent.create', { name: 'Made In A Test' })
      expect(created.id).toBe('made-in-a-test')
      // Addressable IMMEDIATELY: the list is read from config on every call, never snapshotted.
      expect(await rpcError(port, 'agent.history', { agentId: created.id })).toBe('(no error)')

      const renamed = await rpc<{ id: string; name: string }>(port, 'agent.rename', { agentId: created.id, name: 'Renamed' })
      expect(renamed).toMatchObject({ id: created.id, name: 'Renamed' })
      expect((await rpc<{ deleted: boolean }>(port, 'agent.delete', { agentId: created.id })).deleted).toBe(true)

      // A provider that cannot mutate says so with a message the UI shows the user. `unsupported`
      // would leave the product with a control it can neither use nor explain.
      expect(await rpcError(port, 'agent.rename', { agentId: 'ghost', name: 'x' })).toBe('invalid_request')
    })
  })

  it('rejects an unknown method', async () => {
    await withServer(fakeClaude('claude-cap3.sh', [resultLine()]), async (port) => {
      expect(await rpcError(port, 'nonsense.method', {})).toBe('unsupported')
    })
  })

  it('no longer answers the methods this revision removed', async () => {
    await withServer(fakeClaude('claude-gone.sh', [resultLine()]), async (port) => {
      // `workspace.*` and `voice.route` were unreachable from the product and are gone. If the web
      // ever grows a file browser they come back as new methods, not as re-enabled capabilities.
      for (const method of ['workspace.list', 'workspace.read', 'voice.route']) {
        expect(await rpcError(port, method, { agentId: 'scratch', transcript: 'hi' })).toBe('unsupported')
      }
    })
  })
})
