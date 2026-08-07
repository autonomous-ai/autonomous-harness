/**
 * Amp's ask-the-user dialog — which is a PERMISSION prompt, not a question tool.
 *
 * Amp ships no ask-the-user tool at all (measured: 33 tools in a real session's `system/init`, none of
 * them asks anything). The only time it blocks on a person is when a permission rule says `ask`, and it
 * draws this, captured live:
 *
 *   ╭─ Approval Required ───────────────────────────────────╮
 *   │                                                       │
 *   │ shell_command:                                      █ │   ← the tool, then its arguments as
 *   │   {                                                 █ │     pretty-printed JSON, in a scroll box
 *   │     "command": "echo probe123",                     █ │
 *   │     "workdir":                                      █ │   ← long values WRAP mid-string, which is
 *   │ "/private/tmp/…/amp-probe"                          █ │     why the JSON is never re-parsed here
 *   │   }                                                 █ │
 *   │                                                       │
 *   │ ‣ Allow Once                                          │   ← selection is a MARKER, not a number
 *   │   Reject with feedback                                │
 *   │   Allow All for This Session                          │
 *   │   Allow All for Every Session                         │
 *   ╰──── ↑/↓/j/k move · Enter select · Esc cancel ─────────╯
 *
 * Three things separate it from every other engine's dialog:
 *
 *   - **The options are not numbered.** Nothing can be answered by pressing a digit; the caller has to
 *     walk the list with `Down` and commit with `Enter`. `number` therefore carries the row's INDEX, and
 *     `ampSelectionKeys` turns it into that walk.
 *   - **The options are fixed**, so the row list is the same for every approval.
 *   - **Nothing records it.** The thread log logs an approval queue with a COUNT and no content, and the
 *     server export has no trace of a pending approval. The pane is the only place it exists.
 *
 * `Reject with feedback` is deliberately KEPT even though it opens a free-text editor the device cannot
 * type into. Dropping it — the rule the other engines' "None of the above" follows — would leave a device
 * user with four ways to say yes and none to say no.
 */

import type { PaneView, QuestionRow } from '../../lib/askQuestion.js'

/** The dialog's own footer. `Enter select` is the stable half; a narrow pane truncates from the end. */
const FOOTER_RE = /enter select|↑\/↓\/j\/k move/i
const TITLE_RE = /Approval Required/i
/** `‣` marks the highlighted row; the rest are indented by the same amount. */
const ROW_RE = /^\s*[‣>›]?\s{0,3}([A-Z][\w ]{2,60}?)\s*$/
/** `"command": "echo hi"` — one complete pair on one line. A wrapped value simply does not match. */
const ARG_RE = /"(?:command|path|file_path|name|query|url)"\s*:\s*"([^"]{1,120})"/

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, '')
}

/**
 * Peel the box border AND the scrollbar column so the contents read as plain lines.
 *
 * The scrollbar is a separate trailing glyph inside the border (`… █ │`), so one pass that strips a
 * single trailing character is not enough — it left `shell_command:            █`, which then matched
 * nothing and cost the dialog its question text.
 */
function unbox(line: string): string {
  return line
    .replace(/^[^│┃|]*[│┃|]/, '')
    .replace(/[│┃|█▌▐▁▂▃▄▅▆▇]+\s*$/, '')
    .replace(/[│┃|█▌▐]+\s*$/, '')
    .trimEnd()
}

/**
 * The keystrokes that select one row: walk down to it, then commit.
 *
 * Amp's list always opens on the first row, so the walk is the row's index. Returned as a list because
 * `sendKey` sends exactly one tmux key name per call.
 */
export function ampSelectionKeys(row: QuestionRow): string[] {
  const index = Number(row.number)
  const steps = Number.isFinite(index) && index > 0 ? index : 0
  return [...Array(steps).fill('Down'), 'Enter']
}

export function parseAmpQuestionPane(capture: string): PaneView {
  const raw = stripAnsi(capture).split('\n')
  // Anchor on the LAST dialog: an approval already answered stays in the scrollback above the live one.
  let footer = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(raw[i])) { footer = i; break }
  }
  if (footer < 0) return null
  // The footer regex alone is not enough — the title is what proves this is an approval and not some
  // other box that happens to explain its own key bindings.
  let title = -1
  for (let i = footer - 1; i >= 0 && footer - i < 60; i--) {
    if (TITLE_RE.test(raw[i])) { title = i; break }
  }
  if (title < 0) return null

  const lines = raw.slice(title, footer).map(unbox)

  // Options are the LAST run of label lines before the footer. Walking up from the bottom stops at the
  // JSON body, whose lines are punctuation-led (`{`, `"command": …`, `}`) and never match a label.
  const labels: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) { if (labels.length) break; continue }
    const match = ROW_RE.exec(line)
    if (!match) break
    labels.unshift(match[1].trim())
  }
  if (labels.length < 2) return null

  const rows: QuestionRow[] = labels.map((label, index) => ({
    number: String(index),
    label,
    checked: false,
  }))

  // What is being approved. The tool is the line ending in `:` above the JSON; the argument preview is
  // whichever recognised key survived on a single line. Both are best-effort — the row list is what the
  // answer actually depends on.
  let tool = ''
  let arg = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!tool) {
      const match = /^([a-zA-Z_][\w]*):$/.exec(trimmed)
      if (match) { tool = match[1]; continue }
    }
    if (!arg) {
      const match = ARG_RE.exec(trimmed)
      if (match) arg = match[1]
    }
  }
  const question = tool
    ? (arg ? `Approve ${tool}: ${arg}` : `Approve ${tool}?`)
    : 'Approval required'

  // Single-select: one Enter commits the highlighted row. `typeRow` stays null — "Reject with feedback"
  // is an option to be CHOSEN, not a free-text row to be typed into from here.
  return { kind: 'question', question, rows, multi: false, typeRow: null }
}
