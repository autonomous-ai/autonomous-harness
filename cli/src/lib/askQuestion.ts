/**
 * AskUserQuestion on a REMOTE machine — mirror the question to the device, then answer it by driving the
 * interactive CLI's own terminal dialog.
 *
 * A runtime that speaks stream-json gets this for free: a `question_request` event carries
 * the questions out and a `question_response` control-frame carries the answer back. A remote machine has no
 * such channel — the adapter watches a JSONL transcript and talks to a real TUI. So both halves read and
 * write the pane itself:
 *
 *   OUT  QuestionWatcher polls the pane while a turn is open and pushes the open dialog as
 *        `commander_question`, in the SAME shape the hosted runtime sends, so the firmware's existing question
 *        screen renders it unchanged (commanderQuestions in websocket.ts). NOT from the transcript —
 *        see the QuestionWatcher docblock for why that source cannot work.
 *   IN   the device's `question_response` → keystrokes into the pane's dialog.
 *
 * Dialog mechanics (verified against Claude Code 2.1.220, `tmux capture-pane`):
 *   - single-select : the option's digit selects AND submits, advancing to the next question / review.
 *   - free text     : the digit of the "Type something." row opens it for editing (does NOT submit) →
 *                     type the text → Enter submits.
 *   - multi-select  : rows render as `[ ]` / `[✔]`; a digit TOGGLES; Tab advances to the next question.
 *   - review        : after the last question, "Ready to submit your answers?" → "1. Submit answers".
 */

import type { RegisteredSession } from './registry.js'
import type { AgentEngine } from '../engines/types.js'
import { parseMuseQuestionPane } from '../engines/muse/askQuestion.js'
import { ampSelectionKeys, parseAmpQuestionPane } from '../engines/amp/askQuestion.js'
import { kiloSelectionKeys, parseKiloQuestionPane } from '../engines/kilo/askQuestion.js'
import { parseCursorPermissionPane } from '../engines/cursor/askQuestion.js'
import { parseDevinPermissionPane, parseDevinQuestionPane } from '../engines/devin/askQuestion.js'
import { parseGrokQuestionPane } from '../engines/grok/askQuestion.js'
import { parseAgyQuestionPane } from '../engines/agy/askQuestion.js'

/** Device-facing question shape — byte-for-byte the hosted runtime’s `commanderQuestions()` output. */
export interface ShapedQuestion {
  key: string
  q: string
  options: string[]
  multi: boolean
}

export interface QuestionRow {
  /** The digit to press. */
  number: string
  /** Option text with any `[ ]` checkbox prefix removed. */
  label: string
  checked: boolean
  /**
   * Set only when the dialog does NOT number its rows: the row is then reached by walking to it and
   * pressing Enter, and `number` carries its INDEX rather than a key.
   *
   * The direction is a property of the DIALOG, not of the engine. OpenCode draws BOTH a numbered ask
   * dialog and — for permissions — the horizontal prompt kilo inherited from it, so keying by engine
   * would send digits into a dialog that numbers nothing and select nothing at all.
   */
  walk?: 'right' | 'down'
}

export interface QuestionView {
  kind: 'question'
  question: string
  rows: QuestionRow[]
  multi: boolean
  /** The "Type something." row, when the dialog offers free text. */
  typeRow: QuestionRow | null
}

export interface ReviewView {
  kind: 'review'
  submitRow: string
}

export type PaneView = QuestionView | ReviewView | null

const STEP_MS = 350          // let the TUI repaint between keystrokes
const TEXT_MS = 250
const MAX_STEPS = 14         // hard bound on the drive loop (questions × keys), never spin on a stuck pane
const CAPTURE_LINES = 60

// Rows that exist in every dialog but can never BE an answer.
const CHAT_ROW = /^chat about (this|these)$/i
// Claude writes "Type something.", Command Code "Type something..." — one trailing dot or three, and
// missing it costs the free-text row: a voice answer would have nowhere to go and the row would be
// offered on the device as if it were a real option.
// Claude "Type something.", Command Code "Type something...", OpenCode "Type your own answer", Hermes
// "Other (type your answer)". Same row in every dialog: it opens an editor instead of choosing, so it must
// never be offered to the device as a selectable label.
const TYPE_ROW = /^(type something\.{0,3}|type your own( answer)?|other \(type your (own|answer)\))$/i

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.…]+$/, '').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shape a raw AskUserQuestion input into the device form. Port of the hosted runtime’s `commanderQuestions`
 * (websocket.ts): `key` MUST stay the value the CLI matches answers by — prompt/question first — because
 * the device echoes it back as the answers-map key.
 */
export function shapeQuestions(questions: unknown): ShapedQuestion[] {
  return (Array.isArray(questions) ? questions : []).map((raw, i) => {
    const q = (raw ?? {}) as Record<string, unknown>
    const opts = Array.isArray(q.options) ? q.options : []
    return {
      key: (q.prompt as string) || (q.question as string) || (q.id as string) || (q.header as string) || `question_${i}`,
      q: (q.prompt as string) || (q.question as string) || '',
      options: opts
        .map((o) => String((typeof o === 'string' ? o : (o as Record<string, unknown>)?.label) ?? ''))
        .filter(Boolean),
      // Three spellings because three CLIs: `allow_multiple` (the hosted runtime), `multiSelect` (claude),
      // `multi_select` (devin — read from a real `ask_user_question` call in its SQLite store).
      multi: (q.allow_multiple as boolean) ?? (q.multiSelect as boolean) ?? (q.multi_select as boolean) ?? false,
    }
  })
}

/**
 * The dialog on screen, read the way `engine` paints it.
 *
 * Claude and Command Code share one shape (see parseQuestionPane); devin draws a different one and gets
 * its own parser rather than more branches in here.
 */
export function parseEngineQuestionPane(engine: AgentEngine, capture: string): PaneView {
  // Devin's two dialogs are told apart by one word in the footer (`↵ select` vs `↵ confirm`), so they can
  // never both match. Only one can be on screen anyway: answering either replaces it with a summary line.
  if (engine === 'devin') return parseDevinQuestionPane(capture) ?? parseDevinPermissionPane(capture)
  // Cursor has no ask-the-user tool, so its permission prompt is the ONLY dialog it ever draws — and it
  // numbers nothing, stating each row's key in the row instead.
  if (engine === 'cursor') return parseCursorPermissionPane(capture)
  // Muse pairs each option with a description on the same line and floats a live Preview box above the
  // rows — both confuse the shared parser, so it reads its own. Its PERMISSION prompt is a different
  // dialog entirely (`Would you like to allow this network access?` over `1. Yes, proceed (y)` rows under
  // a `Press enter to confirm` footer, `__fixtures__/permission-muse.txt`) and that one the shared parser
  // reads exactly, so it falls through rather than getting a parser of its own.
  if (engine === 'muse') return parseMuseQuestionPane(capture) ?? parseQuestionPane(capture)
  // Amp's is a permission prompt with unnumbered rows — nothing the shared parser can anchor on.
  if (engine === 'amp') return parseAmpQuestionPane(capture)
  // Kilo's is the same kind of prompt but laid out HORIZONTALLY, sharing its line with the key hints —
  // it is a fork of opencode that did not keep opencode's dialog.
  if (engine === 'kilo') return parseKiloQuestionPane(capture)
  if (engine === 'grok') return parseGrokQuestionPane(capture)
  // agy's ask-the-user dialog anchors on `Question N/M:` under an `↑/↓ Navigate` footer, which the
  // shared parser cannot see. Its PERMISSION prompt is numbered rows under `Do you want to proceed?`
  // and the shared parser reads that one exactly, so it falls through.
  if (engine === 'agy') return parseAgyQuestionPane(capture) ?? parseQuestionPane(capture)
  // Hermes and OpenCode paint Claude's dialog inside a box; peel the border and the shared parser fits.
  if (engine === 'hermes') return parseQuestionPane(unframe(capture))
  if (engine === 'opencode') {
    // OpenCode's PERMISSION prompt is the horizontal one kilo inherited from it — same `△ Permission
    // required` title, same `⇆ select · enter confirm` footer, same unnumbered rows. Measured: the live
    // capture in `permission-opencode.txt` parses through kilo's parser unchanged, so it is shared rather
    // than copied. Tried FIRST because that dialog numbers nothing: the shared parser would still match
    // its `enter confirm` footer and then walk up into whatever numbered rows the scrollback holds.
    const permission = parseKiloQuestionPane(capture)
    if (permission) return permission
    const plain = unframe(capture)
    return opencodeReview(plain) ?? parseQuestionPane(plain)
  }
  return parseQuestionPane(capture)
}

/**
 * Strip the box-drawing frame Hermes draws around its `clarify` dialog.
 *
 * Measured on a live pane: Hermes paints the SAME dialog Claude does — `❯ 1. Xanh` rows, a footer reading
 * `↑/↓ to select, Enter to confirm` — only wrapped in `│ … │`. Peeling the border makes the existing
 * parser fit exactly, which is far better than a second parser that would drift from it over time.
 */
/**
 * OpenCode's final step of a multi-question dialog.
 *
 * It is a REVIEW, not a question: a "Review" heading over `label: answer` lines, with no numbered rows at
 * all, submitted by pressing Enter. The shared parser needs rows to recognise a dialog, so without this
 * the driver saw "nothing on screen", stopped, and left the agent sitting on an unsubmitted form after
 * every answer had been given (measured on a live pane).
 *
 * `submitRow` carries the KEY to press, which for every other CLI happens to be a digit — 'Enter' rides
 * the same field rather than widening the type for one engine.
 */
function opencodeReview(plain: string): ReviewView | null {
  const lines = stripAnsi(plain).split('\n')
  const footer = lines.findLastIndex((l) => /enter\s+submit/i.test(l))
  if (footer < 0) return null
  let sawReview = false
  for (let i = footer - 1; i >= 0 && footer - i <= 14; i--) {
    if (parseRow(lines[i])) return null            // rows above ⇒ still a question, not the review
    if (/^\s*review\s*$/i.test(lines[i])) { sawReview = true; break }
  }
  return sawReview ? { kind: 'review', submitRow: 'Enter' } : null
}

function unframe(capture: string): string {
  // stripAnsi FIRST: on a real capture the border is preceded by SGR codes, so matching `^│` against the
  // raw text silently never fired — hermes read as "no dialog open" with the dialog plainly on screen.
  return stripAnsi(capture)
    .split('\n')
    .map((line) => line.replace(/^(\s*)[│┃|]\s?/, '$1').replace(/\s*[│┃|]\s*$/, ''))
    .join('\n')
}

/** How this engine's multi-select dialog is submitted once the boxes are ticked. */
function multiSubmitKey(engine: AgentEngine): string {
  // Claude advances with Tab; devin submits with Enter (measured on a live pane — Tab does nothing there).
  return engine === 'devin' ? 'Enter' : 'Tab'
}

function parseRow(line: string): QuestionRow | null {
  const m = /^\s*[❯›>]?\s*(\d+)\.\s+(.+?)\s*$/.exec(line)
  if (!m) return null
  const raw = m[2]
  const box = /^\[([^\]])\]\s*(.*)$/.exec(raw)
  return {
    number: m[1],
    label: (box ? box[2] : raw).trim(),
    checked: !!box && box[1].trim() !== '',
  }
}

/**
 * Read the CURRENT dialog off a pane capture. The capture includes scrollback (old dialogs, old plan
 * text), so everything is anchored to the LAST footer line — the only marker the live dialog always
 * paints at the bottom of the screen.
 */
/** "❯ 1. Submit" immediately followed by "2. Cancel" — Command Code's review screen, which carries no
 *  other marker. Returns the Submit row's number and where it sits, or null. */
function findSubmitPair(lines: string[]): { row: string; index: number } | null {
  for (let i = lines.length - 1; i >= 1; i--) {
    const row = parseRow(lines[i])
    if (!row || !/^submit$/i.test(row.label)) continue
    const next = parseRow(lines[i + 1] ?? '')
    if (next && /^cancel$/i.test(next.label)) return { row: row.number, index: i }
  }
  return null
}

/** The tab bar of a footer-less dialog: "● Loại game | ◯ Review". Returns its LAST occurrence, or -1. */
function findTabBarDialog(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!/^[●◯✔✓]/.test(line) || !line.includes('|')) continue   // answered tabs turn into ✔
    // Only a tab bar with a numbered list under it is a question; the same glyphs appear in prose.
    for (let j = i + 1; j < lines.length && j - i <= 8; j++) {
      const row = parseRow(lines[j])
      if (row?.number === '1') return i
    }
  }
  return -1
}

/** Read a dialog that has no footer: question first, then the numbered rows, top-down from the tab bar. */
function parseDownward(lines: string[], tabBar: number): PaneView {
  let question = ''
  const rows: QuestionRow[] = []
  let checkbox = false
  for (let i = tabBar + 1; i < lines.length; i++) {
    const row = parseRow(lines[i])
    if (row) {
      if (/^\s*[❯›>]?\s*\d+\.\s+\[/.test(lines[i])) checkbox = true
      rows.push(row)
      continue
    }
    // Between the tab bar and row 1 sits the question; after the rows start, plain lines are the option
    // descriptions and must not overwrite it.
    const line = lines[i].trim()
    if (!question && rows.length === 0 && line && !/^[─━-]{6,}$/.test(line)) question = line
  }
  if (!rows.length) return null
  const answerable = rows.filter((r) => !CHAT_ROW.test(r.label) && !TYPE_ROW.test(r.label))
  return {
    kind: 'question',
    question,
    rows: answerable,
    multi: checkbox,
    typeRow: rows.find((r) => TYPE_ROW.test(r.label)) ?? null,
  }
}

// \u2500\u2500 permission prompts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A permission prompt is a QUESTION whose options are the approval choices \u2014 the shape amp and kilo
 * already ship (`engines/amp/askQuestion.ts`, `engines/kilo/askQuestion.ts`). It matters far more on a
 * remote machine than a question does: the CLI attaches to an agent the USER started, under the user's
 * own config and with no permission flag of ours (`engines/README.md`), so a blocking approval is the
 * normal state of a pane, not an edge case. Unparsed, the turn simply sits at `Processing` until someone
 * walks to the computer.
 *
 * Claude and Command Code draw it as a framed block ending in numbered rows, and it carries NONE of the
 * three anchors `parseQuestionPane` knows. Captured live (`__fixtures__/permission-claude.txt`):
 *
 *   \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 *    Bash command                                    \u2190 the header: what kind of approval this is
 *
 *      curl -s https://api.coingecko.com/\u2026           \u2190 the argument, then a one-line description
 *      Fetch Bitcoin price from CoinGecko API
 *
 *    This command requires approval
 *
 *    Do you want to proceed?
 *    \u276f 1. Yes
 *      2. Yes, and don\u2019t ask again for: curl *
 *      3. No
 *
 *    Esc to cancel \u00b7 Tab to amend \u00b7 ctrl+e to explain
 *
 * Command Code differs only in wording (`permission-commandcode.txt`): header `Execute Shell Command`,
 * a sentence for the body, footer `\u2191/\u2193 navigate \u00b7 enter select \u00b7 ctrl+e explain`. Same frame, same rows \u2014
 * which is why one parser covers both instead of two near-copies that would drift apart.
 *
 * **The prose is not the anchor.** Every engine words it differently and Claude alone writes at least
 * three ("Do you want to proceed?", "Do you want to make this edit to README.md?", "Do you want to create
 * \u2026?"). The ROWS are: an approval always offers a way to say yes and a way to say no. That pair is the
 * signal, guarded by the dialog's own key hints so an ordinary numbered list in assistant output can never
 * be read as a prompt.
 */

/** The first row of an approval, measured across claude, commandcode, codex, devin, grok, amp and kilo. */
const APPROVE_RE = /^(yes|allow|approve|accept|proceed|run|continue)\b/i
/** \u2026and the row that declines it. Never dropped \u2014 see the rule amp's parser states: a device user given
 *  three ways to say yes and none to say no cannot answer the prompt at all. */
// `skip` is here because cursor's decline row is "Skip & tell the agent what to do instead" — an engine
// whose only way to refuse says neither "no" nor "reject" would otherwise fail the yes/no guard and its
// whole prompt would go unread.
const REJECT_RE = /^(no|reject|deny|decline|cancel|skip|don'?t|stop)\b/i
/** The key hints a permission dialog prints under its rows: claude `Esc to cancel \u00b7 Tab to amend`,
 *  Command Code `\u2191/\u2193 navigate \u00b7 enter select \u00b7 ctrl+e explain`. Proximity to the rows is what makes this
 *  a guard and not a search \u2014 it must sit within a few lines UNDER them. */
const PERMISSION_FOOTER_RE = /\besc\b|enter\s+select|ctrl\+e/i
/** The solid rule that opens the frame. Deliberately NOT the dashed one (`\u254c`) that brackets an edit diff,
 *  which sits BELOW the header and would cost the title. */
const FRAME_RULE_RE = /^\s*[\u2500\u2501\u2550]{6,}\s*$/
/** Any rule, solid or dashed \u2014 used to skip them while reading the frame's contents. */
const ANY_RULE_RE = /^\s*[\u2500\u2501\u2550\u254c\u2504\u2508-]{6,}\s*$/
/** The dialog's own question line, and Command Code's `Press [ctrl+e] \u2026` hint: both sit between the
 *  header and the rows, and neither says what is being approved. */
const PERMISSION_PROSE_RE = /^((do|would) you\b|press \[)/i

/** Keep a synthesised title inside the device's `text[200]` buffer, with the tail marked as cut. */
function clipTitle(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 159)}\u2026`
}

/**
 * What is being approved, as one line: `Approve <header>: <argument>`, the form amp's parser already
 * produces so the two read alike on the device.
 *
 * The frame's opening rule is the only reliable top \u2014 the prose under it varies per engine AND per tool.
 * Below the rule sit the header (`Bash command`, `Edit file`, `Execute Shell Command`) and then the
 * argument: the command, the file, or the sentence naming it.
 */
function permissionTitle(lines: string[], start: number): string {
  let top = -1
  for (let i = start - 1; i >= 0 && start - i <= 25; i--) {
    if (FRAME_RULE_RE.test(lines[i])) { top = i; break }
  }
  // No frame above the rows (codex draws none): the nearest text is the dialog's own question, which
  // names the command outright. Better than inventing a header that is not on screen.
  if (top < 0) {
    for (let i = start - 1; i >= 0 && start - i <= 4; i--) {
      const line = lines[i].trim()
      if (line) return clipTitle(line)
    }
    return 'Approval required'
  }
  let header = ''
  let arg = ''
  for (let i = top + 1; i < start; i++) {
    const line = lines[i].trim()
    if (!line || ANY_RULE_RE.test(line)) continue
    if (!header) { header = line; continue }
    if (PERMISSION_PROSE_RE.test(line)) continue
    arg = line
    break
  }
  if (!header) return 'Approval required'
  return clipTitle(arg ? `Approve ${header}: ${arg}` : `Approve ${header}`)
}

/**
 * The permission prompt on screen, with the index of its first row so the caller can rank it against the
 * other anchors.
 *
 * Only the LOWEST numbered block on the pane is considered, and it is rejected outright if it is not an
 * approval. Digging further up would find an answered prompt in the scrollback and re-announce it \u2014 the
 * live dialog is always the bottom-most thing on screen, so there is nothing below it to miss.
 */
export function parsePermissionPane(lines: string[]): { view: QuestionView; index: number } | null {
  let end = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (parseRow(lines[i])) { end = i; break }
  }
  if (end < 0) return null

  // Walk up through CONTIGUOUS rows to the one numbered 1. Contiguity is the point: a permission dialog
  // never interleaves prose with its options, while assistant output that happens to be numbered does.
  const rows: QuestionRow[] = []
  let start = -1
  for (let i = end; i >= 0 && end - i < 12; i--) {
    const row = parseRow(lines[i])
    if (!row) break
    rows.unshift(row)
    if (row.number === '1') { start = i; break }
  }
  if (start < 0 || rows.length < 2) return null
  if (!APPROVE_RE.test(rows[0].label) || !rows.some((row) => REJECT_RE.test(row.label))) return null

  let hinted = false
  for (let i = end + 1; i < lines.length && i - end <= 4; i++) {
    if (PERMISSION_FOOTER_RE.test(lines[i])) { hinted = true; break }
  }
  if (!hinted) return null

  // Single-select, and no free-text row: every option here is a choice to be TAPPED. Verified on live
  // panes for claude, codex, devin and grok \u2014 one digit selects and submits, exactly as `rowKeys` assumes.
  return {
    view: { kind: 'question', question: permissionTitle(lines, start), rows, multi: false, typeRow: null },
    index: start,
  }
}

export function parseQuestionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  // Each CLI words its own footer, and OpenCode rewords it PER SCREEN — `enter submit` on a single
  // question, `enter toggle` on a multi-select, `enter confirm` on a step of a multi-question. They all
  // mark the same thing: the bottom of a live dialog.
  const footer = lines.findLastIndex((l) => /enter to (select|confirm)|enter\s+(submit|confirm|toggle)/i.test(l))
  // The review screen paints no footer and puts its rows BELOW the prompt, so it needs its own anchor.
  // Whichever anchor is LOWER on screen is the live one (the other is scrollback from an earlier step).
  const review = lines.findLastIndex((l) => /Ready to submit your answers/i.test(l))
  // Command Code's review screen has neither Claude's "Ready to submit your answers" line nor a footer:
  // it is a "Submit"/"Cancel" pair under a summary that is itself numbered. Anchor on that PAIR — the two
  // rows adjacent, in that order — because the summary lines above are numbered too and reading them as
  // options is how the device answered everything and then sat there, never submitting.
  const submit = findSubmitPair(lines)
  // A permission prompt is a FOURTH anchor and gets ranked exactly like the other three: whichever sits
  // lowest on screen is the live dialog. That ordering is what keeps the two apart in both directions —
  // codex and hermes draw an approval whose footer the question anchor also matches, and there the footer
  // is BELOW the rows, so the question path (which reads a better title off the same block) still wins.
  const permission = parsePermissionPane(lines)
  if (permission && permission.index > footer && permission.index > review && permission.index > (submit?.index ?? -1)) {
    return permission.view
  }
  if (review > footer) {
    for (let i = review + 1; i < lines.length && i - review <= 10; i++) {
      const row = parseRow(lines[i])
      if (row && /^submit answers$/i.test(row.label)) return { kind: 'review', submitRow: row.number }
    }
    return null
  }
  if (submit && submit.index > footer) return { kind: 'review', submitRow: submit.row }
  // Command Code paints the SAME dialog with no footer at all — the pane simply ends at the last option.
  // Its tab bar is the only thing above the rows that is unmistakably part of the dialog, so anchor on
  // that and read DOWNWARD. Nothing else on either CLI's screen looks like "● X | ◯ Y" followed by a
  // numbered list, which is what keeps ordinary numbered output from being read as a question.
  const anchor = footer >= 0 ? footer : findTabBarDialog(lines)
  if (anchor < 0) return null
  if (footer < 0) return parseDownward(lines, anchor)

  // Rows belonging to this dialog: the numbered rows just above the footer, back to the row numbered 1.
  const rows: QuestionRow[] = []
  let checkbox = false   // `[ ]` / `[✔]` on a row ⇒ this question is multi-select
  let start = -1
  for (let i = footer - 1; i >= 0 && footer - i <= 40; i--) {
    const row = parseRow(lines[i])
    if (!row) continue
    rows.unshift(row)
    if (/^\s*[❯›>]?\s*\d+\.\s+\[/.test(lines[i])) checkbox = true
    if (row.number === '1') { start = i; break }
  }
  if (start < 0 || rows.length === 0) return null

  // The question is the nearest real text line above the rows. The dialog paints it between its header
  // and its rows — `[tab bar | header chip] · blank · question · blank · rows` — so those, and a rule,
  // are the TOP of this frame. Stop there, never skip past: mid-repaint the question line can be blank
  // for one capture, and walking on would pick up the PREVIOUS question still sitting in scrollback and
  // pair a stale title with the live options. An empty result just means "look again next tick".
  let question = ''
  for (let i = start - 1; i >= 0 && start - i <= 12; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (/[←→]/.test(line) || /^[☐☒✔✓]/.test(line) || /^[─━-]{6,}$/.test(line)) break
    question = line
    break
  }

  const answerable = rows.filter((r) => !CHAT_ROW.test(r.label) && !TYPE_ROW.test(r.label))
  return {
    kind: 'question',
    question,
    rows: answerable,
    multi: checkbox,
    typeRow: rows.find((r) => TYPE_ROW.test(r.label)) ?? null,
  }
}

/** Match an answer to a row. The device stores option labels in an 80-byte buffer, so a long label comes
 *  back truncated — prefix matches count, in both directions. */
/**
 * The keystrokes that commit one row.
 *
 * Every engine but Amp numbers its options, so the digit both selects and submits in one press. Amp
 * draws an unnumbered list navigated with the arrow keys, so its rows carry an index and are reached by
 * walking down to them.
 */
function rowKeys(engine: AgentEngine, row: QuestionRow): string[] {
  if (engine === 'amp') return ampSelectionKeys(row)
  // Kilo's rows sit side by side, so its walk is horizontal — see engines/kilo/askQuestion.ts.
  if (engine === 'kilo') return kiloSelectionKeys(row)
  // Same dialog, different engine: opencode numbers its ask dialog but not its permission prompt, so the
  // ROW says how it is reached and a per-engine rule would break one of the two.
  if (row.walk === 'right') return kiloSelectionKeys(row)
  if (row.walk === 'down') return ampSelectionKeys(row)
  return [row.number]
}

export function matchRow(rows: QuestionRow[], answer: string): QuestionRow | null {
  const a = norm(answer)
  if (!a) return null
  return rows.find((r) => norm(r.label) === a)
    ?? (a.length >= 3 ? rows.find((r) => norm(r.label).startsWith(a)) ?? rows.find((r) => a.startsWith(norm(r.label)) && norm(r.label).length >= 3) : undefined)
    ?? null
}

/** Pick the answer for the question the dialog is currently showing: by its own text, else positionally. */
export function pickAnswer(answers: Record<string, string>, question: string, used: Set<string>): { key: string; value: string } | null {
  const entries = Object.entries(answers)
  const q = norm(question)
  const byText = entries.find(([k]) => norm(k) === q)
    ?? (q.length >= 6 ? entries.find(([k]) => norm(k).startsWith(q) || q.startsWith(norm(k))) : undefined)
  if (byText && !used.has(byText[0])) return { key: byText[0], value: byText[1] }
  const next = entries.find(([k]) => !used.has(k))
  return next ? { key: next[0], value: next[1] } : null
}

export interface AskQuestionDeps {
  getSession: (sessionId: string) => RegisteredSession | undefined
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  sendText: (terminalTarget: string, text: string) => Promise<boolean>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean>
  /** Pins one backend locator for the whole multi-step dialog drive. */
  acquireControl?: (sessionId: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  /** Injected for tests. */
  wait?: (ms: number) => Promise<void>
}

export interface QuestionAnswerPayload {
  requestId?: string
  sessionId?: string
  agentId?: string
  answers?: Record<string, string>
}

/**
 * Owns the OUT side's pending map (requestId → session) and the IN side's pane driving. One answer at a
 * time per agent: a second `question_response` for a dialog already being driven is dropped, not queued.
 */
export class AskQuestionController {
  private pending = new Map<string, string>() // requestId → sessionId
  private driving = new Set<string>()         // sessionIds currently keying a dialog

  constructor(private readonly deps: AskQuestionDeps) {}

  /** Remember which session a mirrored question belongs to (the device may answer minutes later). */
  remember(requestId: string, sessionId: string): void {
    if (!requestId) return
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value as string)
    this.pending.set(requestId, sessionId)
  }

  async answer(payload: QuestionAnswerPayload): Promise<boolean> {
    const requestId = payload.requestId ?? ''
    const sessionId = payload.sessionId || payload.agentId || this.pending.get(requestId) || ''
    const answers = payload.answers && typeof payload.answers === 'object' ? payload.answers : null
    if (!sessionId || !answers || Object.keys(answers).length === 0) {
      console.warn(`[question] ignoring answer with no session/answers (req=${requestId})`)
      return false
    }
    const session = this.deps.getSession(sessionId)
    const terminalTarget = session?.agentId || session?.sessionId
    if (!terminalTarget) {
      console.warn(`[question] no terminal target for ${sessionId.slice(0, 8)} — answer dropped`)
      return false
    }
    if (this.driving.has(sessionId)) {
      console.warn(`[question] ${sessionId.slice(0, 8)} answer dropped · already driving this dialog`)
      return false
    }
    // `forAnswer`: a dialog is the engine waiting for input mid-turn, so the open turn must not block it.
    const release = this.deps.acquireControl?.(terminalTarget, { forAnswer: true })
    // Silence here is the failure mode this whole file exists to prevent: the device sends an answer,
    // nothing keys it in, and the pane sits on the dialog looking like a hung agent.
    if (this.deps.acquireControl && !release) {
      console.warn(`[question] ${sessionId.slice(0, 8)} answer dropped · terminal control unavailable`)
      return false
    }
    this.driving.add(sessionId)
    try {
      const ok = await this.drive(terminalTarget, answers, this.deps.getSession(sessionId)?.engine ?? 'claude')
      this.pending.delete(requestId)
      console.log(`[question] ${sessionId.slice(0, 8)} answered from device · ${ok ? 'submitted' : 'FAILED'}`)
      return ok
    } finally {
      this.driving.delete(sessionId)
      release?.()
    }
  }

  /** Key the answers into the pane's dialog, question by question, ending on the review screen. */
  private async drive(terminalTarget: string, answers: Record<string, string>, engine: AgentEngine): Promise<boolean> {
    const wait = this.deps.wait ?? sleep
    const used = new Set<string>()
    let lastQuestion = ''
    let repeats = 0
    let answered = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      const capture = await this.deps.capture(terminalTarget, CAPTURE_LINES)
      const view = parseEngineQuestionPane(engine, capture ?? '')
      if (!view) {
        // Nothing on screen: either the dialog was never open, or the last keystroke submitted it.
        return answered > 0
      }
      if (view.kind === 'review') {
        return this.deps.sendKey(terminalTarget, view.submitRow)
      }
      // The same question still showing after we acted on it: give the TUI one more beat to repaint,
      // then treat it as stuck rather than hammering the pane with more keystrokes. Never consume a
      // second answer for it.
      if (view.question && view.question === lastQuestion) {
        if (++repeats >= 2) { console.warn(`[question] dialog stuck on "${view.question.slice(0, 60)}"`); return false }
        await wait(STEP_MS)
        continue
      }
      repeats = 0
      lastQuestion = view.question

      // Out of answers with the dialog still up = a multi-QUESTION dialog whose next question the device
      // hasn't been shown yet. Leave it open: the watcher pushes that one and the device answers it next.
      const picked = pickAnswer(answers, view.question, used)
      if (!picked) return answered > 0
      used.add(picked.key)
      answered++

      if (view.multi) {
        // Device joins the selected labels with ", " (q_done_tap).
        const labels = picked.value.split(',').map((s) => s.trim()).filter(Boolean)
        let toggled = 0
        for (const label of labels) {
          const row = matchRow(view.rows, label)
          if (!row || row.checked) continue
          if (!await this.deps.sendKey(terminalTarget, row.number)) return false
          await wait(TEXT_MS)
          toggled++
        }
        if (!toggled && view.typeRow
          && !await this.typeFreeText(terminalTarget, view.typeRow, picked.value, wait)) return false
        if (!await this.deps.sendKey(terminalTarget, multiSubmitKey(engine))) return false // advance to the next question / review
        await wait(STEP_MS)
        continue
      }

      const row = matchRow(view.rows, picked.value)
      if (row) {
        // One digit selects AND submits — except on Amp, whose rows are unnumbered and reached by
        // walking the list, so this is a short sequence rather than a single key.
        for (const key of rowKeys(engine, row)) {
          if (!await this.deps.sendKey(terminalTarget, key)) return false
          await wait(TEXT_MS)
        }
        await wait(STEP_MS)
        continue
      }
      if (!view.typeRow) { console.warn(`[question] no option matched "${picked.value.slice(0, 40)}" and no free-text row`); return false }
      if (!await this.typeFreeText(terminalTarget, view.typeRow, picked.value, wait)) return false
      await wait(STEP_MS)
    }
    return false
  }

  /** True while a dialog is being keyed — the watcher pauses so a half-driven dialog isn't re-announced. */
  isDriving(sessionId: string): boolean {
    return this.driving.has(sessionId)
  }

  /** Free-text answer (a voice answer is always free text): open the "Type something." row, type, Enter. */
  private async typeFreeText(terminalTarget: string, typeRow: QuestionRow, text: string, wait: (ms: number) => Promise<void>): Promise<boolean> {
    if (!await this.deps.sendKey(terminalTarget, typeRow.number)) return false
    await wait(TEXT_MS)
    if (!await this.deps.sendText(terminalTarget, text)) return false
    await wait(TEXT_MS)
    return this.deps.sendKey(terminalTarget, 'Enter')
  }
}

// ── watching a terminal for an open question ─────────────────────────────────────────────────────

export interface QuestionWatcherDeps {
  getSession: (sessionId: string) => RegisteredSession | undefined
  capture: (terminalTarget: string, historyLines?: number) => Promise<string | null>
  /** Skip the capture entirely when no device is listening — nothing would consume the question. */
  hasDevice: () => boolean
  /** A dialog is open on screen. Fires ONCE per distinct question (until it changes or closes). */
  onQuestion: (sessionId: string, requestId: string, questions: ShapedQuestion[]) => void
  /** True while that session's dialog is being keyed by an answer already in flight. */
  isDriving?: (sessionId: string) => boolean
}

const POLL_MS = 1500
// Amp and codex are here for their PERMISSION prompt, not a question tool — neither has one. That prompt
// is drawn only in the pane and recorded nowhere, so polling the pane is the only way it is ever seen.
// Codex needs no parser of its own: it draws numbered rows under a `Press enter to confirm or esc to
// cancel` footer, which is the shared parser's anchor exactly (`__fixtures__/permission-codex.txt`), and
// the question it lands on is the command itself. Membership in this set is what starts the poll, so an
// engine belongs here only once something can actually read its pane.
const QUESTION_ENGINES = new Set<AgentEngine>(['claude', 'commandcode', 'codex', 'cursor', 'devin', 'hermes', 'opencode', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot'])

/** Does this engine ever paint a question dialog? Callers use it to decide whether to watch its pane. */
export function pollsQuestions(engine: AgentEngine): boolean {
  return QUESTION_ENGINES.has(engine)
}

/**
 * The OUT half. The obvious source — the transcript's AskUserQuestion `tool_use` line — is useless here:
 * the CLI does not flush that line until the question has been ANSWERED (its JSONL `timestamp` is the
 * message's creation time, not its write time), so a device would only ever learn about a question after
 * it no longer exists. The dialog itself, on the other hand, is on screen the whole time it is waiting.
 *
 * So while a turn is open we read the pane. This also means the question survives an adapter restart and
 * re-announces to a device that attaches mid-question — neither of which a one-shot event could do.
 */
export class QuestionWatcher {
  private timers = new Map<string, NodeJS.Timeout>()
  private last = new Map<string, string>() // sessionId → fingerprint of the announced question
  private readonly blocked = new Map<string, string>()

  constructor(private readonly deps: QuestionWatcherDeps) {}

  /** Poll this session's pane while its turn is open (called on turn_started). */
  start(sessionId: string): void {
    if (this.timers.has(sessionId)) return
    const session = this.deps.getSession(sessionId)
    // Only the engines that actually paint a question dialog: Claude and Command Code share one shape,
    // devin has its own (parseDevinQuestionPane). Polling any other pane would be pure waste.
    if (!session || session.active === false || !(session.agentId || session.sessionId) || !QUESTION_ENGINES.has(session.engine)) return
    this.timers.set(sessionId, setInterval(() => { void this.tick(sessionId) }, POLL_MS))
  }

  stop(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer) { clearInterval(timer); this.timers.delete(sessionId) }
    this.last.delete(sessionId)
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    this.last.clear()
  }

  /** A device (re)joined: forget what we announced so an open question is pushed again. */
  reset(): void {
    this.last.clear()
  }

  private async tick(sessionId: string): Promise<void> {
    const session = this.deps.getSession(sessionId)
    const terminalTarget = session?.agentId || session?.sessionId
    if (!terminalTarget) { this.stop(sessionId); return }
    // Both of these silently do nothing, which is how a live dialog can sit on the terminal with no trace
    // in the log. Say it once per transition rather than every 1.5s tick.
    const blocked = !this.deps.hasDevice() ? 'no device' : this.deps.isDriving?.(sessionId) ? 'driving an answer' : ''
    if (blocked !== (this.blocked.get(sessionId) ?? '')) {
      this.blocked.set(sessionId, blocked)
      console.log(`[question] ${sessionId.slice(0, 8)} watcher ${blocked ? `paused · ${blocked}` : 'polling'}`)
    }
    if (blocked) return
    const engine = this.deps.getSession(sessionId)?.engine ?? 'claude'
    const view = parseEngineQuestionPane(engine, await this.deps.capture(terminalTarget, CAPTURE_LINES) ?? '')
    if (!view || view.kind !== 'question' || !view.question || view.rows.length === 0) {
      this.last.delete(sessionId) // dialog closed (or moved to review) → the next one announces fresh
      return
    }
    const fingerprint = `${view.question}|${view.rows.map((r) => r.label).join('|')}|${view.multi}`
    if (this.last.get(sessionId) === fingerprint) return
    this.last.set(sessionId, fingerprint)
    // A pane-derived question has no tool_use id. The key only has to round-trip through the device and
    // back (the answer is keyed into the pane, not matched to a tool call), so the question's own text
    // serves as both — and the device dedups a repeated push by this id.
    this.deps.onQuestion(sessionId, `q_${hash(sessionId + fingerprint)}`, [{
      key: view.question,
      q: view.question,
      options: view.rows.map((r) => r.label),
      multi: view.multi,
    }])
  }
}

function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
