/**
 * The launcher ↔ daemon wire contract.
 *
 * ⚠ THIS FILE IS A COMPATIBILITY CONTRACT, NOT ORDINARY CODE.
 *
 * Why it has to be: OTA ships ONE bundle containing both the daemon and the launcher. The daemon
 * restarts onto the new build, but a `harness <engine>` already running is a long-lived process holding
 * the build it started with — and it CANNOT upgrade itself (its process owns the tty and is the agent's
 * parent). So a v0.0.1 launcher talking to a v9.9.9 daemon is normal, expected, and may last for hours.
 *
 * Therefore:
 *   - `v: 1` is a promise to every launcher already in the wild. You may ADD optional fields to a
 *     version. You may NOT rename, remove, retype, or reinterpret an existing field.
 *   - To change any of that, define `v: 2` and have the daemon serve BOTH. Only add to
 *     SUPPORTED_PROTOCOLS; removing an entry breaks released launchers and needs a deprecation window.
 *   - `launcherProtocol.spec.ts` pins a HAND-WRITTEN v1 frame (not one built from these types) and
 *     asserts the daemon still accepts it. That test is the contract; if it goes red, a released
 *     launcher just broke.
 *
 * The build version (`version`) is carried separately and is only informational — two different builds
 * interoperate as long as they share a protocol version.
 */

import type { AgentEngine } from '../engines/types.js'

/** Protocol version this build's launcher speaks. */
export const LAUNCHER_PROTOCOL_V = 1

/** Protocol versions this build's daemon accepts. APPEND ONLY — see the file header. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1]

/** Launcher → daemon, first frame after the socket opens. */
export interface LauncherOpenFrame {
  t: 'open'
  /** Absent on launchers released before versioning existed — treat as 1. */
  v?: number
  launcherId?: string
  engine?: AgentEngine
  tmuxPane?: string
  cwd?: string
  /**
   * Where this launcher's engine keeps its data, when that is not the daemon's default.
   *
   * muse only: it writes sessions under `XDG_DATA_HOME`, so a launcher started with a different one puts
   * its transcripts somewhere the daemon does not scan — the agent then binds to nothing and web and
   * device stay empty, with no error anywhere. The launcher is the only party that knows the environment
   * it was run with, so it says so here. Absent on older launchers, which means "the daemon's default".
   */
  dataHome?: string
  /** The launcher's BUILD, for the stale-build notice. Never used for compatibility decisions. */
  version?: string
}

/** Daemon → launcher, acknowledging a usable `open`. */
export interface LauncherOpenedFrame {
  t: 'opened'
  v: number
  /** The daemon's build — the launcher compares it with its own to tell the user a newer one is live. */
  version: string
  /** Engine binary resolved BY THE DAEMON, so binary policy can change without stranding old launchers. */
  bin?: string
  /** True when the daemon (re)installed this engine's hooks, so the launcher must not do it itself. */
  hooksReady?: boolean
}

/** Daemon → launcher, refusing the socket. The only case where a session is turned away. */
export interface LauncherErrorFrame {
  t: 'error'
  reason: 'unsupported_protocol' | 'invalid_open'
  supported?: readonly number[]
}

export type LauncherNoticeLevel = 'info' | 'warn' | 'error'

/**
 * Daemon → launcher, unprompted: put this on the pane's status line.
 *
 * The first frame the daemon sends on its own initiative rather than as an answer to `open`. It exists
 * because the daemon knows things the person in the pane does not — it restarts itself for an update mid-turn,
 * for one — and until now had no way to say so.
 *
 * **Every field is advisory and the LAUNCHER decides how to render it**, on purpose: this frame crosses a
 * version boundary (a months-old launcher, a daemon from today), so a value the launcher does not like must
 * degrade to a sane default, never to a broken status line. See `paneNotice` for the clamping and escaping —
 * the text reaches tmux's format parser, so it cannot be trusted as-is even coming from the daemon.
 */
export interface LauncherNoticeFrame {
  t: 'notice'
  text: string
  /** Absent or unknown ⇒ 'info'. Picks the colour and whether the notice survives a keypress. */
  level?: LauncherNoticeLevel
  /** Clamped by the launcher; absent ⇒ its default. */
  durationMs?: number
  /** Overrides the level's colour. Ignored unless it is a plain tmux colour name or `#rrggbb`. */
  color?: string
}

/**
 * Daemon → launcher: end this agent — stop the engine and exit.
 *
 * Sent when the agent is deleted from the web or the device. The launcher owns its own child, so asking
 * it to shut down beats the daemon reaching in and signalling processes: deleting an agent must not cost
 * the user their tmux pane, which is what killing the pane (the old behaviour) did.
 *
 * A launcher too old to know this frame ignores it, so the daemon still verifies the outcome and falls
 * back to signalling the engine directly — see `deleteAgentFallback.ts`.
 */
export interface LauncherExitFrame {
  t: 'exit'
  /** Why, for the log and the status-line notice. */
  reason?: string
}

export type LauncherDownFrame =
  | LauncherOpenedFrame
  | LauncherErrorFrame
  | LauncherNoticeFrame
  | LauncherExitFrame

/** Protocol version of an incoming frame: absent ⇒ 1 (pre-versioning launcher). */
export function frameProtocol(frame: { v?: unknown }): number {
  return typeof frame.v === 'number' ? frame.v : 1
}

export function isSupportedProtocol(v: number): boolean {
  return SUPPORTED_PROTOCOLS.includes(v)
}
