/**
 * Fork a harness: a SECOND agent that starts with everything the first one knows, then goes its own way.
 *
 * Not resume (the same session, continued) and not clone (a new agent, empty). Claude Code's
 * `--resume <id> --fork-session` and Codex's `codex fork <id>`, as a Harness verb, with a fallback for
 * the engines that have no such thing.
 *
 * Three levels, decided here per engine and announced to the person in the pane:
 *   - native   — the engine opens a new session from the old one (`LAUNCH_FORK_FLAG`). Full context.
 *   - handoff  — the engine takes a first prompt but cannot fork: the new agent opens with a message
 *                composed from what the daemon remembers of the source (its recent asks and recaps,
 *                its last full answer) and is told to carry on from there. Memory, not context.
 *   - refused  — no fork, no first prompt: there is no honest way to give the new agent the old one's
 *                history, and a plain `--resume` would put two processes on ONE session.
 *
 * The launch itself goes down `agent_create`'s path (cli.ts, `onForkAgent`); this module decides what
 * that launch is and writes the handoff. Pure, so both are testable without tmux.
 */
import type { AgentEngine } from '../engines/types.js'
import { MAX_FIRST_PROMPT_CHARS, supportsFirstPrompt, supportsNativeFork } from './engineLaunch.js'

export type ForkLevel = 'native' | 'handoff'

/** Whether a fork of an agent on this engine can be anything at all — native or a handoff. */
export function engineCanFork(engine: AgentEngine): boolean {
  return supportsNativeFork(engine) || supportsFirstPrompt(engine)
}

export type ForkPlan =
  | { ok: true; level: 'native'; forkSessionId: string }
  | { ok: true; level: 'handoff'; firstPrompt: string }
  | { ok: false; error: 'FORK_UNSUPPORTED' | 'FORK_NO_SESSION'; detail: string }

/** What the daemon remembers of the source, in the mirror's own terms (commander.ts). */
export interface ForkMemory {
  /** The person's own words for the recent turns, newest first. */
  asks: string[]
  /** One-line recaps of the recent turns, newest first. */
  recaps: string[]
  /** The newest turn's complete answer, if kept. */
  lastAnswer?: string
}

export interface ForkSource {
  engine: AgentEngine
  /** The engine session bound to the source, '' when the engine has not reported one yet. */
  sessionId: string
  name: string
  cwd: string | null
}

/**
 * Decide how `source` can be forked.
 *
 * `task` is what the person typed into the fork dialog's First task — for a native fork it is passed
 * through as the new session's first prompt; for a handoff it is folded into the composed message so
 * the new agent gets its history AND its job in one turn rather than two.
 */
export function planFork(source: ForkSource, memory: ForkMemory, task: string | null): ForkPlan {
  if (supportsNativeFork(source.engine)) {
    if (!source.sessionId) {
      return {
        ok: false, error: 'FORK_NO_SESSION',
        detail: `${source.name} has not started a session yet — there is nothing to fork until it has answered once.`,
      }
    }
    return { ok: true, level: 'native', forkSessionId: source.sessionId }
  }
  if (!supportsFirstPrompt(source.engine)) {
    return {
      ok: false, error: 'FORK_UNSUPPORTED',
      detail: `${source.engine} can neither fork a session nor open with a first message, so a fork of ${source.name} would start empty.`,
    }
  }
  return { ok: true, level: 'handoff', firstPrompt: handoffPrompt(source, memory, task) }
}

/**
 * The message a handoff fork opens with.
 *
 * Written as a briefing from the previous agent, not as a system prompt: the engine reads it as the
 * person's first turn, and a first turn that reads like a document gets answered like one. Newest
 * facts last, so the "continue from here" lands beside the freshest context. Clipped to what the wire
 * accepts (`MAX_FIRST_PROMPT_CHARS`), oldest history first to go.
 */
export function handoffPrompt(source: ForkSource, memory: ForkMemory, task: string | null): string {
  const where = source.cwd ? ` in ${source.cwd}` : ''
  const head = `You are a fork of the agent "${source.name}"${where}. It kept working; you are its copy, picking up from what it knew. Here is its recent history, oldest first.`
  const turns: string[] = []
  const n = Math.max(memory.asks.length, memory.recaps.length)
  for (let i = n - 1; i >= 0; i--) {
    const ask = (memory.asks[i] ?? '').trim()
    const recap = (memory.recaps[i] ?? '').trim()
    if (!ask && !recap) continue
    turns.push([ask ? `Asked: ${ask}` : '', recap ? `Result: ${recap}` : ''].filter(Boolean).join('\n'))
  }
  const answer = (memory.lastAnswer ?? '').trim()
  const tail = task?.trim()
    ? `Continue from there. Your task now: ${task.trim()}`
    : 'Continue from there. Before acting, say in one line what you understand the current state to be.'

  // Assemble from the fixed parts outward, dropping the oldest turns first until it fits.
  const fixed = [head, answer ? `Its last full answer:\n${answer}` : '', tail]
  let kept = turns
  for (;;) {
    const body = [fixed[0], ...(kept.length ? [kept.join('\n\n')] : []), fixed[1], fixed[2]].filter(Boolean).join('\n\n')
    if (body.length <= MAX_FIRST_PROMPT_CHARS) return body
    if (kept.length) { kept = kept.slice(1); continue }
    if (fixed[1]) { fixed[1] = ''; continue }
    return body.slice(0, MAX_FIRST_PROMPT_CHARS)
  }
}

/** The default name for a fork of `name` — the owner's spelling (2026-09-18). */
export function forkName(name: string): string {
  return `${name.trim() || 'Agent'} - fork`
}
