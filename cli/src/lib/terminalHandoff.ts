/**
 * `remote_terminal_handoff` — the wire shape behind `harness remote`.
 *
 * Typed inside one of this machine's terminal tiles, `harness remote` opens a terminal on another
 * machine and then asks the window in front of it to swap the tile over. The shell knows one thing
 * about itself: its tmux pane (`$TMUX_PANE`, `%N`). The daemon turns that into the agent whose tile it
 * is, and pushes the swap to the loopback clients — the desktop — as a `remote_terminal_handoff` event. (Not `terminal_*`: those frames are the
 * terminal streams' and never reach the RPC switch.)
 */

export interface TerminalHandoffRequest {
  /** The pane `harness remote` was typed in: tmux's `%N`. */
  tmuxPane: string
  /** The machine the new terminal is on, and the agent it is there. */
  machineId: string
  agentId: string
}

export const TMUX_PANE_RE = /^%\d{1,9}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** The request as the wire may carry it — bounded, printable ids, a real pane id — or null. */
export function terminalHandoffRequest(payload: Record<string, unknown>): TerminalHandoffRequest | null {
  const { tmuxPane, machineId, agentId } = payload
  if (typeof tmuxPane !== 'string' || !TMUX_PANE_RE.test(tmuxPane)) return null
  if (typeof machineId !== 'string' || !ID_RE.test(machineId)) return null
  if (typeof agentId !== 'string' || !ID_RE.test(agentId)) return null
  return { tmuxPane, machineId, agentId }
}
