/**
 * Cursor's permission prompt — the only dialog cursor ever blocks a person on.
 *
 * It ships no ask-the-user tool at all (asked to use one, cursor answers that no MCP server provides it),
 * so unlike every other engine this file has no question parser to sit beside. Captured live from
 * cursor-agent 2026.08.11 (`__fixtures__/permission-cursor.txt`):
 *
 *   ────────────────────────────────────────────────
 *    $  curl -s https://example.com in .              ← the command, and the directory it runs in
 *
 *    Run this command?
 *    Not in allowlist: curl                           ← why it is asking
 *     → Run (once) (y)
 *       Add Shell(curl) to allowlist? (tab)
 *       Run Everything (shift+tab)
 *       Skip & tell the agent what to do instead (esc or n)
 *
 * What makes cursor its own parser is the third selection mechanism in this codebase. Claude numbers its
 * rows and a digit submits; amp and kilo number nothing and are walked with arrows; cursor numbers
 * nothing either but **every row states its own key in a trailing parenthesis**. So the key is read off
 * the row and carried in `number`, which is exactly what `rowKeys` presses — no walk, no digit, no engine
 * branch in the driver.
 *
 * Two details worth stating, because both are choices rather than transcriptions:
 *
 *   - `(esc or n)` becomes **`n`**, never `Escape`. Esc is also the pane's own cancel and on a busy
 *     cursor pane it does more than decline the prompt; the letter only ever answers this dialog.
 *   - `Run Everything` is KEPT, even though it disables approvals for the rest of the session. It is
 *     cursor's own wording for the same escape hatch claude spells "don't ask again" and amp spells
 *     "Allow All for Every Session", and hiding one engine's version of a row the others all offer would
 *     be a silent behaviour difference, not a safety feature. Tapping it stays the person's decision.
 *
 * There is no footer under the rows — the pane simply ends at the last option, the way Command Code's
 * dialog does — so the frame's opening rule is the anchor at both ends.
 *
 * One fixture covers cursor because cursor has exactly one gate. Probed on a live pane: editing a file in
 * the workspace, and even writing one OUTSIDE it (`/private/tmp/…`), both run unprompted once the
 * workspace is trusted. Only a shell command absent from the allowlist stops for a person — so unlike
 * claude, there is no second `Edit file` shape waiting to be missed.
 */

import type { PaneView, QuestionRow } from '../../lib/askQuestion.js'

/** The row's own key hint, always the LAST parenthesis on the line. `[^()]` keeps `Shell(curl)` out. */
const ROW_RE = /^\s*(?:[→▶>›]\s*)?(\S.*?)\s*\(([^()]{1,14})\)\s*$/
/** The line that opens the frame. Cursor draws no box, just a rule. */
const RULE_RE = /^\s*[─━═]{6,}\s*$/
/** `Run this command?` — cursor states what it is asking before it lists the rows. */
const PROMPT_RE = /^\s*(run|apply|allow|execute|edit|delete|write)\b.*\?\s*$/i
/** Measured on this dialog: `Run (once)` approves, `Skip & tell the agent …` declines. */
const APPROVE_RE = /^(run|allow|add|yes|approve|accept|proceed|continue)\b/i
const REJECT_RE = /^(skip|no|reject|deny|decline|cancel|stop)\b/i

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;:]*[A-Za-z]/g, '')
}

/**
 * The tmux key name for one of cursor's hints, or null when the row cannot be answered by keystroke.
 *
 * Measured hints: `y`, `tab`, `shift+tab`, `esc or n`.
 */
export function cursorRowKey(hint: string): string | null {
  const h = hint.trim().toLowerCase()
  if (/^shift\s*\+\s*tab$/.test(h)) return 'BTab'
  if (/^tab$/.test(h)) return 'Tab'
  if (/^enter$/.test(h)) return 'Enter'
  // "esc or n" offers two keys for one row; take the letter, never Escape (see the docblock).
  const letter = /(?:^|\bor\s+)([a-z0-9])$/.exec(h)
  return letter ? letter[1] : null
}

export function parseCursorPermissionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).replace(/ /g, ' ').split('\n')

  // The rows are the last contiguous run of key-hinted lines on the pane. Nothing follows them: cursor
  // paints no footer, so walking up from the bottom-most row is the only anchor available.
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ROW_RE.test(lines[i])) { end = i; break }
  }
  if (end < 0) return null

  const rows: QuestionRow[] = []
  let start = end + 1
  for (let i = end; i >= 0 && end - i < 10; i--) {
    const match = ROW_RE.exec(lines[i])
    if (!match) break
    const key = cursorRowKey(match[2])
    // A row whose hint is not a single keystroke cannot be answered from a device; drop it rather than
    // offer a choice that would do nothing.
    if (key) rows.unshift({ number: key, label: match[1].trim(), checked: false })
    start = i
  }
  if (rows.length < 2) return null
  if (!rows.some((row) => APPROVE_RE.test(row.label)) || !rows.some((row) => REJECT_RE.test(row.label))) return null

  // Above the rows: the prompt, then the frame's rule with the command just under it.
  let prompt = -1
  for (let i = start - 1; i >= 0 && start - i <= 6; i--) {
    if (PROMPT_RE.test(lines[i])) { prompt = i; break }
  }
  if (prompt < 0) return null

  let command = ''
  for (let i = prompt - 1; i >= 0 && prompt - i <= 8; i--) {
    if (!RULE_RE.test(lines[i])) continue
    for (let j = i + 1; j < prompt; j++) {
      const line = lines[j].trim().replace(/^\$\s*/, '').replace(/\s+/g, ' ')
      // `… in .` just means the workspace root; a real subdirectory is worth keeping.
      if (line) { command = line.replace(/\s+in\s+\.$/, ''); break }
    }
    break
  }

  return {
    kind: 'question',
    question: command ? `Approve ${command}` : lines[prompt].trim(),
    rows,
    multi: false,
    typeRow: null,
  }
}
