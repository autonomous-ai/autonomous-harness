import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionInputController } from './sessionInput.js'
import type { RegisteredSession } from './registry.js'

function session(engine: 'claude' | 'codex' | 'cursor' | 'commandcode' = 'codex'): RegisteredSession {
  return {
    sessionId: 's1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/s1.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

describe('SessionInputController', () => {
  afterEach(() => vi.useRealTimers())

  it('queues Codex prompts while busy and drains exactly one after turn end', async () => {
    const injected: string[] = []
    const controller = new SessionInputController({
      getSession: () => session(), validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true, onError: vi.fn(),
    })
    controller.setTurnOpen('s1', true)
    controller.submit('s1', 'second')
    controller.submit('s1', 'third')
    expect(injected).toEqual([])
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(injected).toEqual(['second']))
    controller.onTurnStarted('s1', 'second')
    controller.onTurnEnded('s1')
    await vi.waitFor(() => expect(injected).toEqual(['second', 'third']))
    controller.forget('s1')
  })

  it('clears the echoed prompt from the Cursor composer once the turn starts', async () => {
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async () => true, sendKey,
      capture: async () => '⠰ Working\n\n→ hello\nAuto',   // the submitted prompt is still on screen
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'hello')
    await vi.waitFor(() => expect(sendKey.mock.calls.filter(([, k]) => k === 'C-u')).toHaveLength(1))
    controller.forget('s1')
  })

  it('leaves a fresh terminal draft alone when the Cursor composer no longer echoes our prompt', async () => {
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async () => true, sendKey,
      capture: async () => '⠰ Working\n\n→ something the user just typed\nAuto',
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'hello')
    await new Promise((r) => setTimeout(r, 20))
    expect(sendKey.mock.calls.filter(([, k]) => k === 'C-u')).toHaveLength(0)
    controller.forget('s1')
  })

  it('clears the Cursor composer before pasting so a stale prompt cannot be appended to', async () => {
    // Cursor keeps the previous prompt on its "→" line after the turn finishes. Without a clear, the next
    // message is typed onto the end of it and the two are submitted as one run-on prompt — observed as a
    // turn starting with the PREVIOUS message's text.
    const order: string[] = []
    const controller = new SessionInputController({
      getSession: () => session('cursor'), validateRuntime: async () => true,
      inject: async (_pane, content) => { order.push(`inject:${content}`); return true },
      sendKey: async (_pane, key) => { order.push(`key:${key}`); return true },
      onError: vi.fn(),
    })
    controller.submit('s1', 'second question')
    await vi.waitFor(() => expect(order).toContain('inject:second question'))
    expect(order[0]).toBe('key:C-u')
    expect(order[1]).toBe('inject:second question')
    controller.forget('s1')
  })

  it('retries Enter without reinjecting the prompt body', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({
      getSession: () => session(), validateRuntime: async () => true, inject, sendKey, onError: vi.fn(),
    })
    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(sendKey).toHaveBeenCalledTimes(2)
    controller.forget('s1')
  })

  it('waits longer before retrying Claude submit verification', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async () => true)
    const controller = new SessionInputController({
      getSession: () => session('claude'), validateRuntime: async () => true, inject, sendKey, onError: vi.fn(),
    })
    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(2_900)
    expect(sendKey).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(sendKey).toHaveBeenCalledTimes(1)
    controller.forget('s1')
  })

  it('does not retry Enter for Cursor after the TUI is already working', async () => {
    vi.useFakeTimers()
    const inject = vi.fn(async () => true)
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject,
      sendKey,
      capture: async () => '⠰ Working\n\n→ hello\nAuto',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(5_100)

    expect(inject).toHaveBeenCalledTimes(1)
    // Assert on ENTER specifically, not on the total key count: every Cursor injection also sends a
    // C-u first to clear a stale composer, and that is not a retry.
    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('retries Enter for Cursor only while the exact draft remains in an idle composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async (_pane: string, _key: string) => true)
    const controller = new SessionInputController({
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '→ hello\n\nAuto',
      onError: vi.fn(),
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600)

    // One retry ENTER. The C-u that precedes every Cursor paste is not counted here.
    expect(sendKey.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1)
    controller.forget('s1')
  })

  it('waits for the Cursor composer to settle before draining the next prompt', async () => {
    vi.useFakeTimers()
    const injected: string[] = []
    const controller = new SessionInputController({
      getSession: () => session('cursor'),
      validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true,
      onError: vi.fn(),
    })

    controller.onTurnStarted('s1', 'first')
    controller.onTurnEnded('s1')
    controller.submit('s1', 'second')
    await vi.advanceTimersByTimeAsync(700)
    expect(injected).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(injected).toEqual(['second'])
    controller.forget('s1')
  })

  it('does not error or press Enter for Claude once the prompt has left the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('claude'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '❯ \n✻ Working (esc to interrupt)',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(3_100 * 4)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('accepts a Command Code prompt the moment its pane says the agent is working', async () => {
    // Command Code writes the user line to its transcript only after the model finishes thinking — 30s on
    // a real task — so waiting for turn_started declared "the agent did not accept this message" while the
    // terminal plainly showed the message accepted and the work under way.
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('commandcode'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      // Its real pane: the composer back to its placeholder, the turn running above it.
      capture: async () => '❯ build me a game\n✧ Sculpting…  esc to interrupt • 59s\n────\n❯ Ask your question...',
      onError,
    })

    controller.submit('s1', 'build me a game')
    await vi.advanceTimersByTimeAsync(6_100 * 6)

    expect(onError).not.toHaveBeenCalled()
    expect(sendKey).not.toHaveBeenCalled()   // and no stray Enter into a live composer
    controller.forget('s1')
  })

  it('retries Enter then errors for Claude while the prompt stays in the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('claude'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '❯ hello',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(3_100 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  it('does not error or press Enter for Codex once the prompt has left the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '› Find and fix a bug in @filename\n  gpt-5.5 medium ·',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 4)

    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    controller.forget('s1')
  })

  it('retries Enter then errors for Codex while the prompt stays in the composer', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      capture: async () => '› hello',
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  it('falls back to blind retry/error when no pane capture is available', async () => {
    vi.useFakeTimers()
    const sendKey = vi.fn(async () => true)
    const onError = vi.fn()
    const controller = new SessionInputController({
      getSession: () => session('codex'),
      validateRuntime: async () => true,
      inject: async () => true,
      sendKey,
      onError,
    })

    controller.submit('s1', 'hello')
    await vi.advanceTimersByTimeAsync(1_600 * 3)

    expect(sendKey).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
    controller.forget('s1')
  })

  it('serializes chat input behind a native runtime control lock', async () => {
    const injected: string[] = []
    const controller = new SessionInputController({
      getSession: () => session('claude'), validateRuntime: async () => true,
      inject: async (_pane, content) => { injected.push(content); return true },
      sendKey: async () => true, onError: vi.fn(),
    })

    const release = controller.acquireControl('s1')
    expect(release).toBeTypeOf('function')
    expect(controller.acquireControl('s1')).toBeNull()
    controller.submit('s1', 'wait behind control')
    expect(injected).toEqual([])

    release?.()
    await vi.waitFor(() => expect(injected).toEqual(['wait behind control']))
    controller.forget('s1')
  })
})
