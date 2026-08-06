/**
 * Muse Code's ask-the-user dialog.
 *
 * Captured live (muse 0.1.0-R708.1) — the shared Claude parser gets three things wrong on it, which is
 * why this exists:
 *
 *   Bạn thích màu chủ đề nào: Xanh hay Đỏ?          ← the question
 *   ┌─ Preview ──────────────────────────────┐      ← a PREVIEW of the answer being hovered; the shared
 *   │ Bạn chọn Xanh làm màu chủ đề.          │        parser mistook its bottom border for the question
 *   └────────────────────────────────────────┘
 *   › 1. Xanh               Tông màu xanh mát mẻ     ← label and description are one line, split by a
 *     2. Đỏ                 Tông màu đỏ nổi bật        run of spaces — not a separate line as in claude
 *     3. None of the above  Optionally, add details    ← selecting this opens a note editor, and the
 *   Enter to select · ↑/↓ to move · Tab for a note       device has no text input, so never offer it
 *
 * The preview box also means the answer text appears on screen BEFORE anything is chosen, so a naive
 * "read the last box" approach would report the hovered option as if the user had picked it.
 */

import type { PaneView, QuestionRow } from '../../lib/askQuestion.js'

const ROW_RE = /^\s*[›>]?\s*(\d+)[.)]\s+(.+?)\s*$/
/**
 * The dialog's footer, and ONLY the dialog's. It is one line:
 *
 *   Enter to select · ↑/↓ to move · Tab for an optional note · Esc to interrupt
 *
 * `esc to interrupt` used to be a third alternative here. It is a SUFFIX of that same line, so it bought
 * nothing — and it is also what muse prints on its own status line for any RUNNING turn (see
 * sessionInput.ts, which relies on exactly that). Any turn whose output happened to contain numbered
 * lines therefore anchored here and was scraped into a question that nobody asked: reading an HTML file
 * with a numbered feature list produced the "question" `• 5 Features:` on the device while the terminal
 * showed no dialog at all.
 *
 * `enter to select` is the robust anchor of the two kept: the line is long, and a narrow pane truncates
 * from the END, which takes `Esc to interrupt` first and leaves this untouched.
 */
const FOOTER_RE = /enter to select|↑\/↓ to move/i
/** Opens a free-text editor; the device's question screen cannot type, so it is never an answer. */
const NOT_AN_ANSWER = /^none of the above\b/i

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, '')
}

/** A row's visible label, without the description column glued on by a run of 2+ spaces. */
function labelOf(rest: string): string {
  return rest.split(/\s{2,}/)[0].trim()
}

export function parseMuseQuestionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).split('\n')
  // Anchor on the LAST footer: an answered dialog stays in the scrollback above the live one.
  let footer = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footer = i; break }
  }
  if (footer < 0) return null

  const rows: QuestionRow[] = []
  let top = footer
  for (let i = footer - 1; i >= 0 && footer - i < 40; i--) {
    const m = ROW_RE.exec(lines[i])
    if (m) {
      const label = labelOf(m[2])
      if (label && !NOT_AN_ANSWER.test(label)) rows.unshift({ number: m[1], label, checked: false })
      top = i
      continue
    }
    if (rows.length && lines[i].trim()) break   // stop at the first non-row line above the block
  }
  if (rows.length === 0) return null

  // The question is the last non-empty line above the rows that is not part of the preview box.
  let question = ''
  for (let i = top - 1; i >= 0 && top - i < 12; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^[┌│└├─╭╰]/.test(line) || /^\W*Preview\b/i.test(line)) continue
    question = line
    break
  }
  if (!question) return null

  // muse's dialog is single-select: one Enter commits the highlighted row. `typeRow` stays null — the
  // only free-text path is "None of the above", which is dropped above for lack of an input on the device.
  return { kind: 'question', question, rows, multi: false, typeRow: null }
}
