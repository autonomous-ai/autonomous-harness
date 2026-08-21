import { createHash } from 'crypto'
import type { RegisteredSession } from './registry.js'
import { sid } from './log.js'
import type { TerminalActionResult } from './terminalTypes.js'

const MAX_QUEUE_ITEMS = 8
const MAX_QUEUE_BYTES = 24 * 1024
const ITEM_TTL_MS = 5 * 60_000
const SUBMIT_VERIFY_MS = 1_500
const CLAUDE_SUBMIT_VERIFY_MS = 3_000
// OpenCode's accept signal is the reader's DB poll (~1s) surfacing a new user row → turn_started, so
// give it a slightly longer window than the file-based engines before a retry-Enter.
const OPENCODE_SUBMIT_VERIFY_MS = 2_500
// Kilo is opencode's fork and its user row lands on Enter the same way, read by the same 1s DB poll, so
// it gets the same window. Measured on a live pane: the row is written as the turn opens, not when the
// model replies — so this covers the poll, not model latency (which is Command Code's problem, not this).
const KILO_SUBMIT_VERIFY_MS = 2_500
// Pi has no composer glyph either, and its JSONL is written per completed message — give the derived
// turn_started a comparable window before re-pressing Enter.
const PI_SUBMIT_VERIFY_MS = 2_500
// Hermes' composer glyph (`❯`) is user-skinnable, so it is verified from the DB like opencode/pi. Its
// user row lands at turn start, so the window matches theirs.
const HERMES_SUBMIT_VERIFY_MS = 2_500
// Command Code's composer is a bare `>` (and `/`+`@` open autocompletes that swallow Enter), so it is
// verified from the transcript like opencode/pi/hermes. Unlike them it does not write the user record on
// Enter: the file is flushed per model round-trip, so the record only lands once the first response comes
// back (measured 3.2s on its fastest model). A shorter window fires a spurious retry-Enter on every
// injection and can raise a false "did not accept" — so this window covers model TTFT, not terminal echo.
const COMMANDCODE_SUBMIT_VERIFY_MS = 6_000
// Devin's accept signal is its sessions.db poll (~1s) surfacing the new user row. Unlike Command Code it
// writes that row on Enter rather than when the model round-trip commits (measured: turn_started 1.1s
// after paste), so it needs only the same poll-sized window as opencode/pi/hermes.
const DEVIN_SUBMIT_VERIFY_MS = 2_500
// Muse writes the `started` record as soon as it accepts the prompt, so the transcript answers within
// one poll — same window as the other store-verified engines.
const MUSE_SUBMIT_VERIFY_MS = 6_000
// Amp's plugin writes `turn_start` from the agent.start event, which fires the instant the prompt is
// accepted — no model round trip in between, so the same store-verified window fits.
const AMP_SUBMIT_VERIFY_MS = 6_000
// Grok's FIRST prompt creates the session, runs SessionStart + UserPromptSubmit hooks, then writes the
// user_message_chunk. The isolated real run took ~4.4s from paste to watcher-visible turn start; 2.5s
// pressed Enter a second time on every fresh agent even though the first submission was accepted.
const GROK_SUBMIT_VERIFY_MS = 6_000
// agy's first `PreInvocation` is what clears the fingerprint, and it only fires once the model call
// starts. Measured 3-5s from Enter to the first hook on a warm session; 8s leaves headroom without
// making a genuinely dropped message wait too long for its error.
const AGY_SUBMIT_VERIFY_MS = 8_000
// Copilot's first hook of a turn is `userPromptSubmitted`, which fires as soon as Enter is accepted —
// faster than agy's, which waits for the model call. 6s is the same headroom grok gets.
const COPILOT_SUBMIT_VERIFY_MS = 6_000
const CURSOR_TURN_SETTLE_MS = 750
const SUBMIT_MAX_RETRIES = 2
// Non-cursor engines re-observe the pane (instead of erroring) while an accepted-but-not-yet-started
// prompt is in flight. Bounded so a truly wedged session eventually reverts to the retry/error path.
const SUBMIT_MAX_OBSERVES = 5

interface QueuedInput {
  content: string
  bytes: number
  expiresAt: number
}

interface InputState {
  turnOpen: boolean
  awaitingFingerprint: string | null
  awaitingContent: string | null
  controlLocked: boolean
  settling: boolean
  queue: QueuedInput[]
  timer: NodeJS.Timeout | null
  settleTimer: NodeJS.Timeout | null
  retries: number
  observes: number
  ambiguousDispatch: boolean
}

export interface SessionInputDeps {
  getSession: (sessionId: string) => RegisteredSession | undefined
  validateRuntime: (session: RegisteredSession) => Promise<boolean>
  /** Boolean is retained for direct controller tests and legacy embedders. Production returns dispatch evidence. */
  inject: (terminalTarget: string, content: string) => Promise<boolean | TerminalActionResult>
  sendKey: (terminalTarget: string, key: string) => Promise<boolean | TerminalActionResult>
  capture?: (terminalTarget: string) => Promise<string | null>
  onError: (sessionId: string, message: string) => void
  /**
   * A message was accepted by the pane. Not every engine needs this — most announce the turn
   * themselves — but an engine that only writes its transcript once the turn is OVER has no other
   * moment at which a turn is known to have started, and this one is exact: we sent it.
   */
  onSubmitted?: (sessionId: string, content: string) => void
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** Engine-aware prompt injection. Terminal TUIs get a bounded per-session FIFO while a turn is busy. */
export class SessionInputController {
  private states = new Map<string, InputState>()

  constructor(private readonly deps: SessionInputDeps) {}

  /** Controller dependencies take the stable agent id, never a backend route. */
  private controlSession(id: string): RegisteredSession | undefined {
    return this.deps.getSession(id)
  }

  private state(sessionId: string): InputState {
    let value = this.states.get(sessionId)
    if (!value) {
      value = {
        turnOpen: false,
        awaitingFingerprint: null,
        awaitingContent: null,
        controlLocked: false,
        settling: false,
        queue: [],
        timer: null,
        settleTimer: null,
        retries: 0,
        observes: 0,
        ambiguousDispatch: false,
      }
      this.states.set(sessionId, value)
    }
    return value
  }

  setTurnOpen(sessionId: string, open: boolean): void {
    this.state(sessionId).turnOpen = open
  }

  submit(sessionId: string, content: string): void {
    const session = this.controlSession(sessionId)
    if (!session) { this.deps.onError(sessionId, 'This agent is no longer available.'); return }
    const state = this.state(sessionId)
    this.dropExpired(sessionId, state)
    if (state.controlLocked
      || (session.engine !== 'claude' && (state.turnOpen || state.awaitingFingerprint || state.settling))) {
      console.log(`[inject] ${sid(sessionId)} queued · engine=${session.engine} · depth=${state.queue.length + 1}`)
      this.enqueue(sessionId, state, content)
      return
    }
    void this.inject(sessionId, session, content)
  }

  /** Reserve this pane for a short native control interaction such as `/model`. */
  /**
   * Take the terminal for a write that is not a new message.
   *
   * `forAnswer` exists because an engine's ask-the-user dialog opens INSIDE its turn — claude, agy and
   * every other engine with a question tool — so the `turnOpen` guard, which is there to stop an
   * INJECTED message colliding with a running turn, also blocked the one write that is only ever valid
   * during a turn. Measured on both claude and agy: the device's answer arrived, was refused here, and
   * the pane sat on the dialog looking like a hung agent, with nothing logged.
   *
   * Every other guard still applies: another writer holding the lock, a submit awaiting confirmation, a
   * settling turn, or queued messages all still refuse.
   */
  acquireControl(sessionId: string, opts?: { forAnswer?: boolean }): (() => void) | null {
    const session = this.controlSession(sessionId)
    if (!session) return null
    const state = this.state(sessionId)
    this.dropExpired(sessionId, state)
    const turnBlocks = state.turnOpen && !opts?.forAnswer
    if (state.controlLocked || turnBlocks || state.awaitingFingerprint || state.settling || state.queue.length > 0) return null
    state.controlLocked = true
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.states.get(sessionId)
      if (!current) return
      current.controlLocked = false
      this.drainOne(sessionId, current)
    }
  }

  onTurnStarted(sessionId: string, userMessage: string): void {
    const state = this.state(sessionId)
    if (state.settleTimer) clearTimeout(state.settleTimer)
    state.settleTimer = null
    state.settling = false
    state.turnOpen = true
    // Cursor does not clear its composer when it accepts a prompt: the submitted text stays on the "→"
    // line for the whole turn and long after it, so the terminal reads as if the question is still
    // waiting to be sent. Clearing before the NEXT paste (see inject) stops the two from running
    // together, but leaves that stale copy on screen in the meantime. Drop it as soon as the turn is
    // confirmed started.
    void this.clearCursorEcho(sessionId, userMessage)
    if (state.awaitingFingerprint) {
      const matched = state.awaitingFingerprint === fingerprint(userMessage)
      if (!matched) console.warn(`[inject] ${sessionId.slice(0, 8)} observed a different terminal prompt while awaiting submit`)
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.retries = 0
      state.observes = 0
      state.ambiguousDispatch = false
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
  }

  /**
   * Remove Cursor's leftover copy of a just-submitted prompt from its composer.
   *
   * Guarded by a pane read on purpose: it only sends the clear when the composer still holds the exact
   * text we submitted. A blind C-u here would delete a follow-up the user had already started typing in
   * the terminal during the turn — a small window, but their keystrokes, not ours.
   */
  private async clearCursorEcho(sessionId: string, userMessage: string): Promise<void> {
    const session = this.controlSession(sessionId)
    if (session?.engine !== 'cursor' || !this.deps.capture) return
    try {
      const capture = await this.deps.capture(session.agentId)
      if (!capture || !cursorComposerContains(capture, userMessage)) return
      await this.deps.sendKey(session.agentId, 'C-u')
      console.log(`[inject] ${sid(sessionId)} cleared the echoed prompt from the Cursor composer`)
    } catch {
      /* best-effort cosmetics — never let this break the turn */
    }
  }

  onTurnEnded(sessionId: string): void {
    const state = this.state(sessionId)
    state.turnOpen = false
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = false
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    const session = this.controlSession(sessionId)
    if (session?.engine === 'cursor') {
      // Cursor's stop hook can arrive just before its TUI has returned to the idle composer. A prompt
      // injected in that short window becomes a follow-up; Enter retries then enqueue it repeatedly.
      state.settling = true
      if (state.settleTimer) clearTimeout(state.settleTimer)
      state.settleTimer = setTimeout(() => {
        state.settleTimer = null
        state.settling = false
        this.drainOne(sessionId, state)
      }, CURSOR_TURN_SETTLE_MS)
      return
    }
    this.drainOne(sessionId, state)
  }

  cancel(sessionId: string): void {
    const session = this.controlSession(sessionId)
    if (!session) return
    void this.deps.validateRuntime(session).then(async (valid) => {
      if (!valid) { this.deps.onError(sessionId, 'This agent process is no longer running.'); return }
      await this.deps.sendKey(session.agentId, 'C-c')
      const state = this.state(sessionId)
      state.turnOpen = false
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.ambiguousDispatch = false
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      setTimeout(() => this.drainOne(sessionId, state), 250)
    })
  }

  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state?.timer) clearTimeout(state.timer)
    if (state?.settleTimer) clearTimeout(state.settleTimer)
    this.states.delete(sessionId)
  }

  private async inject(sessionId: string, session: RegisteredSession, content: string): Promise<void> {
    const state = this.state(sessionId)
    if (!(await this.deps.validateRuntime(session))) {
      console.warn(`[inject] ${sid(sessionId)} abort · engine=${session.engine} · process not running`)
      this.deps.onError(sessionId, 'This agent process is no longer running.')
      return
    }
    if (session.engine === 'cursor') {
      // Cursor leaves the previous prompt sitting in its composer after the turn completes — the text is
      // still on the "→" line long after the answer and its recap have arrived. sendToTmux() types into
      // whatever is already there, so the next message is APPENDED to the last one and the pair is
      // submitted as a single run-on prompt:
      //   "…đầu tư dài hạn" + "Có nên mua thêm eth không…"
      // The agent then answers a question nobody asked, and the device shows a recap for it.
      //
      // The adapter already NOTICED this — onTurnStarted logs "observed a different terminal prompt while
      // awaiting submit" when the fingerprint of the started turn does not match what we sent — but it
      // only warned and carried on. Clear the line first so the composer is ours alone.
      //
      // C-u (kill-to-start-of-line) is a no-op on an empty composer, so this costs nothing in the normal
      // case. It does discard a draft a human was typing in the terminal — but pasting into that draft
      // would corrupt it into a run-on prompt anyway, which is worse and harder to notice.
      await this.deps.sendKey(session.agentId, 'C-u')
    }
    const delivery = await this.deps.inject(session.agentId, content)
    const accepted = typeof delivery === 'boolean'
      ? delivery
      : delivery.state === 'succeeded' || delivery.dispatch === 'possibly_executed'
    if (!accepted) {
      console.warn(`[inject] ${sid(sessionId)} paste failed · engine=${session.engine} · target=${session.agentId}`)
      this.deps.onError(sessionId, 'The message could not be delivered to the agent.')
      return
    }
    console.log(`[inject] ${sid(sessionId)} paste ok · engine=${session.engine} · target=${session.agentId} · len=${content.length}`)
    state.awaitingFingerprint = fingerprint(content)
    state.awaitingContent = content
    state.retries = 0
    state.observes = 0
    state.ambiguousDispatch = typeof delivery !== 'boolean' && delivery.dispatch === 'possibly_executed'
    this.deps.onSubmitted?.(sessionId, content)
    this.armSubmitCheck(sessionId, session, state)
  }

  private armSubmitCheck(sessionId: string, session: RegisteredSession, state: InputState): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (!state.awaitingFingerprint || state.turnOpen) return
      void this.retrySubmit(sessionId, session, state)
    }, session.engine === 'claude'
      ? CLAUDE_SUBMIT_VERIFY_MS
      : session.engine === 'opencode'
        ? OPENCODE_SUBMIT_VERIFY_MS
        : session.engine === 'pi'
          ? PI_SUBMIT_VERIFY_MS
          : session.engine === 'hermes'
            ? HERMES_SUBMIT_VERIFY_MS
            : session.engine === 'commandcode'
              ? COMMANDCODE_SUBMIT_VERIFY_MS
              : session.engine === 'devin'
                ? DEVIN_SUBMIT_VERIFY_MS
                : session.engine === 'muse'
                  ? MUSE_SUBMIT_VERIFY_MS
                  : session.engine === 'amp'
                    ? AMP_SUBMIT_VERIFY_MS
                    : session.engine === 'kilo'
                      ? KILO_SUBMIT_VERIFY_MS
                      : session.engine === 'grok'
                        ? GROK_SUBMIT_VERIFY_MS
                        : session.engine === 'agy'
                          ? AGY_SUBMIT_VERIFY_MS
                          : session.engine === 'copilot'
                            ? COPILOT_SUBMIT_VERIFY_MS
                      : SUBMIT_VERIFY_MS)
  }

  private async retrySubmit(sessionId: string, session: RegisteredSession, state: InputState): Promise<void> {
    if (session.engine === 'cursor') {
      const capture = await this.deps.capture?.(session.agentId)
      if (!state.awaitingFingerprint || state.turnOpen) return
      const draftPending = !!capture && cursorComposerContains(capture, state.awaitingContent ?? '')
      if (state.ambiguousDispatch && !draftPending) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
      if (capture && cursorSubmissionAccepted(capture, state.awaitingContent ?? '')) {
        // The transcript hook can trail the TUI by a moment. Observe again without pressing Enter:
        // another Enter here would duplicate a running/queued follow-up.
        this.armSubmitCheck(sessionId, session, state)
        return
      }
      if (!draftPending) {
        console.warn(`[inject] ${sid(sessionId)} not accepted · engine=cursor · composer clear of draft`)
        state.awaitingFingerprint = null
        state.awaitingContent = null
        this.deps.onError(sessionId, 'The agent did not accept the message. Please try again.')
        return
      }
    } else if (session.engine === 'opencode' || session.engine === 'kilo' || session.engine === 'pi' || session.engine === 'hermes' || session.engine === 'muse'
      || session.engine === 'amp' || session.engine === 'grok' || session.engine === 'agy' || session.engine === 'copilot') {
      // OpenCode has no composer glyph, and the submitted text stays visible in the message area, so a
      // pane scrape can't tell "still in the composer" from "already sent". Rely purely on the reader-
      // derived turn_started (a new user row in opencode.db) to clear awaitingFingerprint; if it hasn't
      // arrived yet, fall through to a bounded retry-Enter, then error.
      if (!state.awaitingFingerprint || state.turnOpen) return
      if (state.ambiguousDispatch) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
    } else {
      // claude/codex/commandcode: verify against the terminal before pressing Enter again or declaring failure.
      const capture = await this.deps.capture?.(session.agentId)
      if (!state.awaitingFingerprint || state.turnOpen) return
      // Command Code writes the user line to its transcript only once the model has finished THINKING, so
      // the turn_started this used to wait for can be half a minute late on a real task — and the user
      // watched the terminal accept the message and start working while the device claimed it had been
      // refused. The pane says so immediately: a running turn shows "esc to interrupt". Treat that as the
      // acceptance it is, rather than timing out into an error the user can see is false.
      if (capture && session.engine === 'commandcode' && /esc to interrupt/i.test(visibleTerminal(capture))) {
        console.log(`[inject] ${sid(sessionId)} accepted (agent working) · engine=commandcode`)
        state.awaitingFingerprint = null
        state.awaitingContent = null
        state.observes = 0
        state.ambiguousDispatch = false
        return
      }
      if (capture && !terminalComposerContains(capture, state.awaitingContent ?? '')) {
        // Submitted, or queued by the TUI as a follow-up while busy. A real turn_started will confirm
        // and clear this; keep observing (bounded) WITHOUT pressing Enter — a second Enter could
        // double-submit a queued follow-up — and WITHOUT a spurious error.
        if (state.observes < SUBMIT_MAX_OBSERVES) {
          state.observes++
          console.log(`[inject] ${sid(sessionId)} accepted (queued/submitted) · engine=${session.engine} · observe=${state.observes}/${SUBMIT_MAX_OBSERVES}`)
          this.armSubmitCheck(sessionId, session, state)
          return
        }
        // An ambiguous dispatch with no visible draft still may have run. It can never justify Enter.
        if (state.ambiguousDispatch) {
          this.failAmbiguousSubmission(sessionId, state)
          return
        }
        // Pathological: accepted-looking but no turn opened for a while → fall through to retry/error.
      }
      // capture === null (dep missing / unreadable) → fall through to today's blind retry/error so a
      // real delivery failure is never hidden.
      if (!capture && state.ambiguousDispatch) {
        this.failAmbiguousSubmission(sessionId, state)
        return
      }
    }
    if (state.retries >= SUBMIT_MAX_RETRIES) {
      console.warn(`[inject] ${sid(sessionId)} not accepted · engine=${session.engine} · gave up after ${state.retries} retries`)
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.ambiguousDispatch = false
      this.deps.onError(sessionId, 'The agent did not accept the message. Please try again.')
      return
    }
    state.retries++
    console.log(`[inject] ${sid(sessionId)} resubmit Enter · engine=${session.engine} · retry=${state.retries}/${SUBMIT_MAX_RETRIES}`)
    const valid = await this.deps.validateRuntime(session)
    if (!valid) {
      state.awaitingFingerprint = null
      state.awaitingContent = null
      state.ambiguousDispatch = false
      this.deps.onError(sessionId, 'This agent process is no longer running.')
      return
    }
    // Only the submit key is retried. The prompt body is never pasted twice.
    const delivery = await this.deps.sendKey(session.agentId, 'Enter')
    state.ambiguousDispatch = typeof delivery === 'boolean'
      ? !delivery
      : delivery.dispatch === 'possibly_executed'
    this.armSubmitCheck(sessionId, session, state)
  }

  private failAmbiguousSubmission(sessionId: string, state: InputState): void {
    state.awaitingFingerprint = null
    state.awaitingContent = null
    state.ambiguousDispatch = false
    this.deps.onError(sessionId, 'The message delivery could not be confirmed. Check the agent before trying again.')
  }

  private drainOne(sessionId: string, state: InputState): void {
    this.dropExpired(sessionId, state)
    if (state.controlLocked || state.turnOpen || state.awaitingFingerprint || state.settling) return
    const next = state.queue.shift()
    if (!next) return
    const session = this.controlSession(sessionId)
    if (!session) { this.deps.onError(sessionId, 'This agent is no longer available.'); return }
    void this.inject(sessionId, session, next.content)
  }

  private enqueue(sessionId: string, state: InputState, content: string): void {
    const bytes = Buffer.byteLength(content, 'utf8')
    const queuedBytes = state.queue.reduce((sum, item) => sum + item.bytes, 0)
    if (state.queue.length >= MAX_QUEUE_ITEMS || queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.deps.onError(sessionId, 'This agent already has too many queued messages. Try again after the current operation finishes.')
      return
    }
    state.queue.push({ content, bytes, expiresAt: Date.now() + ITEM_TTL_MS })
  }

  private dropExpired(sessionId: string, state: InputState): void {
    const before = state.queue.length
    const now = Date.now()
    state.queue = state.queue.filter((item) => item.expiresAt > now)
    if (state.queue.length < before) this.deps.onError(sessionId, 'A queued message expired before the agent became available.')
  }
}

function visibleTerminal(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function normalizedTerminalText(value: string): string {
  return visibleTerminal(value).replace(/\s+/g, ' ').trim()
}

// Composer region = from the last prompt-marker line to the end (mirrors runtimeProfile.currentPaneUi,
// kept local so sessionInput stays decoupled). Marker set covers claude ❯, codex ›, cursor →.
function composerRegion(capture: string): string {
  const lines = visibleTerminal(capture).split('\n')
  const idx = lines.findLastIndex((line) => {
    const marker = line.search(/[›❯→]/u)
    return marker >= 0 && !/^\s*\d+\.\s/.test(line.slice(marker + 1))
  })
  return (idx >= 0 ? lines.slice(idx) : lines).join('\n') // no marker → whole pane (safe fallback)
}

/** True while the injected prompt is still sitting un-submitted in the terminal composer. */
function terminalComposerContains(capture: string, content: string): boolean {
  const expected = normalizedTerminalText(content)
  return !!expected && normalizedTerminalText(composerRegion(capture)).includes(expected)
}

function cursorComposerContains(capture: string, content: string): boolean {
  const visible = visibleTerminal(capture)
  const marker = visible.lastIndexOf('→')
  if (marker < 0) return false
  const expected = normalizedTerminalText(content)
  return !!expected && normalizedTerminalText(visible.slice(marker + 1)).includes(expected)
}

function cursorSubmissionAccepted(capture: string, content: string): boolean {
  const visible = visibleTerminal(capture)
  if (/\bfollow-ups\b/i.test(visible)) return true
  if (/\b(?:Working|Running subagent|Thinking)\b/i.test(visible)) return true
  return !cursorComposerContains(visible, content)
}
