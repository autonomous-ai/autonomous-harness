import { describe, expect, it, vi } from 'vitest'
import {
  ControlCommandQueue,
  decodeTmuxControlData,
  normalizeTmuxHistoryLines,
  normalizeTmuxCaptureLines,
  parseTmuxControlOutput,
  synthesizeTmuxSnapshot,
} from './tmuxStream.js'

describe('tmux control-mode output decoding', () => {
  it('decodes octal bytes without corrupting adjacent UTF-8', () => {
    const decoded = decodeTmuxControlData('hello\\040世界\\015\\012\\033[31m')
    expect(Buffer.from(decoded)).toEqual(Buffer.from('hello 世界\r\n\u001b[31m'))
  })

  it('preserves ordinary backslashes that are not octal escapes', () => {
    expect(Buffer.from(decodeTmuxControlData('C:\\Users\\name')).toString()).toBe('C:\\Users\\name')
  })

  it('preserves a UTF-8 scalar split across separate output records', () => {
    const first = parseTmuxControlOutput(Buffer.concat([
      Buffer.from('%output %7 '),
      Buffer.from([0xe2, 0x94]),
    ]))
    const second = parseTmuxControlOutput(Buffer.concat([
      Buffer.from('%output %7 '),
      Buffer.from([0x80]),
    ]))

    expect(first?.paneId).toBe('%7')
    expect(second?.paneId).toBe('%7')
    expect(Buffer.concat([
      Buffer.from(first!.data),
      Buffer.from(second!.data),
    ])).toEqual(Buffer.from('─'))
  })
})

describe('tmux snapshot row normalization', () => {
  it('turns capture-pane LF rows into VT CRLF and drops its final output delimiter', () => {
    const capture = Buffer.from('first\n\u001b[31m世界\nlast\r\n')
    expect(Buffer.from(normalizeTmuxCaptureLines(capture))).toEqual(
      Buffer.from('first\u001b[0m\r\n\u001b[31m世界\u001b[0m\r\nlast\u001b[0m'),
    )
  })

  it('stops a styled trailing background from bleeding into the next blank row', () => {
    const capture = Buffer.from('\u001b[48;5;237mprompt   \n\n\u001b[49mreply\n')
    expect(Buffer.from(normalizeTmuxCaptureLines(capture)).toString()).toBe(
      '\u001b[48;5;237mprompt   \u001b[0m\r\n\u001b[0m\r\n\u001b[49mreply\u001b[0m',
    )
  })

  it('places every captured row absolutely while autowrap is disabled', () => {
    const snapshot = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('wide 世界 row\nsecond row\n'),
      {
        sessionId: '$1', windowId: '@1', windowPanes: 1,
        windowWidth: 80, windowHeight: 2, paneWidth: 80, paneHeight: 2,
        alternateOn: false, cursorX: 4, cursorY: 1,
        cursorVisible: true,
        mouseStandard: false, mouseButton: false, mouseAll: false,
        mouseUtf8: false, mouseSgr: false,
      },
    )).toString()

    expect(snapshot).toContain('\u001b[?7l')
    expect(snapshot).toContain('\u001b[1;1Hwide 世界 row\u001b[0m')
    expect(snapshot).toContain('\u001b[2;1Hsecond row\u001b[0m')
    expect(snapshot).toContain('\u001b[2;5H\u001b[?7h\u001b[?25h')
  })

  it('says which screen it captured, so the receiver can scroll it', () => {
    // A pane running a full-screen TUI is on the ALTERNATE screen, and that one fact closes both ways
    // of scrolling when it goes unsaid: the alternate screen has no scrollback to move through (tmux
    // reports history_size=0), and the emulator only converts the wheel into escapes for the remote
    // application while it believes it is on that buffer. `ESC c` resets to the normal one, so a
    // keyframe that stayed silent actively asserted the wrong screen.
    const meta = {
      sessionId: '$1', windowId: '@1', windowPanes: 1,
      windowWidth: 80, windowHeight: 2, paneWidth: 80, paneHeight: 2,
      cursorX: 0, cursorY: 0, cursorVisible: true,
      mouseStandard: false, mouseButton: false, mouseAll: false,
      mouseUtf8: false, mouseSgr: false,
    }
    const onAlt = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('row\n'), { ...meta, alternateOn: true },
    )).toString()
    expect(onAlt).toContain('\u001b[?1049h')
    expect(onAlt).not.toContain('\u001b[?1049l')

    // And said in BOTH directions: a pane that has just come out of a TUI must not be left in it, and
    // whether RIS alone leaves the alternate buffer is emulator-dependent.
    const onNormal = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('row\n'), { ...meta, alternateOn: false },
    )).toString()
    expect(onNormal).toContain('\u001b[?1049l')
    expect(onNormal).not.toContain('\u001b[?1049h')
  })

  it('preserves a tmux-hidden hardware cursor while restoring its position', () => {
    const snapshot = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('painted input\n'),
      {
        sessionId: '$1', windowId: '@1', windowPanes: 1,
        windowWidth: 80, windowHeight: 2, paneWidth: 80, paneHeight: 2,
        alternateOn: false, cursorX: 0, cursorY: 1,
        cursorVisible: false,
        mouseStandard: false, mouseButton: false, mouseAll: false,
        mouseUtf8: false, mouseSgr: false,
      },
    )).toString()

    expect(snapshot.endsWith('\u001b[2;1H\u001b[?7h\u001b[?25l')).toBe(true)
  })

  it('seeds styled cell history before rebuilding the visible grid', () => {
    const history = Buffer.from('\u001b[31mold-frame-1\u001b[39m\nold-frame-2\n')
    expect(Buffer.from(normalizeTmuxHistoryLines(history)).toString()).toBe(
      '\u001b[31mold-frame-1\u001b[39m\u001b[0m\r\nold-frame-2\u001b[0m\r\n',
    )
    const snapshot = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('current-screen\n'),
      {
        sessionId: '$1', windowId: '@1', windowPanes: 1,
        windowWidth: 80, windowHeight: 2, paneWidth: 80, paneHeight: 2,
        alternateOn: false, cursorX: 0, cursorY: 0,
        cursorVisible: true,
        mouseStandard: false, mouseButton: false, mouseAll: false,
        mouseUtf8: false, mouseSgr: false,
      },
      history,
    )).toString()

    expect(snapshot.indexOf('old-frame-1')).toBeLessThan(snapshot.indexOf('current-screen'))
    expect(snapshot).toContain('old-frame-2\u001b[0m\r\n\r\n\r\n\u001b[H\u001b[2J')
  })

  it('restores tmux mouse modes even when no scrollback exists', () => {
    const snapshot = Buffer.from(synthesizeTmuxSnapshot(
      Buffer.from('alternate-screen\n'),
      {
        sessionId: '$1', windowId: '@1', windowPanes: 1,
        windowWidth: 80, windowHeight: 2, paneWidth: 80, paneHeight: 2,
        alternateOn: true, cursorX: 0, cursorY: 0,
        cursorVisible: true,
        mouseStandard: false, mouseButton: false, mouseAll: true,
        mouseUtf8: false, mouseSgr: true,
      },
    )).toString()

    expect(snapshot).toContain('\u001b[H\u001b[2J\u001b[?1003h\u001b[?1006h')
  })
})

describe('ControlCommandQueue', () => {
  function harness(timeoutMs = 3_000) {
    const written: string[] = []
    const fatal: string[] = []
    let accept = true
    const queue = new ControlCommandQueue({
      write: (line) => { if (!accept) return false; written.push(line); return true },
      onFatal: (reason) => fatal.push(reason),
      timeoutMs,
    })
    queue.markReady()
    return { queue, written, fatal, reject: () => { accept = false } }
  }

  it('pipelines commands and completes them in order', async () => {
    const { queue, written } = harness()
    const first = queue.run('display-message -p one')
    const second = queue.run('display-message -p two')

    // Both reached tmux before either replied — that is what stops input queueing behind a snapshot.
    expect(written).toEqual(['display-message -p one\n', 'display-message -p two\n'])
    expect(queue.idle).toBe(false)

    queue.handleBegin('10')
    queue.appendResponseLine(Buffer.from('ONE'))
    queue.handleCompleted('end', '10')
    queue.handleBegin('11')
    queue.appendResponseLine(Buffer.from('TWO'))
    queue.handleCompleted('end', '11')

    expect((await first).stdout.toString()).toBe('ONE\n')
    expect((await second).stdout.toString()).toBe('TWO\n')
    expect(queue.idle).toBe(true)
  })

  it('keeps an untracked send-keys from stealing a real command number', async () => {
    const { queue } = harness()
    const keys = queue.run('send-keys -t %1 -H 61')
    const query = queue.run('display-message -p meta')

    queue.handleBegin('20')
    queue.handleCompleted('end', '20')
    queue.handleBegin('21')
    queue.appendResponseLine(Buffer.from('META'))
    queue.handleCompleted('end', '21')

    expect((await keys).ok).toBe(true)
    // The reply landed on the query, not on the keystroke that preceded it.
    expect((await query).stdout.toString()).toBe('META\n')
  })

  it('fails one command on %error without disturbing the next', async () => {
    const { queue } = harness()
    const bad = queue.run('send-keys -t %1 -H zz')
    const good = queue.run('display-message -p ok')

    queue.handleBegin('30')
    queue.handleCompleted('error', '30')
    queue.handleBegin('31')
    queue.appendResponseLine(Buffer.from('OK'))
    queue.handleCompleted('end', '31')

    expect((await bad).ok).toBe(false)
    expect((await good).ok).toBe(true)
    expect((await good).stdout.toString()).toBe('OK\n')
  })

  it('ignores a completion that does not match the head', async () => {
    const { queue } = harness()
    const pending = queue.run('display-message -p one')
    queue.handleBegin('40')
    expect(queue.handleCompleted('end', '41')).toBe(false)
    expect(queue.idle).toBe(false)
    expect(queue.handleCompleted('end', '40')).toBe(true)
    expect((await pending).ok).toBe(true)
  })

  it('times out from the moment a command reaches the head, not when it was written', async () => {
    vi.useFakeTimers()
    try {
      const { queue, fatal } = harness(100)
      const slow = queue.run('capture-pane -p')
      const queued = queue.run('send-keys -t %1 -H 61')

      queue.handleBegin('50')
      // The second command has been on the wire the whole time but is not being timed yet.
      await vi.advanceTimersByTimeAsync(90)
      queue.handleCompleted('end', '50')
      await vi.advanceTimersByTimeAsync(90)
      expect(fatal).toEqual([])

      await vi.advanceTimersByTimeAsync(20)
      expect(fatal).toEqual(['tmux control command timed out'])
      await slow
      queue.failAll()
      await queued
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves everything as failed when the channel dies', async () => {
    const { queue } = harness()
    const inFlight = queue.run('display-message -p one')
    queue.handleBegin('60')
    queue.failAll()
    expect((await inFlight).ok).toBe(false)
    expect(queue.idle).toBe(true)
  })

  it('reports a write that the pipe refused', async () => {
    const { queue, reject } = harness()
    reject()
    expect((await queue.run('display-message -p one')).ok).toBe(false)
    expect(queue.idle).toBe(true)
  })
})
