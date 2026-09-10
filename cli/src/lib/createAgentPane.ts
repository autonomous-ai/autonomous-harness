/**
 * Open a tmux pane for a new agent and claim it in the registry, retrying the claim up to
 * `maxAttempts` times.
 *
 * `registry.openPendingAgent` refuses a pane whose route is already in `runtimeIndex` — which
 * happens for real, rarely, when a STALE entry from a previous tmux-server generation (the
 * registry only clears its cache on a detected machine reboot, not a tmux-server-only restart)
 * collides with the brand-new pane's id. That collision is transient: a fresh `tmuxBackend.create`
 * call mints a never-before-used pane id from tmux's own monotonic counter, so a retry almost
 * always lands on an unclaimed route without needing to wait for anything. A tmux spawn failure
 * (`SPAWN_FAILED`/`TMUX_UNAVAILABLE`) is a different, not-obviously-transient problem and is
 * returned immediately — only the registration race is retried.
 */
import { homedir } from 'node:os'
import type { AgentEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalCreateResult, TmuxRuntimeRef } from './terminalTypes.js'
import { terminalRouteKey } from './terminalRuntime.js'

const DEFAULT_MAX_ATTEMPTS = 3

export interface CreateAgentPaneDeps {
  tmuxBackend: Pick<TerminalBackend<TmuxRuntimeRef>, 'create' | 'kill'>
  registry: { openPendingAgent: (input: {
    engine: AgentEngine
    runtimes: TmuxRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    grid?: { baseUrl: string; model: string | null } | null
    codexHome?: string | null
  }) => RegisteredSession | null }
  engine: AgentEngine
  cwd?: string | null
  /** Base tmux session name (`-s`). Retries append `-r<attempt>` — see module doc. */
  sessionLabel: string
  argv: string[]
  env?: Record<string, string>
  grid?: { baseUrl: string; model: string | null } | null
  /** The CODEX_HOME folder this agent was launched against, if the caller chose one; codex only. */
  codexHome?: string | null
  maxAttempts?: number
}

export type CreateAgentPaneResult =
  | { ok: true; spawned: TerminalCreateResult<TmuxRuntimeRef> & { state: 'succeeded' }; pending: RegisteredSession }
  | { ok: false; error: 'TMUX_UNAVAILABLE' | 'SPAWN_FAILED' | 'REGISTRATION_FAILED'; detail: string }

export async function createAndRegisterPane(deps: CreateAgentPaneDeps): Promise<CreateAgentPaneResult> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const label = attempt === 1 ? deps.sessionLabel : `${deps.sessionLabel}-r${attempt}`
    const spawned = await deps.tmuxBackend.create({
      // The login shell starts somewhere stable; its argv enters the requested workspace after rc
      // files. `deps.cwd` still travels below, into the registry entry — this is only about where
      // the pane's OWN shell starts, not the workspace the agent ends up in.
      cwd: homedir(),
      label,
      command: deps.argv,
      ...(deps.env ? { env: deps.env } : {}),
    })
    if (spawned.state !== 'succeeded') {
      console.warn(`[agent] create ${deps.engine} failed · tmux could not open a pane · ${spawned.reason ?? ''}`)
      const missing = spawned.reason === 'tmux is unavailable'
      return { ok: false, error: missing ? 'TMUX_UNAVAILABLE' : 'SPAWN_FAILED', detail: spawned.reason }
    }
    const pending = deps.registry.openPendingAgent({
      engine: deps.engine,
      runtimes: [spawned.runtime],
      primaryRuntimeKey: terminalRouteKey(spawned.runtime),
      cwd: deps.cwd,
      grid: deps.grid,
      codexHome: deps.codexHome,
    })
    if (pending) return { ok: true, spawned, pending }
    console.warn(`[agent] create ${deps.engine} registration failed · pane ${spawned.runtime.paneId} · `
      + `attempt ${attempt}/${maxAttempts}`)
    await deps.tmuxBackend.kill(spawned.runtime)
  }
  console.warn(`[agent] create ${deps.engine} registration failed · giving up after ${maxAttempts} attempts`)
  return {
    ok: false,
    error: 'REGISTRATION_FAILED',
    detail: `tmux pane could not be registered after ${maxAttempts} attempts`,
  }
}
