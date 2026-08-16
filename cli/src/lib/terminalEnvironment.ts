export const TERMINAL_CONTEXT_VARIABLES = [
  'TMUX',
  'TMUX_PANE',
  'HERDR_ENV',
  'HERDR_SESSION',
  'HERDR_SOCKET_PATH',
  'HERDR_WORKSPACE_ID',
  'HERDR_TAB_ID',
  'HERDR_PANE_ID',
] as const

/** Mutate a child-only environment copy so one-shots cannot register as top-level terminal agents. */
export function scrubTerminalContext<T extends NodeJS.ProcessEnv>(environment: T): T {
  for (const key of TERMINAL_CONTEXT_VARIABLES) delete environment[key]
  return environment
}
