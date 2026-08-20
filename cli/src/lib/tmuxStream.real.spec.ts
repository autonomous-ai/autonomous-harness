import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TmuxControlStream } from './tmuxStream.js'

const run = process.env.RUN_REAL_TMUX_STREAM === '1' ? describe : describe.skip

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 3_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
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

    const snapshot = await opened.value.snapshot(100)
    expect(snapshot.state).toBe('succeeded')
    if (snapshot.state === 'succeeded') {
      expect(snapshot.value.cols).toBe(96)
      expect(snapshot.value.rows).toBe(28)
      expect(Buffer.from(snapshot.value.bytes).includes(Buffer.from('\u001bc'))).toBe(true)
    }

    await opened.value.writeRaw(Buffer.from("printf 'HARNESS_STREAM_OK\\n'\r"))
    const deadline = Date.now() + 3_000
    while (!Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(Buffer.concat(chunks).includes(Buffer.from('HARNESS_STREAM_OK'))).toBe(true)

    expect((await opened.value.resize({ cols: 110, rows: 35 })).state).toBe('succeeded')
    expect(await tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}'])).toBe('110x35')
    await opened.value.close()
    expect(closedReason === '' || closedReason === 'closed').toBe(true)
  })
})
