/**
 * The tmux session-name convention for agent panes this daemon itself creates via `agent_create`
 * (`createAgentPane.ts`).
 *
 * Discovery uses `isHarnessSession` as a whitelist (`TmuxBackend.inventory()`): a tmux pane whose
 * session isn't named this way is invisible to the daemon, whether it's a session the user opened
 * by hand or one an agent spawned itself with a nested `tmux new-session` — neither went through
 * `agent_create`, so neither should ever appear as a discovered agent (issue autonomous-harness-desktop#6).
 */
export const HARNESS_SESSION_PREFIX = 'harness-'

export function buildHarnessSessionLabel(engine: string, now: number = Date.now()): string {
  return `${HARNESS_SESSION_PREFIX}${engine}-${now}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export function isHarnessSession(sessionName: string): boolean {
  return sessionName.startsWith(HARNESS_SESSION_PREFIX)
}
