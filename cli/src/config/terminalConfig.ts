import type { TerminalBackendName } from '../lib/terminalTypes.js'

const HERDR_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface TerminalConfig {
  backends: readonly TerminalBackendName[]
  herdrSessions: readonly string[]
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

export function parseTerminalConfig(input: {
  TERMINAL_BACKENDS?: string
  HERDR_SESSIONS?: string
}): TerminalConfig {
  const backends = parseTerminalBackends(input.TERMINAL_BACKENDS)
  return {
    backends,
    herdrSessions: backends.includes('herdr') ? parseHerdrSessions(input.HERDR_SESSIONS) : [],
  }
}
