import type { AgentEngine } from '../engines/types.js'
import { engineBin } from './engineBin.js'

/**
 * Best-effort "skip permission prompts" flag per engine, confirmed against each vendor's own docs.
 * `null` = no known/safe flag — callers must hide the option rather than guess one.
 */
export const BYPASS_PERMISSION_FLAGS: Readonly<Record<AgentEngine, string[] | null>> = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  cursor: ['--force'],
  opencode: ['--auto'],
  // No permission-prompt system to bypass (pi), or config-file based rather than a flag (hermes).
  pi: null,
  hermes: null,
  // Unconfirmed — do not guess a flag for a CLI we haven't verified.
  commandcode: null,
  devin: null,
  muse: null,
  amp: null,
  kilo: null,
  grok: null,
  agy: null,
  copilot: null,
}

export interface LaunchCommandOptions {
  bypassPermission?: boolean
}

/** Full argv (binary first) to launch `engine` in a fresh tmux pane. `cwd` is set separately via
 *  tmux `new-session -c`, not part of this argv. */
export function buildEngineLaunchArgv(engine: AgentEngine, opts: LaunchCommandOptions = {}): string[] {
  const argv = [engineBin(engine)]
  if (opts.bypassPermission) {
    const flags = BYPASS_PERMISSION_FLAGS[engine]
    if (flags) argv.push(...flags)
  }
  return argv
}
