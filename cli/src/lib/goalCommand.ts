import type { AgentEngine } from '../engines/types.js'

/**
 * Per-engine handling of the two slash commands the DEVICE can put in front of an utterance.
 *
 * The device sends a mode with each voice turn and the backend prepends the matching command, so a
 * literal `/goal <text>` or `/loop <text>` arrives here as ordinary message content (a web-typed one
 * looks identical). Injecting an unknown slash command into a CLI that has none trips a visible
 * unknown-command error in the user's terminal, so each is adapted per engine.
 *
 * The backend prepends UNCONDITIONALLY — it does not know the engine. On the routed path it picks the
 * agent only after transcribing, and `voice_route` replies without an engine field; the fixed-agent and
 * route_confirm paths would each need their own lookup. This module is the one place that always knows
 * the engine (`registry.get(sessionId).engine`), so the filtering lives here for every path at once.
 */

/**
 * `/goal`:
 *   - claude  — native Stop-hook goal mechanism
 *   - codex   — goal-context (`<codex_internal_context source="goal">`) + CCR `thread/goal/set`
 */
export const GOAL_ENGINES: ReadonlySet<AgentEngine> = new Set<AgentEngine>(['claude', 'codex'])

/**
 * `/loop`: Claude only. Codex is deliberately NOT here — it has its own goal-context mechanism, and
 * assuming a `/loop` it may not have would put an error in front of the user instead of running their
 * turn. Add an engine here only once its `/loop` has actually been seen to work.
 */
export const LOOP_ENGINES: ReadonlySet<AgentEngine> = new Set<AgentEngine>(['claude'])

export function engineSupportsGoal(engine: AgentEngine): boolean {
  return GOAL_ENGINES.has(engine)
}

export function engineSupportsLoop(engine: AgentEngine): boolean {
  return LOOP_ENGINES.has(engine)
}

/**
 * Adapt a leading `/goal` or `/loop` token to what this engine can actually take. The two degrade
 * DIFFERENTLY, on purpose:
 *
 *   `/goal fix the bug` → `goal fix the bug`   — the word survives, because it still reads as an
 *                                                instruction the agent can act on.
 *   `/loop fix the bug` → `fix the bug`        — the whole token goes. "loop" left in the text is not
 *                                                an instruction, it is a stray word the agent would
 *                                                have to interpret; the turn should just run normally.
 *
 * Only a LEADING whole token is touched, so `/goalkeeper` and `/loopback` are never rewritten.
 * Anything else is returned unchanged.
 */
export function adaptSlashCommand(content: string, engine: AgentEngine): string {
  if (!engineSupportsGoal(engine)) content = content.replace(/^\/goal(?=\s|$)/, 'goal')
  if (!engineSupportsLoop(engine)) {
    content = content.replace(/^\/loop\s+/, '')     // `/loop fix it` → `fix it`
    // A BARE `/loop` degrades to the word instead of vanishing: stripping it would submit an empty
    // message to the CLI, which is worse than a stray word — the turn would look like it was sent and
    // nothing would happen.
    content = content.replace(/^\/loop$/, 'loop')
  }
  return content
}

/** @deprecated Use {@link adaptSlashCommand}; kept so older call sites keep compiling. */
export function adaptGoalCommand(content: string, engine: AgentEngine): string {
  return adaptSlashCommand(content, engine)
}
