import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { CommanderMirror, type CommanderFrame } from './commander.js'
import { lineToEvents, newTurnState, type LiveEvent } from './normalize.js'

/**
 * One REAL claude turn that spawned three ASYNC sub-agents ("Chạy 3 sub-agent SONG SONG…"), replayed
 * through the same two stages the daemon uses: `lineToEvents` → `CommanderMirror.ingest`.
 *
 * What made this worth a fixture: claude answers the `Agent` tool_use in ~4ms with "Async agent launched
 * successfully." and then ENDS the turn — the three sub-agents are still working. Taking either of those
 * at face value showed the user a finished tile and a recap of the launch message ("đã spawn 3 sub-agent"),
 * while the answer they actually asked for landed minutes later with nothing left on screen to show it.
 */
function transcript(): string[] {
  const p = fileURLToPath(new URL('./__fixtures__/transcript-async-subagents.jsonl', import.meta.url))
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim())
}

function events(): LiveEvent[] {
  const state = newTurnState()
  return transcript().flatMap((line) => lineToEvents(line, state))
}

let dataDir = ''

describe('async sub-agents (real claude transcript)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-subagent-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('turns each task-notification into one subagent_finished keyed by its tool-use id', () => {
    const finished = events().filter((e) => e.type === 'subagent_finished')
    expect(finished).toHaveLength(3)
    const spawned = events().filter((e) => e.type === 'tool_start' && e.payload.tool === 'Agent')
    expect(spawned).toHaveLength(3)
    // Ids must PAIR with the spawning tool_use — that is what lets the list tick off the right row.
    expect(new Set(finished.map((e) => (e as { payload: { id: string } }).payload.id)))
      .toEqual(new Set(spawned.map((e) => (e as { payload: { id: string } }).payload.id)))
    for (const e of finished) expect((e as { payload: { status: string } }).payload.status).toBe('completed')
  })

  it('a task-notification is not a prompt: exactly one turn, and it is the user\'s', () => {
    const starts = events().filter((e) => e.type === 'turn_started')
    expect(starts).toHaveLength(1)
    expect((starts[0] as { payload: { userMessage: string } }).payload.userMessage).toContain('SONG SONG')
  })

  function replay(): { frames: CommanderFrame[]; summarize: ReturnType<typeof vi.fn> } {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async (text: string) => `recap\n\n${text.slice(0, 40)}`)
    const mirror = new CommanderMirror({
      send: (f) => frames.push(f),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize,
      dataDir,
    })
    const state = newTurnState()
    for (const line of transcript()) mirror.ingest(lineToEvents(line, state), 'sess-async')
    return { frames, summarize }
  }

  const agentFrames = (frames: CommanderFrame[]) =>
    frames.filter((f) => (f.payload as { kind?: string }).kind === 'agents')
      .map((f) => (f.payload as { agents: Array<{ text: string }> }).agents.map((a) => a.text))

  it('never ticks a sub-agent off on its launch ack', () => {
    const { frames } = replay()
    // Three spawns + three finishes = six list pushes (this turn started with no list to clear).
    const live = agentFrames(frames)
    expect(live).toHaveLength(6)
    // After the third spawn every row is still running: a `✓` there would be the launch-ack bug.
    expect(live[2]).toHaveLength(3)
    expect(live[2].every((t) => t.startsWith('›'))).toBe(true)
    expect(live[5].every((t) => t.startsWith('✓'))).toBe(true)
  })

  it('holds the recap until the last sub-agent reports in, then recaps the FINISHED answer', async () => {
    const { frames, summarize } = replay()
    // The parent turn already ended in the transcript — nothing may have been summarized yet.
    expect(summarize).not.toHaveBeenCalled()
    expect(frames.some((f) => (f.payload as { kind?: string }).kind === 'summary')).toBe(false)

    await vi.advanceTimersByTimeAsync(13_000) // backstop window after the last finish
    expect(summarize).toHaveBeenCalledTimes(1)
    const text = summarize.mock.calls[0][0] as string
    expect(text).toContain('Cả 3 sub-agent đã hoàn thành') // the wrap-up, not the launch message
  })

  it('a cancel while sub-agents run drops the held recap instead of firing it later', async () => {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async () => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    const state = newTurnState()
    for (const line of transcript()) {
      const evs = lineToEvents(line, state)
      // Cut the replay off at the turn-end that the sub-agents are holding open.
      mirror.ingest(evs, 'sess-cancel')
      if (evs.some((e) => e.type === 'turn_ended')) break
    }
    mirror.cancel('sess-cancel')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('keeps a sub-agent announced just BEFORE its turn opened (cursor hook ordering)', () => {
    // Measured live: cursor's tool-start hook reached the mirror at 10:20:36.799 and its transcript-derived
    // turn_started at 10:20:36.862 — 63ms later. A blanket reset on turn_started deleted the first Task, so
    // two parallel sub-agents showed as one row and the held turn-end released a sub-agent early.
    const frames: CommanderFrame[] = []
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize: async () => null, dataDir })
    mirror.ingest([
      { type: 'tool_start', payload: { id: 'task-a', tool: 'Task', input: { description: 'SJC gold price today' } } },
      { type: 'turn_started', payload: { userMessage: 'two sub-agents' } },
      { type: 'tool_start', payload: { id: 'task-b', tool: 'Task', input: { description: 'USD/VND rate today' } } },
    ] as LiveEvent[], 'sess-order')
    const lists = agentFrames(frames)
    expect(lists[lists.length - 1]).toHaveLength(2)
  })

  it('does not let LAST turn\'s sub-agent hold THIS turn\'s recap', async () => {
    // The row survives the turn boundary so the device keeps showing it — but an agent spawned two
    // prompts ago must not park the answer to the question just asked (worst case: the 10-minute
    // backstop, with nothing on screen to explain the wait).
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async (_text: string) => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'spawn one' } },
      { type: 'tool_start', payload: { id: 'toolu_slow', tool: 'Agent', input: { description: 'still running' } } },
      { type: 'tool_end', payload: { id: 'toolu_slow', tool: 'Agent', output: 'Async agent launched successfully.', isError: false, summary: '' } },
      { type: 'turn_ended', payload: {} },
      // …the user moves on to something unrelated while it runs.
      { type: 'turn_started', payload: { userMessage: 'what time is it?' } },
      { type: 'text_delta', payload: { content: 'It is 11:00.' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'sess-carry')

    await vi.advanceTimersByTimeAsync(100)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][0]).toContain('It is 11:00.')
    // and the carried row is still on the device's list, still marked running
    const last = frames.filter((f) => (f.payload as { kind?: string }).kind === 'agents').at(-1)
    expect((last?.payload as { agents: Array<{ text: string }> }).agents.map((a) => a.text)).toEqual(['› still running'])
  })

  it('releases the turn-end anyway if a sub-agent never reports back', async () => {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async () => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'spawn one' } },
      { type: 'tool_start', payload: { id: 'toolu_x', tool: 'Agent', input: { description: 'never returns' } } },
      { type: 'tool_end', payload: { id: 'toolu_x', tool: 'Agent', output: 'Async agent launched successfully.', isError: false, summary: '' } },
      { type: 'text_delta', payload: { content: 'launched it' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'sess-stuck')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(summarize).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(summarize).toHaveBeenCalledTimes(1)
  })
})
