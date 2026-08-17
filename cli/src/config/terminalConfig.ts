import type { TerminalBackendName } from '../lib/terminalTypes.js'

const HERDR_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Every backend the daemon knows how to drive. Absent configuration means "look for all of them". */
export const ALL_TERMINAL_BACKENDS: readonly TerminalBackendName[] = ['tmux', 'herdr']

/** What is watched right now. This is also the persisted snapshot shape — keep it serializable. */
export interface TerminalConfig {
  backends: readonly TerminalBackendName[]
  /** Empty under auto-detection: the session set comes from discovery, not from configuration. */
  herdrSessions: readonly string[]
}

export interface ResolvedTerminalConfig extends TerminalConfig {
  /**
   * Did the operator name the backends, or did we?
   *
   * It decides what happens when one of them turns out to be unusable. An explicitly configured backend
   * that fails is a startup error — it was asked for, and silence would be a lie. An auto-detected one
   * is simply absent, because nobody asked for it and a machine without Herdr must not be told about
   * Herdr, still less refuse to start because of it.
   */
  backendsExplicit: boolean
  /** Same distinction for the session list: a named allowlist is honoured verbatim, never widened. */
  herdrSessionsExplicit: boolean
}

function strictList(value: string, field: string): string[] {
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.length || parts.some((part) => !part)) {
    throw new Error(`${field} must be a non-empty comma-separated list`)
  }
  if (new Set(parts).size !== parts.length) throw new Error(`${field} must not contain duplicates`)
  return parts
}

export function parseTerminalBackends(value = 'tmux'): TerminalBackendName[] {
  const values = strictList(value, 'TERMINAL_BACKENDS')
  for (const backend of values) {
    if (backend !== 'tmux' && backend !== 'herdr') {
      throw new Error(`TERMINAL_BACKENDS contains unsupported backend "${backend}"; expected tmux, herdr, or tmux,herdr`)
    }
  }
  return values as TerminalBackendName[]
}

export function parseHerdrSessions(value = 'default'): string[] {
  const values = strictList(value, 'HERDR_SESSIONS')
  for (const session of values) {
    if (!HERDR_SESSION_RE.test(session)) {
      throw new Error(`HERDR_SESSIONS contains invalid session name "${session}"`)
    }
  }
  return values
}

/**
 * Unset means AUTO, not "tmux".
 *
 * The tmux flow has never asked for configuration — start a pane, run the engine, the agent appears —
 * and a second multiplexer that only works for people who know an env var is not the same product. So
 * an absent `TERMINAL_BACKENDS` means "watch every backend that is actually usable on this machine"
 * (Herdr resolves only when its binary is on PATH, so a machine without it pays nothing), and an absent
 * `HERDR_SESSIONS` means "adopt the sessions Herdr says are running" rather than a fixed name that
 * happens to be `default`.
 *
 * Both remain overrides. Naming the backends pins them — `TERMINAL_BACKENDS=tmux` is how you turn Herdr
 * off — and naming the sessions keeps today's strict allowlist, which discovery never widens.
 */
export function parseTerminalConfig(input: {
  TERMINAL_BACKENDS?: string
  HERDR_SESSIONS?: string
}): ResolvedTerminalConfig {
  const backendsExplicit = input.TERMINAL_BACKENDS !== undefined && input.TERMINAL_BACKENDS !== ''
  const backends = backendsExplicit ? parseTerminalBackends(input.TERMINAL_BACKENDS) : ALL_TERMINAL_BACKENDS
  const herdrSessionsExplicit = input.HERDR_SESSIONS !== undefined && input.HERDR_SESSIONS !== ''
  return {
    backends,
    herdrSessions: backends.includes('herdr') && herdrSessionsExplicit
      ? parseHerdrSessions(input.HERDR_SESSIONS)
      : [],
    backendsExplicit,
    herdrSessionsExplicit,
  }
}
