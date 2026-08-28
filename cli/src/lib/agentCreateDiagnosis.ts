/**
 * Explain a `New agent` that opened a pane but never produced a discoverable engine.
 *
 * `ENGINE_DID_NOT_START` on its own is unactionable at a distance. Reaching it already proves tmux
 * opened the pane AND the engine binary resolves from the user's own login shell, which leaves three
 * causes that need three different fixes: the engine ran and exited, the login shell is still
 * starting (its dotfiles are slower than the discovery window), or a process IS running that
 * discovery did not recognise. The only machine that can tell them apart is the one that failed —
 * and its `harness.log` is exactly what a person reporting this from another computer cannot reach.
 * So the facts travel back in the error itself, via the `detail` the New Agent dialog already renders.
 */

/** What tmux knows about the created pane at the moment discovery gave up. */
export interface AgentCreatePaneState {
  dead: boolean
  /** Exit status of the pane's process once it is dead; null while it is still running. */
  exitStatus: number | null
  /** `#{pane_current_command}` — the shell while startup files are still running, the engine after. */
  command: string
}

export interface AgentCreatePaneFacts {
  /** null when tmux no longer knows this pane, i.e. it exited and took its session with it. */
  state: AgentCreatePaneState | null
  /** Whatever the pane printed, ANSI already stripped. Empty when nothing could be read. */
  output: string
  /** The executable the launch was meant to `exec`, e.g. `codex`. */
  engineBin: string
  /** Process name of the wrapper login shell, e.g. `zsh`. Null when no interactive shell was used. */
  shellName: string | null
  elapsedMs: number
}

const MAX_OUTPUT_CHARS = 180
const MAX_DETAIL_CHARS = 340

/** tmux paints this into a pane it is keeping alive under `remain-on-exit`; it is our own artifact. */
const DEAD_PANE_NOTICE = /^Pane is dead \(.*\)$/

/**
 * The last few things the pane said, as one line.
 *
 * Errors print last, so the tail is read rather than the head — a full-screen TUI that merely failed
 * to be *discovered* would otherwise contribute a screenful of chrome and push its own message out.
 */
export function summarizePaneOutput(raw: string): string {
  const lines = raw
    // `capture-pane` without `-e` still lets stray control bytes through (a TUI's own writes, an
    // OSC title). Strip them so a detail string can never carry escape bytes into a log line or a
    // Flutter Text widget. Written as explicit \u escapes: literal ESC bytes in source do not
    // survive copy/paste and review.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !DEAD_PANE_NOTICE.test(line))
  if (lines.length === 0) return ''
  const tail = lines.slice(-3).join(' · ')
  return tail.length > MAX_OUTPUT_CHARS ? `${tail.slice(0, MAX_OUTPUT_CHARS - 1)}…` : tail
}

function seconds(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(1)}s`
}

function withOutput(summary: string, output: string): string {
  const detail = output ? `${summary} · pane said: ${output}` : summary
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail
}

/**
 * One sentence naming which of the three causes happened, plus the pane's own words.
 *
 * Deliberately phrased for someone reading a dialog on a different computer than the one that
 * failed: it says what the pane was doing, not what the code checked.
 */
export function describeAgentCreateFailure(facts: AgentCreatePaneFacts): string {
  const { state, output, engineBin, shellName, elapsedMs } = facts
  const waited = seconds(elapsedMs)

  // tmux forgot the pane entirely. `create` asks tmux to keep dead panes, so reaching this means the
  // option did not take (a tmux too old for it) and the process still exited — the output is gone
  // with the session, which is itself the finding.
  if (!state) {
    return withOutput(
      `the pane exited within ${waited} and tmux did not keep it, so "${engineBin}" left no output to read`,
      output,
    )
  }

  if (state.dead) {
    const status = state.exitStatus === null ? '' : ` with status ${state.exitStatus}`
    return withOutput(`"${engineBin}" started and exited${status} after ${waited}`, output)
  }

  // Still the login shell: the dotfiles (nvm, oh-my-zsh, asdf, corporate profiles) had not finished
  // by the time discovery gave up, so `exec` had not replaced the shell with the engine yet. The
  // agent normally still appears a few seconds later, once the periodic reconcile runs.
  if (shellName && state.command === shellName) {
    return withOutput(
      `after ${waited} the pane was still running "${shellName}" startup files, so "${engineBin}" had not launched yet`
        + ' — the agent may still appear on its own shortly',
      output,
    )
  }

  return withOutput(
    `after ${waited} the pane was running "${state.command}" but it was not recognised as a ${engineBin} agent`,
    output,
  )
}
