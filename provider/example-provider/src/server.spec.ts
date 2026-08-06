/**
 * The wire, end to end: a real HTTP server, a fake `claude`, and a transcript on disk.
 *
 * Two things are pinned here that nothing else can pin:
 *   - **HP-212** — the recap rides the turn's OWN stream, immediately before the terminal event. Its
 *     position is the whole point: a recap that arrives after the stream closes cannot say which turn
 *     it belongs to.
 *   - **HP-304** — paging a context. The windows are asserted with exact indices, because the
 *     turn-snapping rule (a page may be LONGER than `limit`) is easy to "fix" into a plain slice and
 *     only a concrete expectation notices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createProviderServer } from './server.js'
import { projectDir } from './jsonl.js'
import type { Config } from './config.js'
import type { Message, Part } from './types.js'

const ROOT = join(tmpdir(), `example-provider-spec-${process.pid}`)
const AGENT_CWD = join(ROOT, 'agent')
const PROJECTS = join(ROOT, 'projects')
const CLAUDE_SESSION = 'sess-1'

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

function config(claudeBin: string): Config {
  return {
    agents: [{ id: 'scratch', name: 'Scratch', description: 'test agent', cwd: AGENT_CWD }],
    workspaceRoot: ROOT,
    agentsFile: join(ROOT, 'agents.json'),
    claudeBin,
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

interface SseEvent {
  taskId?: string
  contextId?: string
  status?: { state?: string; message?: Message }
  final?: boolean
}

/** Boot, run one request against it, shut down. Port 0 so tests never collide. */
async function withServer<T>(claudeBin: string, fn: (port: number, deps: ReturnType<typeof createProviderServer>['deps']) => Promise<T>): Promise<T> {
  const { server, deps } = createProviderServer(config(claudeBin))
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
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: unknown }
  if (body.error) throw new Error(`rpc ${method} failed: ${JSON.stringify(body.error)}`)
  return body.result as T
}

/** Run a turn and collect every SSE event, in order. */
async function runTurn(port: number, text: string, contextId?: string): Promise<SseEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendStreamingMessage',
      params: { message: { role: 'ROLE_USER', messageId: 'm1', parts: [{ text }], ...(contextId ? { contextId } : {}) } },
    }),
  })
  const raw = await res.text()
  return raw
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5).trim()) as SseEvent)
}

const kindsOf = (ev: SseEvent): string[] =>
  (ev.status?.message?.parts ?? []).map((p: Part) => p.metadata?.['autonomous.ai/kind'] ?? '')

beforeAll(() => {
  mkdirSync(AGENT_CWD, { recursive: true })
  mkdirSync(PROJECTS, { recursive: true })
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('SendStreamingMessage — the recap rides the stream (HP-212)', () => {
  it('brackets the wait with recap_start/recap_end, then ends terminal', async () => {
    const bin = fakeClaude('claude-ok.sh', [textLine('Acme is at 118% of pacing. Nothing else changed.'), resultLine()])
    const events = await withServer(bin, (port) => runTurn(port, 'how is acme pacing?'))

    // The order IS the contract: start announces a wait the client cannot otherwise see, end closes
    // it, and the terminal event comes last so HP-102 still reads a terminal state at the tail.
    const kinds = events.flatMap(kindsOf)
    expect(kinds.filter((k) => k === 'recap_start')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'recap_end')).toHaveLength(1)
    expect(events.findIndex((e) => kindsOf(e).includes('recap_start'))).toBe(events.length - 3)
    expect(events.findIndex((e) => kindsOf(e).includes('recap_end'))).toBe(events.length - 2)

    const last = events.at(-1)!
    expect(last.status?.state).toBe('TASK_STATE_COMPLETED')
    expect(last.final).toBe(true)

    const end = events.at(-2)!
    expect(end.status?.state).toBe('TASK_STATE_WORKING') // must not end the turn twice
    const part = end.status!.message!.parts[0]!
    expect(part.metadata?.['autonomous.ai/recap']).toBe('Acme is at 118% of pacing.')
    expect(part.text).toContain('Nothing else changed.')
  })

  it('gives a FAILED turn neither half — a headline would read like an accomplishment', async () => {
    const bin = fakeClaude('claude-fail.sh', [textLine('Started, then hit an error.'), resultLine(true)])
    const events = await withServer(bin, (port) => runTurn(port, 'do the thing'))

    const kinds = events.flatMap(kindsOf)
    expect(kinds).not.toContain('recap_start')
    expect(kinds).not.toContain('recap_end')
    expect(events.at(-1)?.status?.state).toBe('TASK_STATE_FAILED')
    expect(events.at(-1)?.final).toBe(true)
  })

  it('closes the indicator even when a silent turn produces no headline', async () => {
    const bin = fakeClaude('claude-silent.sh', [resultLine()])
    const events = await withServer(bin, (port) => runTurn(port, 'be quiet'))

    // A `recap_start` without its `recap_end` leaves the client spinning forever, so the end must be
    // there — carrying no headline, which is how it says "nothing to show".
    const kinds = events.flatMap(kindsOf)
    expect(kinds).toContain('recap_start')
    expect(kinds).toContain('recap_end')
    expect(events.at(-2)!.status!.message!.parts[0]!.metadata?.['autonomous.ai/recap']).toBeUndefined()
    expect(events.at(-1)?.status?.state).toBe('TASK_STATE_COMPLETED')
  })

  it('still persists the recap, so GetRecap keeps working for a device with no stream', async () => {
    const bin = fakeClaude('claude-persist.sh', [textLine('Shipped the pacing alert. Details follow.'), resultLine()])
    const entries = await withServer(bin, async (port) => {
      await runTurn(port, 'ship it')
      const out = await rpc<{ entries: Array<{ recap: string; taskId?: string }> }>(port, 'autonomous.GetRecap', { agentId: 'scratch', n: 2 })
      return out.entries
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.recap).toBe('Shipped the pacing alert.')
    // The pull carries the taskId, which is what lets a client tell THIS turn's recap from the last one.
    expect(entries[0]!.taskId).toBeTruthy()
  })
})

describe('autonomous.GetContextHistory — a whole context, paged (HP-304)', () => {
  const CONTEXT = 'ctx-history'
  const TURNS = 6 // → 12 messages: user, assistant, user, assistant, …

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

  /** A server whose store already knows this context — no turn needs to run. */
  async function withHistory<T>(fn: (port: number) => Promise<T>): Promise<T> {
    writeTranscript()
    return withServer(fakeClaude('claude-unused.sh', [resultLine()]), async (port, deps) => {
      deps.store.ensureContext(CONTEXT, 'scratch')
      deps.store.setClaudeSession(CONTEXT, CLAUDE_SESSION)
      return fn(port)
    })
  }

  interface HistoryResult {
    contextId: string
    messages: Message[]
    hasMore?: boolean
    oldestCursor?: string | null
    staleCursor?: boolean
  }

  it('returns the WHOLE context — many turns, not the one GetTask would give', async () => {
    const out = await withHistory((port) => rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT }))
    expect(out.messages).toHaveLength(TURNS * 2)
    expect(out.messages[0]!.messageId).toBe('u0')
    expect(out.messages.at(-1)!.messageId).toBe('a5')
    // No `limit` asked → the paging fields must be ABSENT, not false. Their absence is how a client
    // tells a complete answer from a windowed one.
    expect('hasMore' in out).toBe(false)
    expect('oldestCursor' in out).toBe(false)
  })

  it('windows to the NEWEST messages and snaps the edge back to a turn start', async () => {
    const out = await withHistory((port) =>
      rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT, limit: 3 }))
    // limit 3 lands mid-turn at index 9 (an assistant reply); snapping back to index 8 makes the
    // window 4 long. Longer than asked, and deliberately so — see HP-304.
    expect(out.messages.map((m) => m.messageId)).toEqual(['u4', 'a4', 'u5', 'a5'])
    expect(out.hasMore).toBe(true)
    expect(out.oldestCursor).toBe('u4')
  })

  it('pages older with `before`, without overlapping the page already held', async () => {
    const out = await withHistory((port) =>
      rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT, limit: 3, before: 'u4' }))
    expect(out.messages.map((m) => m.messageId)).toEqual(['u2', 'a2', 'u3', 'a3'])
    expect(out.hasMore).toBe(true)
    expect(out.oldestCursor).toBe('u2')
  })

  it('reports no further pages once the oldest turn is in the window', async () => {
    const out = await withHistory((port) =>
      rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT, limit: 3, before: 'u2' }))
    expect(out.messages.map((m) => m.messageId)).toEqual(['u0', 'a0', 'u1', 'a1'])
    expect(out.hasMore).toBe(false)
    expect(out.oldestCursor).toBe('u0')
  })

  it('flags a cursor that is no longer in the transcript instead of erroring', async () => {
    const out = await withHistory((port) =>
      rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT, limit: 3, before: 'compacted-away' }))
    expect(out.staleCursor).toBe(true)
    expect(out.messages).toEqual([])
    expect(out.hasMore).toBe(false)
    expect(out.oldestCursor).toBeNull()
  })

  it('clamps an absurd limit rather than trusting the caller', async () => {
    const out = await withHistory((port) =>
      rpc<HistoryResult>(port, 'autonomous.GetContextHistory', { contextId: CONTEXT, limit: 10_000 }))
    expect(out.messages).toHaveLength(TURNS * 2)
    expect(out.hasMore).toBe(false)
  })

  it('refuses an unknown context rather than guessing one', async () => {
    await expect(withHistory((port) =>
      rpc(port, 'autonomous.GetContextHistory', { contextId: 'ctx-nope' }))).rejects.toThrow(/-32602|Invalid params/)
  })
})
