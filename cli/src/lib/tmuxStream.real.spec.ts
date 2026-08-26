import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { TerminalStreamManager } from './terminalStreamManager.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { TmuxControlStream } from './tmuxStream.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'

const run = process.env.RUN_REAL_TMUX_STREAM === '1' ? describe : describe.skip

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 3_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await predicate()).toBe(true)
}

run('TmuxControlStream real tmux', () => {
  const session = `harness-stream-${randomUUID().slice(0, 8)}`
  let paneId = ''

  beforeAll(async () => {
    paneId = await tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, 'bash', '--noprofile', '--norc'])
  })

  afterAll(async () => {
    await tmux(['kill-session', '-t', session]).catch(() => { /* exact disposable session only */ })
  })

  it('captures, streams raw output, accepts input, and resizes one-pane windows', async () => {
    const chunks: Buffer[] = []
    let closedReason = ''
    const opened = await TmuxControlStream.open(paneId, { cols: 96, rows: 28 }, {
      onData: (bytes) => chunks.push(Buffer.from(bytes)),
      onClose: (reason) => { closedReason = reason },
    })
    expect(opened.state).toBe('succeeded')
    if (opened.state !== 'succeeded') return

    const historyMarker = 'HARNESS_OLD_TUI_FRAME_MUST_NOT_REPLAY'
    const styledHistoryMarker = 'HARNESS_STYLED_HISTORY'
    const snapshotMarker = 'HARNESS_SNAPSHOT_OK'
    await opened.value.writeRaw(Buffer.from(
      `printf '\\033[31m${styledHistoryMarker}\\033[0m\\n${historyMarker}\\n'; for i in {1..40}; do printf 'filler-%s\\n' "$i"; done; printf '${snapshotMarker}\\n'\r`,
    ))
    await eventually(async () => (await tmux(['capture-pane', '-p', '-t', paneId])).includes(snapshotMarker))
    opened.value.beginSnapshot()
    const snapshot = await opened.value.snapshot()
    expect(snapshot.state).toBe('succeeded')
    if (snapshot.state === 'succeeded') {
      expect(snapshot.value.cols).toBe(96)
      expect(snapshot.value.rows).toBe(28)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from('\u001bc'))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(snapshotMarker))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(historyMarker))).toBe(true)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from(`\u001b[31m${styledHistoryMarker}`))).toBe(true)
    }

    const postCutMarker = 'HARNESS_POST_CUT_OK'
    await opened.value.writeRaw(Buffer.from(`printf '${postCutMarker}\\n'\r`))
    await eventually(async () => (await tmux(['capture-pane', '-p', '-t', paneId])).includes(postCutMarker))
    expect(Buffer.concat(chunks).includes(Buffer.from(postCutMarker))).toBe(false)
    opened.value.endSnapshot()
    await eventually(() => Buffer.concat(chunks).includes(Buffer.from(postCutMarker)))

    await opened.value.writeRaw(Buffer.from("printf 'HARNESS_STREAM_OK\\n'\r"))
    const deadline = Date.now() + 3_000
    while (!Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK'))).toBe(true)

    expect((await opened.value.resize({ cols: 110, rows: 35 })).state).toBe('succeeded')
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('110x35')
    await opened.value.close()
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('110x35')
    expect(closedReason === '' || closedReason === 'closed').toBe(true)
  })

  it('runs every catalog engine through the same manager and real tmux stream', async () => {
    for (const [index, engine] of ENGINES.entries()) {
      const agentId = `real-tmux-${engine}`
      const registered = {
        agentId,
        sessionId: `session-${engine}`,
        engine,
        active: true,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        runtimes: [{ backend: 'tmux', paneId }],
        primaryRuntimeKey: `tmux:default:${paneId}`,
      } as unknown as RegisteredSession
      const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
      const binaryFrames: TerminalBinaryClear[] = []
      const terminals = {
        openStream: async (_session: RegisteredSession, size: { cols: number; rows: number }, sink: Parameters<typeof TmuxControlStream.open>[2]) =>
          TmuxControlStream.open(paneId, size, sink),
      } as unknown as TerminalBackendCoordinator
      const manager = new TerminalStreamManager({
        terminals,
        resolveAgent: (candidate) => candidate === agentId ? registered : undefined,
        sendTarget: (_connId, type, payload) => { frames.push({ type, payload }); return true },
        sendBinaryTarget: (_connId, frame) => { binaryFrames.push(frame); return true },
        streamingAvailable: true,
      })

      try {
        await manager.handleFrame('matrix-client', 'terminal_open', {
          requestId: `open-${engine}`,
          protocolVersion: 3,
          agentId,
          cols: 90 + index,
          rows: 24,
          compression: ['none'],
        })
        const ready = frames.find((frame) => frame.type === 'terminal_ready')
        expect(ready?.payload).toMatchObject({ agentId, engineId: engine })
        const streamId = ready?.payload.streamId
        expect(typeof streamId).toBe('string')

        const marker = `HARNESS_ENGINE_STREAM_${engine.toUpperCase()}`
        await manager.handleBinary('matrix-client', {
          kind: TerminalBinaryKind.input,
          streamId: streamId as string,
          seq: 0,
          compressed: false,
          bytes: Buffer.from(`printf '${marker}\\n'\r`),
        })
        await eventually(() => binaryFrames.some((frame) => {
          if (frame.kind !== TerminalBinaryKind.output || frame.compressed) return false
          return Buffer.from(frame.bytes).includes(Buffer.from(marker))
        }))

        await manager.handleFrame('matrix-client', 'terminal_resize', {
          streamId,
          resizeSeq: 0,
          cols: 100 + index,
          rows: 30,
        })
        expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}']))
          .toBe(`${100 + index}x30`)
        await manager.handleFrame('matrix-client', 'terminal_close', { streamId })
      } finally {
        await manager.stop()
      }
    }
  }, 60_000)

  it('never mistakes the control client handshake for the first snapshot command', async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const opened = await TmuxControlStream.open(paneId, { cols: 100, rows: 30 }, {
        onData: () => {},
        onClose: () => {},
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') continue
      opened.value.beginSnapshot()
      const snapshot = await opened.value.snapshot()
      expect(snapshot.state).toBe('succeeded')
      opened.value.endSnapshot()
      await opened.value.close()
    }
  })
})
