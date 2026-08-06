/**
 * AskUserQuestion on a REMOTE machine — mirror the question to the device, then answer it by driving the
 * interactive CLI's own dialog in the tmux pane.
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
import { parseDevinQuestionPane } from '../engines/devin/askQuestion.js'

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
  if (engine === 'devin') return parseDevinQuestionPane(capture)
  // Hermes and OpenCode paint Claude's dialog inside a box; peel the border and the shared parser fits.
  if (engine === 'hermes') return parseQuestionPane(unframe(capture))
  if (engine === 'opencode') {
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

export function parseQuestionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  // Each CLI words its own footer, and OpenCode rewords it PER SCREEN — `enter submit` on a single
  // question, `enter toggle` on a multi-select, `enter confirm` on a step of a multi-question. They all
  // mark the same thing: the bottom of a live dialog.
  const footer = lines.findLastIndex((l) => /enter to (select|confirm)|enter\s+(submit|confirm|toggle)/i.test(l))
  // The review screen paints no footer and puts its rows BELOW the prompt, so it needs its own anchor.
  // Whichever anchor is LOWER on screen is the live one (the other is scrollback from an earlier step).
  const review = lines.findLastIndex((l) => /Ready to submit your answers/i.test(l))
  if (review > footer) {
    for (let i = review + 1; i < lines.length && i - review <= 10; i++) {
      const row = parseRow(lines[i])
      if (row && /^submit answers$/i.test(row.label)) return { kind: 'review', submitRow: row.number }
    }
    return null
  }
  // Command Code's review screen has neither Claude's "Ready to submit your answers" line nor a footer:
  // it is a "Submit"/"Cancel" pair under a summary that is itself numbered. Anchor on that PAIR — the two
  // rows adjacent, in that order — because the summary lines above are numbered too and reading them as
  // options is how the device answered everything and then sat there, never submitting.
  const submit = findSubmitPair(lines)
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
  capture: (pane: string, historyLines?: number) => Promise<string | null>
  sendText: (pane: string, text: string) => Promise<boolean>
  sendKey: (pane: string, key: string) => Promise<boolean>
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
 * time per pane: a second `question_response` for a dialog already being driven is dropped, not queued.
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
    const pane = this.deps.getSession(sessionId)?.tmuxPane
    if (!pane) {
      console.warn(`[question] no tmux pane for ${sessionId.slice(0, 8)} — answer dropped`)
      return false
    }
    if (this.driving.has(sessionId)) return false
    this.driving.add(sessionId)
    try {
      const ok = await this.drive(pane, answers, this.deps.getSession(sessionId)?.engine ?? 'claude')
      this.pending.delete(requestId)
      console.log(`[question] ${sessionId.slice(0, 8)} answered from device · ${ok ? 'submitted' : 'FAILED'}`)
      return ok
    } finally {
      this.driving.delete(sessionId)
    }
  }

  /** Key the answers into the pane's dialog, question by question, ending on the review screen. */
  private async drive(pane: string, answers: Record<string, string>, engine: AgentEngine): Promise<boolean> {
    const wait = this.deps.wait ?? sleep
    const used = new Set<string>()
    let lastQuestion = ''
    let repeats = 0
    let answered = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      const capture = await this.deps.capture(pane, CAPTURE_LINES)
      const view = parseEngineQuestionPane(engine, capture ?? '')
      if (!view) {
        // Nothing on screen: either the dialog was never open, or the last keystroke submitted it.
        return answered > 0
      }
      if (view.kind === 'review') {
        await this.deps.sendKey(pane, view.submitRow)
        return true
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
          await this.deps.sendKey(pane, row.number)
          await wait(TEXT_MS)
          toggled++
        }
        if (!toggled && view.typeRow) await this.typeFreeText(pane, view.typeRow, picked.value, wait)
        await this.deps.sendKey(pane, multiSubmitKey(engine)) // advance to the next question / review
        await wait(STEP_MS)
        continue
      }

      const row = matchRow(view.rows, picked.value)
      if (row) {
        await this.deps.sendKey(pane, row.number) // selects AND submits this question
        await wait(STEP_MS)
        continue
      }
      if (!view.typeRow) { console.warn(`[question] no option matched "${picked.value.slice(0, 40)}" and no free-text row`); return false }
      await this.typeFreeText(pane, view.typeRow, picked.value, wait)
      await wait(STEP_MS)
    }
    return false
  }

  /** True while a dialog is being keyed — the watcher pauses so a half-driven dialog isn't re-announced. */
  isDriving(sessionId: string): boolean {
    return this.driving.has(sessionId)
  }

  /** Free-text answer (a voice answer is always free text): open the "Type something." row, type, Enter. */
  private async typeFreeText(pane: string, typeRow: QuestionRow, text: string, wait: (ms: number) => Promise<void>): Promise<void> {
    await this.deps.sendKey(pane, typeRow.number)
    await wait(TEXT_MS)
    await this.deps.sendText(pane, text)
    await wait(TEXT_MS)
    await this.deps.sendKey(pane, 'Enter')
  }
}

// ── watching a pane for an open question ─────────────────────────────────────────────────────────

export interface QuestionWatcherDeps {
  getSession: (sessionId: string) => RegisteredSession | undefined
  capture: (pane: string, historyLines?: number) => Promise<string | null>
  /** Skip the capture entirely when no device is listening — nothing would consume the question. */
  hasDevice: () => boolean
  /** A dialog is open on screen. Fires ONCE per distinct question (until it changes or closes). */
  onQuestion: (sessionId: string, requestId: string, questions: ShapedQuestion[]) => void
  /** True while that session's dialog is being keyed by an answer already in flight. */
  isDriving?: (sessionId: string) => boolean
}

const POLL_MS = 1500
const QUESTION_ENGINES = new Set<AgentEngine>(['claude', 'commandcode', 'devin', 'hermes', 'opencode'])

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
    if (!session?.tmuxPane || !QUESTION_ENGINES.has(session.engine)) return
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
    const pane = this.deps.getSession(sessionId)?.tmuxPane
    if (!pane) { this.stop(sessionId); return }
    // Both of these silently do nothing, which is how a live dialog can sit on the terminal with no trace
    // in the log. Say it once per transition rather than every 1.5s tick.
    const blocked = !this.deps.hasDevice() ? 'no device' : this.deps.isDriving?.(sessionId) ? 'driving an answer' : ''
    if (blocked !== (this.blocked.get(sessionId) ?? '')) {
      this.blocked.set(sessionId, blocked)
      console.log(`[question] ${sessionId.slice(0, 8)} watcher ${blocked ? `paused · ${blocked}` : 'polling'}`)
    }
    if (blocked) return
    const engine = this.deps.getSession(sessionId)?.engine ?? 'claude'
    const view = parseEngineQuestionPane(engine, await this.deps.capture(pane, CAPTURE_LINES) ?? '')
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
