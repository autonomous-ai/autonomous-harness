/**
 * CommanderMirror — derives the paired hardware device's `commander_event` stream from the same LiveEvent
 * stream the web receives, and produces the per-turn RECAP the way the hosted runtime does:
 *
 *   turn_started            → {kind:'processing'}                    (tile busy)
 *   tool_start              → {kind:'tool', text, recap, color, detail}
 *   tool_start TodoWrite    → + {kind:'processing', todos:[{c,s}]}   (checklist)
 *   tool_start Task/Agent   → + {kind:'agents', agents:[{text,color}]} (live sub-agent list)
 *   subagent_finished       → + {kind:'agents', …} with that row ticked off
 *   turn_ended (device on)  → {kind:'processing', text:'Summarizing…'} then, once the LLM one-shot
 *                             returns, {kind:'summary', text:body, recap} (persisted per session)
 *   turn_ended (no device)  → nothing (device-gated; the summary map is left untouched)
 *   turn_ended (empty text) → {kind:'done'}                          (clear busy)
 *
 * Every frame carries top-level `agentId` + `dbSessionId` (= the tmux session id). The recap
 * (`summarizeTurnText`) is injected so it's unit-testable with a stub. Mirrors the hosted runtime's
 * device-gated recap (recap.ts / manager.ts triggerTurnRecap / websocket.ts handleBrainSummaryEvent).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LastTurnText, LiveEvent } from './normalize.js'

export type CommanderFrame = {
  type: 'commander_event'
  agentId: string
  dbSessionId: string
  payload: Record<string, unknown>
}

export interface CommanderMirrorOpts {
  /** Device-audience frame (commander_event cards). */
  send: (frame: CommanderFrame) => void
  /** Web-audience frame (turn_summary_pending / turn_summary — the "Summarizing…" indicator). */
  sendWeb: (frame: Record<string, unknown>) => void
  hasDevice: () => boolean
  /** True while a device is ACTIVELY rendering this machine (vs attached-but-background under multi-attach).
   *  Gates the live turn-card STREAM; the turn-done `summary` card ignores it so a background machine still
   *  badges. Omitted → defaults to hasDevice (single-machine firmware: attached == active, streams as before). */
  active?: () => boolean
  summarize: (text: string, signal?: AbortSignal, userMessage?: string, sessionId?: string) => Promise<string | null>
  /** Agent display name for a sessionId — rides the summary's outer frame so a BACKGROUND machine's device
   *  notification shows the agent name on line 2 (its tile isn't loaded). */
  nameFor?: (sessionId: string) => string | undefined
  readLastTurn?: (sessionId: string) => Promise<LastTurnText | null>
  /** Engine session id → the AGENT that owns it. Frames are addressed to the agent (stable across a
   *  `/clear` rotation); `dbSessionId` stays the engine session, which is what the device echoes back to
   *  cancel a turn and what the backend keys its voice queue on. */
  agentIdFor?: (sessionId: string) => string | undefined
  dataDir: string
  recapForce?: boolean
}

interface SessionState {
  lastAssistantText: string
  /** The user's prompt for the current turn (from turn_started) — fed to the recap so it leads with
   *  the direct answer to what was asked. */
  lastUserMessage: string
  turnOpen: boolean
  /** Has a turn_started ever been seen for this session? Separates the normal duplicate-close
   *  (watcher and Stop hook race, every turn) from a close whose turn was never opened at all. */
  everOpened: boolean
  summarizing: boolean
  lastTool: Record<string, unknown> | null
  lastTodos: Array<{ c: string; s: string }> | null
  /** Sub-agents this turn spawned, in the order they started — the device's list above "Working…". */
  agents: Array<{ id: string; desc: string; startedAt: number; doneMs: number | null; carried?: true }>
  /** A turn_ended is being HELD because sub-agents this turn spawned are still running (see below). */
  endPending: boolean
  /** Fires the held turn-end once the last sub-agent has finished AND the wrap-up text has stopped. */
  endSettle: NodeJS.Timeout | null
  /** Backstop: a sub-agent that never reports back must not cost the turn its recap. */
  endDeadline: NodeJS.Timeout | null
  abort: AbortController | null
}

interface TodoInput {
  todos?: Array<{ content?: string; subject?: string; status?: string }>
}

const MAX_PART = 2000

// Stable per-tool colors (device renders the tool name in this color); hash fallback for others.
const TOOL_COLORS: Record<string, string> = {
  Bash: '#e5c07b', Read: '#61afef', Write: '#98c379', Edit: '#98c379', Glob: '#c678dd',
  Grep: '#c678dd', WebFetch: '#56b6c2', WebSearch: '#56b6c2', Task: '#d19a66', Agent: '#d19a66',
  TodoWrite: '#5b8def',
}
const PALETTE = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d19a66']

export function toolColor(name: string): string {
  const hit = TOOL_COLORS[name]
  if (hit) return hit
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

const PRIMARY_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt', 'content']

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function primaryArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of PRIMARY_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return truncate(v.replace(/\s+/g, ' ').trim(), 60)
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return truncate(v.replace(/\s+/g, ' ').trim(), 60)
  }
  return ''
}

function compactArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) parts.push(`${k}: ${v.replace(/\s+/g, ' ').trim()}`)
    if (parts.join(' · ').length > 200) break
  }
  return truncate(parts.join(' · '), 200)
}

/**
 * What counts as a sub-agent.
 *
 * Every engine's own name is mapped to `Task` by its normalizer — EXCEPT claude, whose own tool is called
 * `Agent` and passes through unmapped. Watching only for `Task` therefore missed the one engine this
 * feature is modelled on; measured on a live claude turn, whose transcript names the tool `Agent`.
 */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

/** Running = orange, finished = green. The device just paints the colour it is handed. */
const AGENT_RUNNING_COLOR = '#ff9d00'
const AGENT_DONE_COLOR = '#3ddc84'

/**
 * Claude's async `Agent` tool answers its own tool_use in ~4ms with this line — a LAUNCH ACK, not a
 * result (measured: `dur= undefined out= Async agent launched successfully.`). Ticking the row off on it
 * showed every sub-agent as finished the instant it started. The real finish is `subagent_finished`.
 */
const ASYNC_LAUNCH_ACK = /Async agent launched successfully/i

/**
 * After the last sub-agent reports in, the engine still writes its wrap-up ("Cả 2 sub-agent đã hoàn thành:
 * …"). How long that takes is a model round-trip, not a constant — measured at 3s, 7s and 10.8s on three
 * consecutive runs, so any fixed window is a coin flip (the 10s one lost by 0.85s).
 *
 * So the timer is only a backstop for "nothing more is coming". The two real signals are the Stop hook
 * (`noteEngineStopped`, exact) and the wrap-up text itself landing — after which a short debounce is
 * enough, because the text we were waiting for is already in hand.
 */
const SUBAGENT_SETTLE_MS = 12_000
const SUBAGENT_TEXT_SETTLE_MS = 2_000
/** A sub-agent that never reports back must not cost the turn its recap forever. */
const SUBAGENT_MAX_WAIT_MS = 10 * 60_000

/**
 * The device renders ONE line per sub-agent and does no formatting of its own: `› desc` while it runs,
 * `✓ desc · 12s` once it finishes, in the colour we pick (`ui_project_set_agents`). It also scrolls the
 * `›` row into view, so that prefix is load-bearing, not decoration.
 */
function agentRows(agents: SessionState['agents']): Array<{ text: string; color: string }> {
  return agents.map((a) => (a.doneMs === null
    ? { text: `› ${a.desc}`, color: AGENT_RUNNING_COLOR }
    : { text: `✓ ${a.desc} · ${Math.max(1, Math.round(a.doneMs / 1000))}s`, color: AGENT_DONE_COLOR }))
}

/**
 * Does this row's sub-agent gate THIS turn's recap? Only one that started during it.
 *
 * Rows survive a turn boundary while they run (cursor announces a Task before its turn opens; claude's
 * async agents outlive the turn that spawned them), so they stay on screen — but an agent spawned two
 * prompts ago must not hold the answer to the question just asked: that could park a recap for the full
 * 10-minute backstop with nothing on the device to explain the wait.
 */
function holdsTurn(a: SessionState['agents'][number]): boolean {
  return a.doneMs === null && !a.carried
}

/** Split a persisted "recap\n\nbody" into its parts (mirror websocket.ts:540 / getRecentEvents). */
function splitSummary(summary: string): { recap: string; body: string } {
  const nl = summary.indexOf('\n\n')
  const recap = (nl >= 0 ? summary.slice(0, nl) : summary).replace(/\s+/g, ' ').trim().slice(0, MAX_PART)
  const body = (nl >= 0 ? summary.slice(nl + 2) : summary).replace(/\s+/g, ' ').trim().slice(0, MAX_PART)
  return { recap, body }
}

export class CommanderMirror {
  private states = new Map<string, SessionState>()
  private summaries = new Map<string, string>() // sessionId → "recap\n\nbody"
  private file: string
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private opts: CommanderMirrorOpts) {
    this.file = join(opts.dataDir, 'summaries.json')
    this.load()
  }

  private stateFor(sessionId: string): SessionState {
    let st = this.states.get(sessionId)
    if (!st) {
      st = { lastAssistantText: '', lastUserMessage: '', turnOpen: false, everOpened: false, summarizing: false, lastTool: null, lastTodos: null, agents: [], endPending: false, endSettle: null, endDeadline: null, abort: null }
      this.states.set(sessionId, st)
    }
    return st
  }

  private emit(sessionId: string, payload: Record<string, unknown>): void {
    // Bandwidth gate (mirrors the hosted runtime’s emitCommanderEvent empty-pool early-return): with no device
    // connected every card would ride adapter→backend just to be dropped by deliverUpLocal. Gate the
    // SEND only — ingest() keeps folding state (lastTool/lastTodos/lastAssistantText) regardless, so a
    // device joining mid-turn still gets a correct replay (onCommanderJoin) and turn-end recap.
    if (!this.opts.hasDevice() && !this.opts.recapForce) return
    // Multi-attach: the turn-done `summary` card reaches ANY connected commander (a BACKGROUND machine badges
    // from it). Streaming cards (processing/tool/todos/done) reach only the ACTIVELY-rendered machine — a
    // background machine gets just its summary, not the live stream. Single-machine firmware defaults active to
    // hasDevice, so attached == active and everything streams exactly like before.
    const terminal = payload.kind === 'summary'
    const active = this.opts.active ? this.opts.active() : this.opts.hasDevice()
    if (!terminal && !active && !this.opts.recapForce) return
    // Agent name on the summary's outer frame → background-machine device notif line 2 (see nameFor).
    const name = terminal && this.opts.nameFor ? this.opts.nameFor(sessionId) : undefined
    this.opts.send({ type: 'commander_event', agentId: this.opts.agentIdFor?.(sessionId) ?? sessionId, dbSessionId: sessionId, ...(name ? { name } : {}), payload })
  }

  /** Recap diagnostics stay in the adapter log; the web only gets summary pending/done state. */
  private trace(_sessionId: string, line: string, isError = false): void {
    ;(isError ? console.error : console.log)(`[recap] ${line}`)
  }

  /** Fold one session's LiveEvents into device commander_event frames (live cards + async recap). */
  ingest(events: LiveEvent[], sessionId: string): void {
    const st = this.stateFor(sessionId)
    for (const e of events) {
      switch (e.type) {
        case 'turn_started':
          st.abort?.abort() // supersede any in-flight recap from the previous turn
          st.abort = null
          // A new prompt supersedes a held turn-end outright: its sub-agents belong to the turn the user
          // has just moved on from, and the recap they were holding is now stale.
          this.clearEndTimers(st)
          st.endPending = false
          st.summarizing = false
          st.lastAssistantText = ''
          st.lastUserMessage = e.payload.userMessage || ''
          st.turnOpen = true
          st.everOpened = true
          st.lastTool = null
          st.lastTodos = null
          // Drop the previous turn's finished rows, KEEP the ones still running. Two reasons, both
          // measured: cursor's tool-start HOOK beats its transcript-derived turn_started by ~60ms, so a
          // blanket reset deleted the sub-agent that had just been announced (two Tasks collapsed into
          // one row, live); and a claude async sub-agent genuinely outlives the turn that spawned it, so
          // a new prompt does not make it stop running. Anything past the wait cap is abandoned.
          const hadAgents = st.agents.length > 0
          st.agents = st.agents
            .filter((a) => a.doneMs === null && Date.now() - a.startedAt < SUBAGENT_MAX_WAIT_MS)
            .map((a) => ({ ...a, carried: true as const }))
          this.emit(sessionId, { kind: 'processing', text: 'Processing' })
          // Push the new list only when there WAS one: an empty array CLEARS the device's list
          // (ui_project_set_agents deletes the box when the array is empty), which is what stops last
          // turn's rows hanging around — but a turn that never had sub-agents has nothing to clear.
          if (hadAgents) this.emit(sessionId, { kind: 'agents', agents: agentRows(st.agents) })
          break

        case 'text_delta':
          st.lastAssistantText += e.payload.content
          // The wrap-up text landed while the turn-end was held: this IS what the hold was waiting for,
          // so drop to a short debounce (more blocks of the same message may still follow).
          if (st.endSettle) this.armSettle(sessionId, st, SUBAGENT_TEXT_SETTLE_MS)
          break

        case 'tool_start': {
          const tool = e.payload.tool || 'Tool'
          // AskUserQuestion is not a tool card — it's a question the user answers on the device's question
          // screen (QuestionWatcher pushes it live off the pane). By the time this line reaches the
          // transcript the CLI has already been answered, so there is nothing left to show: drop it.
          if (tool === 'AskUserQuestion') break
          const toolPayload = {
            kind: 'tool',
            text: tool,
            recap: primaryArg(e.payload.input),
            color: toolColor(tool),
            detail: compactArgs(e.payload.input),
          }
          st.lastTool = toolPayload
          this.emit(sessionId, toolPayload)
          // A sub-agent is not just a card: the device keeps a live LIST of them above "Working…", which
          // nothing ever fed — the firmware has been able to render it since it shipped, and never got data.
          if (SUBAGENT_TOOLS.has(tool)) {
            const id = String(e.payload.id ?? `task-${st.agents.length}`)
            const desc = primaryArg(e.payload.input) || 'sub-agent'
            if (!st.agents.some((a) => a.id === id)) st.agents.push({ id, desc, startedAt: Date.now(), doneMs: null })
            this.emit(sessionId, { kind: 'agents', agents: agentRows(st.agents) })
            const running = st.agents.filter((a) => a.doneMs === null).length
            console.log(`[subagents] ${sessionId.slice(0, 8)} ${running}/${st.agents.length} running · "${desc.slice(0, 40)}"`)
          }
          if (tool === 'TodoWrite') {
            const todos = (e.payload.input as TodoInput | undefined)?.todos
            if (Array.isArray(todos)) {
              const mapped = todos.map((t) => ({ c: t?.content ?? t?.subject ?? '', s: t?.status ?? 'pending' }))
              st.lastTodos = mapped
              this.emit(sessionId, { kind: 'processing', text: 'Processing', todos: mapped })
            }
          }
          break
        }

        case 'turn_ended':
          // A killed turn takes the cancel path, not the recap path: clear the tile and stay silent. There
          // is nothing to summarize, and a beep for output the user just threw away is worse than nothing.
          if (e.payload.aborted) {
            this.clearEndTimers(st)
            st.endPending = false
            this.cancel(sessionId)
          } else if (st.agents.some(holdsTurn)) {
            // Async sub-agents outlive the turn that spawned them: claude says "đã spawn 3 sub-agent" and
            // ENDS the turn while all three are still working. Recapping there summarized the launch
            // message and dropped the tile out of busy — the answer the user was waiting for arrived
            // afterwards with nothing left to show it. Hold the end until the last one reports in.
            this.holdTurnEnd(sessionId, st)
          } else this.onTurnEnded(sessionId, st)
          break

        case 'tool_end': {
          // Only sub-agents are tracked here; every other tool_end stays web-only.
          const done = st.agents.find((a) => a.id === String(e.payload.id))
          if (!done || done.doneMs !== null) break
          // An async launch ack is not a finish — that one arrives later as `subagent_finished`.
          if (ASYNC_LAUNCH_ACK.test(e.payload.output || '')) break
          done.doneMs = e.payload.durationSeconds ? e.payload.durationSeconds * 1000 : Date.now() - done.startedAt
          this.emit(sessionId, { kind: 'agents', agents: agentRows(st.agents) })
          this.onSubagentDone(sessionId, st, done.desc)
          break
        }

        case 'subagent_finished': {
          const done = st.agents.find((a) => a.id === e.payload.id)
          if (!done || done.doneMs !== null) break
          done.doneMs = Date.now() - done.startedAt
          this.emit(sessionId, { kind: 'agents', agents: agentRows(st.agents) })
          this.onSubagentDone(sessionId, st, done.desc)
          break
        }

        default:
          break // thinking/user_message — web-only
      }
    }
  }

  private clearEndTimers(st: SessionState): void {
    if (st.endSettle) clearTimeout(st.endSettle)
    if (st.endDeadline) clearTimeout(st.endDeadline)
    st.endSettle = null
    st.endDeadline = null
  }

  /**
   * The turn closed with sub-agents still running. Keep `turnOpen` true (so the eventual recap takes the
   * normal path) and the device tile busy — it stays on `Processing` with the live sub-agent list until a
   * `done`/`summary` card arrives, which is exactly the state we want it in.
   */
  private holdTurnEnd(sessionId: string, st: SessionState): void {
    if (st.endPending) return
    st.endPending = true
    const running = st.agents.filter(holdsTurn).length
    console.log(`[subagents] ${sessionId.slice(0, 8)} turn-end HELD · ${running} sub-agent(s) still running`)
    this.clearEndTimers(st)
    st.endDeadline = setTimeout(() => {
      const stuck = st.agents.filter(holdsTurn).map((a) => a.desc).join(', ')
      console.log(`[subagents] ${sessionId.slice(0, 8)} turn-end RELEASED by timeout · still running: ${stuck}`)
      this.releaseTurnEnd(sessionId, st)
    }, SUBAGENT_MAX_WAIT_MS)
    st.endDeadline.unref?.()
  }

  /**
   * The engine stopped writing (its Stop hook fired). If a turn-end is held and every sub-agent has
   * reported in, the wrap-up is written — but not necessarily FLUSHED: measured, the hook beat the
   * transcript line by ~200ms and an immediate release recapped the stale text (153 chars on disk, 1233
   * a moment later). So this closes the window rather than releasing outright; the wrap-up landing
   * re-arms it once more, and the recap reads a complete file either way.
   *
   * A stop while sub-agents are still running is just the launch ack's own stop: keep holding.
   */
  noteEngineStopped(sessionId: string): void {
    const st = this.states.get(sessionId)
    if (!st?.endPending) return
    if (st.agents.some(holdsTurn)) return
    console.log(`[subagents] ${sessionId.slice(0, 8)} turn-end settling after Stop hook`)
    this.armSettle(sessionId, st, SUBAGENT_TEXT_SETTLE_MS)
  }

  /** A sub-agent finished: log it, and if it was the last one, let the held turn-end go through. */
  private onSubagentDone(sessionId: string, st: SessionState, desc: string): void {
    const running = st.agents.filter(holdsTurn).length
    console.log(`[subagents] ${sessionId.slice(0, 8)} ${running}/${st.agents.length} still running · done "${desc.slice(0, 40)}"`)
    if (!st.endPending || running > 0) return
    this.armSettle(sessionId, st)
  }

  private armSettle(sessionId: string, st: SessionState, ms = SUBAGENT_SETTLE_MS): void {
    if (st.endSettle) clearTimeout(st.endSettle)
    st.endSettle = setTimeout(() => this.releaseTurnEnd(sessionId, st), ms)
    st.endSettle.unref?.()
  }

  private releaseTurnEnd(sessionId: string, st: SessionState): void {
    if (!st.endPending) return
    this.clearEndTimers(st)
    st.endPending = false
    this.onTurnEnded(sessionId, st)
  }

  private onTurnEnded(sessionId: string, st: SessionState): void {
    // ONE recap per turn. The same turn can close from two independent sources that race — the watcher
    // parsing the `end_turn` line, and the Claude Stop hook force-closing — each emitting `turn_ended`.
    // A real close always follows a `turn_started` (which set turnOpen=true); a duplicate close finds
    // turnOpen already false → skip, so the second source can't trigger (or supersede) a second recap.
    if (!st.turnOpen) {
      // A close for a session that never opened a turn is NOT the dedup case: the turn ran and its
      // recap is being dropped. That used to return in silence, which is why a whole turn could go
      // missing on the device with nothing in this log to explain it.
      if (!st.everOpened) {
        this.trace(
          sessionId,
          `${sessionId.slice(0, 8)} turn-end · DROPPED (no turn_started was ever seen for this session — ` +
            `the turn opened before the session was attached), no recap for this turn`,
          true,
        )
      }
      return
    }
    const fallbackText = st.lastAssistantText.trim()
    const fallbackUserMessage = st.lastUserMessage
    st.turnOpen = false
    st.lastTool = null
    st.lastTodos = null
    st.lastAssistantText = ''

    const sid = sessionId.slice(0, 8)
    const device = this.opts.hasDevice()

    // Device-gated: only run the (costly) LLM recap while a device is connected (mirrors the hosted runtime's
    // isDeviceConnected()). No device → no card, and the summaries map is left untouched.
    if (!device && !this.opts.recapForce) {
      // Console-only: no device means no recap flow to watch.
      console.log(`[recap] ${sid} turn-end · SKIP (no device connected) · textLen=${fallbackText.length}`)
      return
    }

    st.abort?.abort()
    const ac = new AbortController()
    st.abort = ac
    st.summarizing = true
    const t0 = Date.now()

    void this.resolveTurnText(sessionId, fallbackText, fallbackUserMessage)
      .then(({ text, userMessage, source }) => {
        if (ac.signal.aborted) return
        this.startSummary(sessionId, st, ac, t0, sid, text, userMessage, device, source)
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        this.trace(sessionId, `${sid} JSON session read failed: ${err instanceof Error ? err.message : String(err)} — using live buffer`, true)
        this.startSummary(sessionId, st, ac, t0, sid, fallbackText, fallbackUserMessage, device, 'live')
      })
  }

  private async resolveTurnText(
    sessionId: string,
    fallbackText: string,
    fallbackUserMessage: string,
  ): Promise<{ text: string; userMessage: string; source: 'session-json' | 'live' }> {
    const turn = this.opts.readLastTurn ? await this.opts.readLastTurn(sessionId) : null
    if (turn?.assistantText.trim()) {
      return {
        text: turn.assistantText.trim(),
        userMessage: turn.userMessage || fallbackUserMessage,
        source: 'session-json',
      }
    }
    return { text: fallbackText, userMessage: fallbackUserMessage, source: 'live' }
  }

  private startSummary(
    sessionId: string,
    st: SessionState,
    ac: AbortController,
    t0: number,
    sid: string,
    text: string,
    userMessage: string,
    device: boolean,
    source: 'session-json' | 'live',
  ): void {
    if (!text) {
      // No assistant TEXT block accumulated this turn (thinking/tools don't count) → nothing to
      // summarize. Happens when: a new prompt closed the turn before any text arrived (back-to-back
      // messages), or a tools/thinking-only turn ended with no final text. Graceful: clear busy, no recap.
      const ask = userMessage.replace(/\s+/g, ' ').trim().slice(0, 60)
      st.summarizing = false
      this.trace(sessionId, `${sid} turn-end · empty assistant text → done · source=${source}${ask ? ` · ask="${ask}"` : ' · (no user prompt captured this turn)'}`)
      this.emit(sessionId, { kind: 'done', text: 'done' })
      return
    }

    const ask = userMessage.replace(/\s+/g, ' ').trim().slice(0, 60)
    this.trace(sessionId, `${sid} summarizing · source=${source} · textLen=${text.length} · device=${device}${this.opts.recapForce ? ' · recapForce' : ''}${ask ? ` · ask="${ask}"` : ''}`)
    // Device: busy "Summarizing…" card. Web: the "Summarizing for device…" indicator (mirrors the
    // node's handleBrainSummaryEvent — the web ignores the summary text, only toggles the flag).
    this.emit(sessionId, { kind: 'processing', text: 'Summarizing…' })
    this.opts.sendWeb({ type: 'turn_summary_pending', dbSessionId: sessionId, payload: { sessionId } })

    this.opts
      .summarize(text, ac.signal, userMessage, sessionId)
      .then((summary) => {
        const ms = Date.now() - t0
        if (ac.signal.aborted) { this.trace(sessionId, `${sid} superseded after ${ms}ms (newer turn) — dropping result`); return }
        st.summarizing = false
        if (summary) {
          this.summaries.set(sessionId, summary)
          this.saveSoon()
          const { recap, body } = splitSummary(summary)
          this.trace(sessionId, `${sid} done in ${ms}ms · recap="${recap}" · bodyLen=${body.length}`)
          this.emit(sessionId, { kind: 'done', text: 'done' })
          this.emit(sessionId, { kind: 'summary', text: body || recap, recap })
          this.opts.sendWeb({ type: 'turn_summary', dbSessionId: sessionId, payload: { summary, sessionId } })
        } else {
          this.trace(sessionId, `${sid} summarizer returned NULL after ${ms}ms → done`)
          this.emit(sessionId, { kind: 'done', text: 'done' })
          this.opts.sendWeb({ type: 'turn_summary_pending', dbSessionId: sessionId, payload: { sessionId, done: true } })
        }
      })
      .catch((err) => {
        const ms = Date.now() - t0
        if (ac.signal.aborted) return
        st.summarizing = false
        this.trace(sessionId, `${sid} FAILED after ${ms}ms: ${err instanceof Error ? err.message : String(err)}`, true)
        this.emit(sessionId, { kind: 'done', text: 'done' })
        this.opts.sendWeb({ type: 'turn_summary_pending', dbSessionId: sessionId, payload: { sessionId, done: true } })
      })
  }

  /** Converge on commander (re)join — fires when a device joins OR when the adapter reconnects to the backend
   *  with a device still attached (the adapter has no periodic heartbeat). For an OPEN turn, re-assert its
   *  live processing/tool state. For an IDLE session, re-assert a terminal `done`: its turn-end summary may
   *  have been emitted into a WS that dropped right after (see the ETH case — `done` then `close 1006`), so a
   *  device that missed it is stuck "Working…" forever. A bare `done` clears that stale busy WITHOUT a beep or
   *  recap card, and is a harmless no-op on a tile that isn't busy; the device's recent-poll restores the
   *  stored summary text afterwards. */
  replayAll(): void {
    for (const sessionId of this.states.keys()) {
      // Busy session → re-assert its live processing/summarizing state (shared with heartbeat()).
      // Idle session → re-assert a terminal `done` (heartbeat() returns false and emits nothing).
      if (!this.heartbeat(sessionId)) this.emit(sessionId, { kind: 'done', text: 'done' })
    }
  }

  /** 5s heartbeat fan-out to the device (called from cli.ts's per-session turn timer). Re-emits the current
   *  BUSY state so the device's busy tile stays fresh through BOTH the turn (Processing) AND the summarize
   *  window (Summarizing…) — the device clears a busy tile only via a live terminal, and has a busy-timeout
   *  watchdog that fires if these stop arriving. Returns true while the session is busy (turnOpen ||
   *  summarizing) so the caller knows when to self-cancel the timer; false (emitting nothing) when idle. */
  heartbeat(sessionId: string): boolean {
    const st = this.states.get(sessionId)
    if (!st) return false
    if (st.turnOpen) {
      this.emit(sessionId, st.lastTodos
        ? { kind: 'processing', text: 'Processing', todos: st.lastTodos }
        : { kind: 'processing', text: 'Processing' })
      if (st.lastTool) this.emit(sessionId, st.lastTool)
      return true
    }
    if (st.summarizing) {
      this.emit(sessionId, { kind: 'processing', text: 'Summarizing…' })
      return true
    }
    return false
  }

  /** Device tile restore at boot (project_recent): the stored last summary, split for the tile. */
  recent(sessionId: string, _n = 2): Array<{ kind: string; text: string; recap?: string }> {
    const summary = this.summaries.get(sessionId)
    if (!summary || !summary.trim()) return []
    const { recap, body } = splitSummary(summary)
    return [{ kind: 'summary', text: body || recap, recap }]
  }

  /** Turn cancelled (web/device C-c). The claude turn is killed with no end_turn line, so no turn_ended
   *  fires and the recap flow never closes the device's busy tile — it would spin "Working…" forever. Abort
   *  any in-flight recap (so a killed turn can't emit a late summary + beep) and send a bare `done`, which
   *  the device treats as "clear the processing status, keep the last card" (no recap, no beep). The session
   *  stays alive; the next prompt reopens a fresh turn. Mirrors forget() but WITHOUT dropping the state. */
  cancel(sessionId: string): void {
    const st = this.states.get(sessionId)
    if (!st) return
    st.abort?.abort()
    st.abort = null
    st.summarizing = false
    st.turnOpen = false
    st.lastTool = null
    st.lastTodos = null
    // A cancel outranks a held turn-end: the user threw the turn away, sub-agents and all.
    this.clearEndTimers(st)
    st.endPending = false
    this.emit(sessionId, { kind: 'done', text: 'done' })
  }

  /**
   * Move the stored recap to a new session id, for a rotation (`/clear`) inside the same live process agent.
   *
   * The device tile shows the last recap; without this, clearing the context blanks the tile even though
   * the agent, its pane and its engine process never went anywhere.
   */
  inheritSummary(fromSessionId: string, toSessionId: string): void {
    const summary = this.summaries.get(fromSessionId)
    if (!summary || this.summaries.get(toSessionId)) return
    this.summaries.set(toSessionId, summary)
    this.save()
  }

  /** Session metadata was unbound or its process agent was removed: abort any in-flight recap and drop
   * the EPHEMERAL live state, but KEEP the persisted summary. A later resume of the same engine session
   * can reuse it via recent()/project_recent instead of losing the last device recap. SessionEnd alone
   * does not call this; process discovery owns lifetime. */
  forget(sessionId: string): void {
    const st = this.states.get(sessionId)
    st?.abort?.abort()
    // The state object is about to be dropped; a held turn-end timer would fire against a dead session.
    if (st) this.clearEndTimers(st)
    this.states.delete(sessionId)
    // NB: intentionally do NOT delete this.summaries[sessionId] — reuse it on the next resume.
    this.emit(sessionId, { kind: 'done', text: 'done' })
  }

  // ── persistence ──────────────────────────────────────────────────────────────────────────────
  private load(): void {
    try {
      const obj = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, string>
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') this.summaries.set(k, v)
    } catch { /* no file yet */ }
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 200)
  }

  private save(): void {
    try {
      mkdirSync(this.opts.dataDir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.summaries), null, 2))
    } catch (err) {
      console.error('[commander] save summaries failed:', err)
    }
  }
}

// Used by other modules only for potential reuse — kept exported.
export { splitSummary }
