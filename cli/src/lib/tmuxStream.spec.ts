import { describe, expect, it } from 'vitest'
import {
  decodeTmuxControlData,
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
        mouseStandard: false, mouseButton: false, mouseAll: false,
        mouseUtf8: false, mouseSgr: false,
      },
    )).toString()

    expect(snapshot).toContain('\u001b[?7l')
    expect(snapshot).toContain('\u001b[1;1Hwide 世界 row\u001b[0m')
    expect(snapshot).toContain('\u001b[2;1Hsecond row\u001b[0m')
    expect(snapshot).toContain('\u001b[2;5H\u001b[?7h\u001b[?25h')
  })
})
