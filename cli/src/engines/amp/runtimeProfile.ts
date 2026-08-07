/**
 * Amp runtime profile.
 *
 * Amp exposes no model list at all — `amp -m <mode>` picks one of four AGENT MODES (low, medium, high,
 * ultra) and the mode decides the model, the system prompt and the tool set. So the mode is what the user
 * chooses and what the TUI prints in its footer (`─ medium ─`), and it is what the chip reports.
 *
 * It is read from `~/.local/share/amp/session.json`, the same file that maps panes to threads. Verified
 * content: {"agentMode":"medium","lastThreadId":"T-…","lastThreadByTerminal":{…}}.
 *
 * One honest limitation: `agentMode` there is GLOBAL, not per-thread. Two Amp agents started in different
 * modes both report whichever was written last. The per-thread value does exist — `meta.agentMode` in
 * `amp threads export` — but reading it costs a ~1.5s network round trip per poll, which is far too much
 * for a chip that only ever displays.
 */

const MODES = new Set(['low', 'medium', 'high', 'ultra'])

export function parseAmpSession(text: string | null): { mode: string | null } {
  if (!text) return { mode: null }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { mode: null } }
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const raw = typeof obj.agentMode === 'string' ? obj.agentMode.toLowerCase() : ''
  return { mode: MODES.has(raw) ? raw : null }
}
