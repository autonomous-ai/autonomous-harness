import type { ProcessIdentity, TerminalRuntimeRef } from './terminalTypes.js'

const SEP = '\u0000'

function assertKeyPart(value: string, field: string): string {
  if (!value || value.includes(SEP)) throw new Error(`invalid ${field}`)
  return value
}

/** Stable route key. It changes when a Herdr terminal moves to a different public pane route. */
export function terminalRouteKey(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux'
    ? `tmux${SEP}${assertKeyPart(runtime.paneId, 'tmux pane id')}`
    : `herdr${SEP}${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}${SEP}${assertKeyPart(runtime.paneId, 'Herdr pane id')}`
}

export function terminalInstanceId(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux' ? 'tmux:default' : `herdr:${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}`
}

/** Human-readable locator label for status and logs. It never contains a Herdr socket path. */
export function terminalRuntimeLabel(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux'
    ? `tmux:${runtime.paneId}`
    : `herdr:${runtime.sessionName}:${runtime.paneId}`
}

/** Stable placement key. A Herdr pane move keeps this key because terminal_id is the placement identity. */
export function terminalPlacementKey(runtime: TerminalRuntimeRef): string {
  return runtime.backend === 'tmux'
    ? terminalRouteKey(runtime)
    : `herdr${SEP}${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}${SEP}${assertKeyPart(runtime.terminalId, 'Herdr terminal id')}`
}

export function processIdentityKey(engine: string, identity: ProcessIdentity): string {
  return `${assertKeyPart(engine, 'engine')}${SEP}${identity.pid}${SEP}${assertKeyPart(identity.startMarker, 'process start marker')}`
}

export function sameProcessIdentity(a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean {
  return !!a && !!b && a.pid === b.pid && a.startMarker === b.startMarker
}

export function sameTerminalPlacement(a: TerminalRuntimeRef, b: TerminalRuntimeRef): boolean {
  return terminalPlacementKey(a) === terminalPlacementKey(b)
}

/** Replace a moved Herdr route without duplicating its stable placement. */
export function mergeTerminalRuntimes(
  current: readonly TerminalRuntimeRef[],
  observed: readonly TerminalRuntimeRef[],
): TerminalRuntimeRef[] {
  const merged = new Map<string, TerminalRuntimeRef>()
  for (const runtime of current) merged.set(terminalPlacementKey(runtime), runtime)
  for (const runtime of observed) merged.set(terminalPlacementKey(runtime), runtime)
  return [...merged.values()].sort((a, b) => terminalPlacementKey(a).localeCompare(terminalPlacementKey(b)))
}
