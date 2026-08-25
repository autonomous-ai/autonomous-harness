import type { TerminalBackendName } from '../lib/terminalTypes.js'

const HERDR_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Every backend the daemon drives. tmux is the only one — Herdr was retired as a supported backend.
 *
 * The `herdr*` modules are still in the tree and `HerdrRuntimeRef` is still part of the runtime union,
 * because both are reachable from state written by older builds; what changed is that nothing puts
 * `herdr` in this list any more, and every Herdr code path in cli.ts is already gated on
 * `backends.includes('herdr')`, so none of it is constructed or reached.
 */
export const ALL_TERMINAL_BACKENDS: readonly TerminalBackendName[] = ['tmux']

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

/**
 * `herdr` is dropped with a warning rather than rejected.
 *
 * Rejecting it would be the consistent thing to do — an unknown backend is an error — but the daemon
 * SELF-UPDATES. A machine whose environment still says `TERMINAL_BACKENDS=tmux,herdr` would install a
 * build that then refuses to start, and it would happen unattended, on a computer nobody is watching.
 * Dropping the retired name keeps that machine running on tmux, which is exactly what it would have
 * got by editing the variable by hand. A genuinely unknown backend is still an error.
 */
export function parseTerminalBackends(value = 'tmux'): TerminalBackendName[] {
  const values = strictList(value, 'TERMINAL_BACKENDS')
  const kept: TerminalBackendName[] = []
  for (const backend of values) {
    if (backend === 'tmux') { kept.push(backend); continue }
    if (backend === 'herdr') {
      console.warn('[terminal] TERMINAL_BACKENDS names "herdr", which is no longer a supported backend — ignoring it')
      continue
    }
    throw new Error(`TERMINAL_BACKENDS contains unsupported backend "${backend}"; expected tmux`)
  }
  if (!kept.length) {
    console.warn('[terminal] TERMINAL_BACKENDS named no supported backend — falling back to tmux')
    return ['tmux']
  }
  return kept
}

/**
 * Retained so an existing `HERDR_SESSIONS` in someone's environment still validates instead of failing
 * boot, but the value is inert: `parseTerminalConfig` no longer feeds it anywhere now that `herdr` is
 * never in the backend list.
 */
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
 * Unset means AUTO — every backend usable on this machine, which is now tmux and only tmux.
 *
 * The tmux flow has never asked for configuration: start a pane, run the engine, the agent appears.
 * With Herdr retired there is nothing left for `TERMINAL_BACKENDS` to select between, so the variable
 * survives only as a pin (and as the place that warns about the retired name). `herdrSessions` is
 * always empty for the same reason — there is no backend left to name sessions for.
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
    // Always empty: `backends` can no longer contain 'herdr', so there is nothing to name sessions for.
    herdrSessions: [],
    backendsExplicit,
    herdrSessionsExplicit,
  }
}
