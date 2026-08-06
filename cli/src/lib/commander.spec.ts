import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommanderMirror, type CommanderFrame } from './commander.js'
import type { LiveEvent } from './normalize.js'

let dataDir = ''

describe('CommanderMirror recap events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-commander-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('fans a TodoWrite out to the device as a todo list, whatever engine produced it', () => {
    // The device renders the checklist from `todos:[{c,s}]` folded onto a processing frame — nothing else
    // carries it. Every engine reaches this through the SAME shape (`input.todos[{content,status}]`), which
    // is why an engine whose planning tool is named differently silently loses its checklist: hermes calls
    // its tool `todo`, and until that was mapped the device showed no list at all for it.
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'plan it' } },
      {
        type: 'tool_start',
        payload: {
          id: 't1',
          tool: 'TodoWrite',
          input: { todos: [
            { content: 'In hello', status: 'completed' },
            { content: 'In world', status: 'in_progress' },
            { content: 'Tổng kết', status: 'pending' },
          ] },
        },
      },
    ] as LiveEvent[], 'session-todos')

    const withTodos = deviceFrames.filter((f) => Array.isArray((f.payload as { todos?: unknown }).todos))
    expect(withTodos).toHaveLength(1)
    expect((withTodos[0].payload as { todos: Array<{ c: string; s: string }> }).todos).toEqual([
      { c: 'In hello', s: 'completed' },
      { c: 'In world', s: 'in_progress' },
      { c: 'Tổng kết', s: 'pending' },
    ])
  })

  it('keeps the todo list on the busy tile through the heartbeat', () => {
    // The device clears a busy tile on a watchdog; the 5s heartbeat has to re-assert the SAME list or the
    // checklist would vanish mid-turn while the agent is still working on it.
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'plan it' } },
      { type: 'tool_start', payload: { id: 't1', tool: 'TodoWrite', input: { todos: [{ content: 'A', status: 'pending' }] } } },
    ] as LiveEvent[], 'session-hb')

    deviceFrames.length = 0
    expect(mirror.heartbeat('session-hb')).toBe(true)
    expect(deviceFrames.some((f) => Array.isArray((f.payload as { todos?: unknown }).todos))).toBe(true)
  })

  it('feeds the device its sub-agent list, running then finished', () => {
    // The firmware has always been able to draw this list (ui_project_set_agents) and never received one:
    // nothing in the adapter, the node or the backend emitted `kind:'agents'`, for any engine. It renders
    // each row verbatim, so the text and colour are decided here — `›` while running (the device scrolls
    // that row into view), `✓ … · Ns` once done.
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'delegate it' } },
      { type: 'tool_start', payload: { id: 'a1', tool: 'Task', input: { description: 'audit the parser' } } },
      // claude's own tool is named `Agent`, not `Task` — both must open a row (measured on a live turn).
      { type: 'tool_start', payload: { id: 'a2', tool: 'Agent', input: { description: 'write the tests' } } },
    ] as LiveEvent[], 'session-agents')

    const rowsOf = (): Array<{ text: string; color: string }> => {
      const last = deviceFrames.filter((f) => f.payload.kind === 'agents').pop()
      return (last?.payload.agents ?? []) as Array<{ text: string; color: string }>
    }
    expect(rowsOf().map((r) => r.text)).toEqual(['› audit the parser', '› write the tests'])

    mirror.ingest([
      { type: 'tool_end', payload: { id: 'a1', tool: 'Task', output: 'ok', isError: false, summary: 'done', durationSeconds: 12 } },
    ] as LiveEvent[], 'session-agents')

    expect(rowsOf().map((r) => r.text)).toEqual(['✓ audit the parser · 12s', '› write the tests'])
    expect(rowsOf()[0].color).not.toBe(rowsOf()[1].color)   // finished and running must be tellable apart
  })

  it('carries a still-RUNNING sub-agent into the next turn and drops the finished ones', () => {
    // Finished rows must not sit above "Working…" on the next turn — but a running one is not finished
    // just because the user typed again: claude's async sub-agents outlive the turn that spawned them,
    // and cursor announces a Task through its HOOK ~60ms BEFORE the turn opens (measured live).
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'one' } },
      { type: 'tool_start', payload: { id: 'a1', tool: 'Task', input: { description: 'first' } } },
      { type: 'tool_end', payload: { id: 'a1', tool: 'Task', output: 'done', isError: false, summary: '' } },
      { type: 'tool_start', payload: { id: 'a2', tool: 'Task', input: { description: 'still going' } } },
      { type: 'turn_started', payload: { userMessage: 'two' } },
      { type: 'tool_start', payload: { id: 'b1', tool: 'Task', input: { description: 'second' } } },
    ] as LiveEvent[], 'session-agents-2')

    const last = deviceFrames.filter((f) => f.payload.kind === 'agents').pop()
    expect((last?.payload.agents as Array<{ text: string }>).map((r) => r.text)).toEqual(['› still going', '› second'])
  })

  it('emits done before summary when recap succeeds', async () => {
    const deviceFrames: CommanderFrame[] = []
    const webFrames: Record<string, unknown>[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: (frame) => webFrames.push(frame),
      hasDevice: () => true,
      summarize: async () => 'Short recap\n\nLong body',
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'what happened?' } },
      { type: 'text_delta', payload: { content: 'The assistant answered.' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'session-1')

    await vi.runAllTimersAsync()
    await Promise.resolve()

    expect(deviceFrames.map((f) => f.payload.kind)).toEqual([
      'processing',
      'processing',
      'done',
      'summary',
    ])
    expect(deviceFrames.at(-1)?.payload).toEqual({ kind: 'summary', text: 'Long body', recap: 'Short recap' })
    expect(webFrames.map((f) => f.type)).toEqual(['turn_summary_pending', 'turn_summary'])
  })

  it('runs the recap once when a turn closes twice (Stop hook + watcher race)', async () => {
    const deviceFrames: CommanderFrame[] = []
    let summarizeCalls = 0
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => { summarizeCalls++; return 'Recap\n\nBody' },
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'who won?' } },
      { type: 'text_delta', payload: { content: 'Spain won.' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'session-race')
    // Second turn_ended for the SAME turn (the other of hook/watcher) — must NOT start a second recap.
    mirror.ingest([{ type: 'turn_ended', payload: {} }] as LiveEvent[], 'session-race')

    await vi.runAllTimersAsync()
    await Promise.resolve()

    expect(summarizeCalls).toBe(1)
    expect(deviceFrames.filter((f) => f.payload.kind === 'summary')).toHaveLength(1)
  })

  it('renders normalized Codex Task and child tools through the same device cards as Claude', () => {
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })

    mirror.ingest([
      {
        type: 'tool_start',
        payload: {
          id: 'task-1',
          tool: 'Task',
          input: { subagent_type: 'explorer', description: 'Inspect the API' },
        },
      },
      {
        type: 'tool_start',
        payload: {
          id: 'child-1',
          tool: 'Bash',
          input: { command: 'rg TODO' },
          parentToolUseId: 'task-1',
        },
      },
    ], 'session-codex')

    expect(deviceFrames.map((frame) => frame.payload)).toEqual([
      {
        kind: 'tool',
        text: 'Task',
        recap: 'Inspect the API',
        color: '#d19a66',
        detail: 'subagent_type: explorer · description: Inspect the API',
      },
      // …and the same Task also opens a row in the device's sub-agent list, which is a separate surface
      // from the tool card: the card scrolls away with the feed, the list stays above "Working…".
      { kind: 'agents', agents: [{ text: '› Inspect the API', color: '#ff9d00' }] },
      {
        kind: 'tool',
        text: 'Bash',
        recap: 'rg TODO',
        color: '#e5c07b',
        detail: 'command: rg TODO',
      },
    ])
  })

  it('heartbeat re-emits processing while a turn is open, nothing when idle', () => {
    const deviceFrames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      dataDir,
    })

    // No such session → idle, emits nothing.
    expect(mirror.heartbeat('nope')).toBe(false)

    mirror.ingest([{ type: 'turn_started', payload: { userMessage: 'hi' } }] as LiveEvent[], 'session-hb')
    deviceFrames.length = 0 // drop the turn_started processing frame

    // Turn open → heartbeat re-asserts Processing and reports busy.
    expect(mirror.heartbeat('session-hb')).toBe(true)
    expect(deviceFrames).toEqual([{ type: 'commander_event', agentId: 'session-hb', dbSessionId: 'session-hb', payload: { kind: 'processing', text: 'Processing' } }])
  })

  it('heartbeat re-emits "Summarizing…" during the summarize window', async () => {
    const deviceFrames: CommanderFrame[] = []
    let releaseSummarize: (v: string) => void = () => {}
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: () => new Promise<string>((resolve) => { releaseSummarize = resolve }), // hangs until released
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'q' } },
      { type: 'text_delta', payload: { content: 'answer' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'session-sum')
    await Promise.resolve() // let onTurnEnded kick off the (hanging) summarize → summarizing=true
    deviceFrames.length = 0

    // Turn closed but summarize in flight → heartbeat re-asserts Summarizing… and still reports busy.
    expect(mirror.heartbeat('session-sum')).toBe(true)
    expect(deviceFrames.map((f) => f.payload)).toEqual([{ kind: 'processing', text: 'Summarizing…' }])

    releaseSummarize('recap\n\nbody')
    await vi.runAllTimersAsync()
    await Promise.resolve()

    // Summary done → idle → heartbeat emits nothing and reports not busy.
    deviceFrames.length = 0
    expect(mirror.heartbeat('session-sum')).toBe(false)
    expect(deviceFrames).toEqual([])
  })

  it('says so in the log when a turn closes that was never opened', async () => {
    // The real failure this guards: a first prompt landing while the session is being attached has
    // its turn_started folded into history, so the live turn's close arrives with turnOpen false.
    // That used to return in silence — a whole turn produced no recap and no trace of why.
    const errors: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)) })
    const deviceFrames: CommanderFrame[] = []
    let summarizeCalls = 0
    const mirror = new CommanderMirror({
      send: (frame) => deviceFrames.push(frame),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => { summarizeCalls++; return 'Recap\n\nBody' },
      dataDir,
    })

    mirror.ingest([{ type: 'turn_ended', payload: {} }] as LiveEvent[], 'session-orphan')
    await vi.runAllTimersAsync()

    expect(summarizeCalls).toBe(0)
    expect(deviceFrames).toEqual([])
    expect(errors.join('\n')).toContain('turn-end · DROPPED')
    error.mockRestore()
  })

  it('stays silent for the ordinary duplicate close', async () => {
    // Every turn closes twice (watcher + Stop hook). That path must not start logging.
    const errors: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errors.push(String(line)) })
    const mirror = new CommanderMirror({
      send: () => {},
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => 'Recap\n\nBody',
      dataDir,
    })

    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'q' } },
      { type: 'text_delta', payload: { content: 'answer' } },
      { type: 'turn_ended', payload: {} },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'session-dup')
    await vi.runAllTimersAsync()

    expect(errors.join('\n')).not.toContain('DROPPED')
    error.mockRestore()
  })
})

describe('device frames address the agent, not the session', () => {
  beforeEach(() => { vi.useFakeTimers(); dataDir = mkdtempSync(join(tmpdir(), 'adapter-commander-id-')) })
  afterEach(() => { vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }) })

  it('sends agentId = the agent and dbSessionId = the engine session', () => {
    // These two are different values now. The device routes tiles by `agentId` (stable across a `/clear`)
    // and keeps `dbSessionId` to echo back when cancelling a turn; the backend also keys its voice queue
    // on dbSessionId, so it must stay the engine session id.
    const frames: CommanderFrame[] = []
    const mirror = new CommanderMirror({
      send: (f) => frames.push(f),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize: async () => null,
      agentIdFor: (sessionId) => (sessionId === 'engine-session' ? 'agent-uuid' : undefined),
      dataDir,
    })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'go' } },
    ] as LiveEvent[], 'engine-session')

    expect(frames[0]).toMatchObject({ agentId: 'agent-uuid', dbSessionId: 'engine-session' })
  })
})
