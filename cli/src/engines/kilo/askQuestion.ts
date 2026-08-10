/**
 * Kilo's ask-the-user dialog — which, like amp's, is a PERMISSION prompt rather than a question tool.
 *
 * This is the one place kilo's pane diverges hardest from the opencode it forked. OpenCode draws Claude's
 * numbered dialog inside a box, so the shared parser fits once the border is peeled. Kilo does not: it
 * lays its options out HORIZONTALLY on a single line, unnumbered, sharing that line with the key hints.
 * Captured live from a real pane (an `external_directory` rule set to `ask`, which is kilo's default for
 * anything outside the project — so this prompt is not an edge case, it is what a web-driven agent hits
 * the first time it reads a path outside its own directory):
 *
 *   ┃  △ Permission required
 *   ┃    ← Access external directory /private/etc
 *   ┃
 *   ┃  Patterns
 *   ┃
 *   ┃  - /private/etc/*
 *   ┃
 *   ┃   Allow once   Allow always   Reject      ctrl+f fullscreen  ⇆ select  enter confirm
 *
 * Four measured properties drive everything below:
 *
 *   - **Options and footer share one line**, separated from each other by runs of spaces. Splitting on
 *     whitespace alone would hand the device `ctrl+f fullscreen` as a selectable answer, so the hint
 *     segments are removed by name before the labels are read.
 *   - **The options are not numbered**, so nothing can be answered by pressing a digit. `number` carries
 *     the row's INDEX and `kiloSelectionKeys` turns it into a walk — with `Right`, not `Down`: the footer
 *     says `⇆ select`, and the layout is horizontal.
 *   - **The selected row is marked only in ANSI.** Verified against the raw capture: `Allow once` is drawn
 *     on the amber accent background (`48;2;204;167;0`) while the others sit on grey. A plain
 *     `capture-pane -p` keeps none of that, so the walk assumes the dialog opens on the FIRST row — the
 *     same assumption amp's parser makes, and the reason a walk is computed rather than a jump.
 *   - **The box has a left rail only** (`┃`), not a full border, so peeling is one-sided.
 *
 * `Reject` is kept for the same reason amp's `Reject with feedback` is: dropping it would leave a device
 * user two ways to say yes and none to say no. Neither of the "allow" rows is preferred here — choosing
 * between "once" and "always" is a policy decision that belongs to the person, not to this parser.
 */

import type { PaneView, QuestionRow } from '../../lib/askQuestion.js'

/** `enter confirm` is the stable half of the footer; `⇆ select` is dropped first on a narrow pane. */
const FOOTER_RE = /enter\s+confirm/i
/** The title is what proves this is a permission prompt and not another box explaining its own keys. */
const TITLE_RE = /permission required/i
/** Key hints living on the options line. Matched as whole segments so a real label is never eaten. */
const HINT_RE = /^(ctrl\+\w+|esc|tab|enter|⇆|↑|↓|←|→|shift)\b/i
/** An option label: a short capitalised phrase. `Allow once` / `Allow always` / `Reject`, measured. */
const LABEL_RE = /^[A-Z][\w][\w ]{0,38}$/

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
}

/** Peel kilo's left rail and any trailing rail/scrollbar glyphs. */
function unbox(line: string): string {
  return line
    .replace(/^[^│┃|]*[│┃|]/, '')
    .replace(/[│┃|█▌▐▁▂▃▄▅▆▇]+\s*$/, '')
    .trimEnd()
}

/** Split the options line into segments and keep only the ones that are actually options. */
function labelsFrom(line: string): string[] {
  return line
    .split(/\s{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !HINT_RE.test(segment) && LABEL_RE.test(segment))
}

/**
 * The keystrokes that select one row: walk right to it, then commit.
 *
 * Returned as a list because `sendKey` sends exactly one tmux key name per call.
 */
export function kiloSelectionKeys(row: QuestionRow): string[] {
  const index = Number(row.number)
  const steps = Number.isFinite(index) && index > 0 ? index : 0
  return [...Array(steps).fill('Right'), 'Enter']
}

export function parseKiloQuestionPane(capture: string): PaneView {
  const raw = stripAnsi(capture).split('\n')
  // Anchor on the LAST dialog: a prompt already answered stays in the scrollback above the live one.
  let footer = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(raw[i])) { footer = i; break }
  }
  if (footer < 0) return null
  let title = -1
  for (let i = footer; i >= 0 && footer - i < 40; i--) {
    if (TITLE_RE.test(raw[i])) { title = i; break }
  }
  if (title < 0) return null

  // Options normally share the footer line. On a pane too narrow to fit both, the hints wrap away and the
  // labels are the last content line above — so fall back to that rather than reporting no dialog.
  let labels = labelsFrom(unbox(raw[footer]))
  if (labels.length < 2) {
    for (let i = footer - 1; i > title; i--) {
      const line = unbox(raw[i])
      if (!line.trim()) continue
      labels = labelsFrom(line)
      break
    }
  }
  if (labels.length < 2) return null

  const rows: QuestionRow[] = labels.map((label, index) => ({
    number: String(index),
    label,
    checked: false,
  }))

  // What is being permitted: the first content line under the title, minus the `←` bullet kilo draws on
  // it. Best-effort — the row list is what the answer actually depends on.
  let question = ''
  for (let i = title + 1; i < footer; i++) {
    const line = unbox(raw[i]).trim().replace(/^[←→‣>•-]\s*/, '').trim()
    if (!line) continue
    question = line
    break
  }

  return { kind: 'question', question: question || 'Permission required', rows, multi: false, typeRow: null }
}
