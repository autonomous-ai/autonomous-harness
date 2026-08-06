import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parseMuseQuestionPane } from './askQuestion.js'
import { parseQuestionPane } from '../../lib/askQuestion.js'

/** A REAL `tmux capture-pane -e -J` of muse 0.1.0-R708.1 with its dialog open. */
function fixture(): string {
  return readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/question-muse.txt', import.meta.url)), 'utf-8')
}

describe('muse question dialog', () => {
  it('reads the question and its options', () => {
    const view = parseMuseQuestionPane(fixture())
    expect(view?.kind).toBe('question')
    expect(view && 'question' in view && view.question).toBe('Bạn thích màu chủ đề nào: Xanh hay Đỏ?')
    expect(view && 'rows' in view && view.rows.map((r) => [r.number, r.label]))
      .toEqual([['1', 'Xanh'], ['2', 'Đỏ']])
  })

  it('splits the label from the description column', () => {
    // muse puts both on ONE line separated by a run of spaces; sending the whole line back as the answer
    // would type a description no keystroke can select.
    const labels = (parseMuseQuestionPane(fixture()) as { rows: Array<{ label: string }> }).rows.map((r) => r.label)
    expect(labels.some((l) => l.includes('Tông màu'))).toBe(false)
  })

  it('never offers "None of the above"', () => {
    // It opens a note editor; the device's question screen has no text input, so that answer is
    // unreachable and must not be shown as if it were.
    const labels = (parseMuseQuestionPane(fixture()) as { rows: Array<{ label: string }> }).rows.map((r) => r.label)
    expect(labels.some((l) => /none of the above/i.test(l))).toBe(false)
  })

  it('does not mistake the Preview box for the question — which the shared parser does', () => {
    // muse floats a live preview of the HOVERED answer above the rows. This is exactly why muse needs
    // its own parser: the shared one anchors on the wrong line.
    const shared = parseQuestionPane(fixture())
    expect(shared && 'question' in shared && shared.question).toMatch(/^[└┘─]/)
    const mine = parseMuseQuestionPane(fixture())
    expect(mine && 'question' in mine && mine.question).not.toMatch(/^[└┘─]/)
  })

  it('says nothing when no dialog is open', () => {
    expect(parseMuseQuestionPane('')).toBeNull()
    expect(parseMuseQuestionPane('just some prose\n⟩ ')).toBeNull()
    expect(parseMuseQuestionPane('Enter to select · ↑/↓ to move')).toBeNull()   // footer with no rows
  })

  it('does not invent a question out of a RUNNING turn that printed a numbered list', () => {
    // Reported live: "read the source of this html file" → the device showed options to pick from while
    // the terminal asked nothing. `esc to interrupt` is muse's running-turn status line, and it used to
    // anchor this parser; the numbered lines in the file's own output then became the options and the
    // bullet above them became the question.
    const running = [
      '⟩ read source in autonomous-harness folder to get context',
      '◆ Bash (12s)',
      '  • 5 Features:',
      '    1. Offline-first, no server needed',
      '    2. Next.js clone, ready locally',
      '    3. Instant setup',
      '✧ Working…  esc to interrupt • 23s',
    ].join('\n')
    expect(parseMuseQuestionPane(running)).toBeNull()
  })
})
