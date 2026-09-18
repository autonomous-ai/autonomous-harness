/**
 * Put `grid` on a machine that has none, with grid's own public installer.
 *
 * `harness login` used to CHECK for `grid` and, finding none, print "install the grid CLI yourself"
 * and skip the grid half of sign-in. Every fresh install — a new machine, a colleague's laptop —
 * landed there, and everything the Grid harness does shells out to `grid`, so on those
 * machines the Grid harness could only report that nothing was installed. The plan's answer
 * (`docs/plans/2026-09-14-004-harness-grid-plan.md`, Change 2c) is a signed, pinned managed
 * runtime, which is release-pipeline work nobody has done. This is the interim that closes the gap
 * today: run the installer grid itself publishes and maintains, `https://grid.autonomous.ai/install.sh`
 * — on macOS it installs `uv` if needed and `uv tool install`s the release wheel to
 * `~/.local/bin/grid`; on Linux it downloads the sha256-verified release binary to the same place.
 * Exactly the by-hand steps, run for the person.
 *
 * ⚠️ Best-effort, never a reason `harness start` or `harness login` fails. No `curl`, no network, a
 * refused download — every one is a sentence in the log and a daemon that runs as before. A
 * machine that already has `grid` is never touched; nothing here updates a binary that exists.
 *
 * Idempotent and serialised: two callers (start and a login that follows it) share one in-flight
 * install rather than racing two installers into the same directory.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { binaryOnPath } from './binaryOnPath.js'
import { gridAvailable } from './gridExec.js'

export const GRID_INSTALL_URL = 'https://grid.autonomous.ai/install.sh'

/** Where grid's installer puts the binary on both platforms — the reason `gridBinaryPath` falls
 *  back to this directory when `~/.local/bin` is not on the daemon's PATH. */
export const GRID_INSTALL_DIR = join(homedir(), '.local', 'bin')

/** A download plus, on macOS, a `uv` bootstrap and a wheel install: minutes on a slow link, never
 *  hours. Past this the installer is killed and reported, not waited on forever. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

const MAX_CAPTURED_CHARS = 16 * 1024

export type GridInstallStatus =
  /** `grid` was already there; nothing ran. */
  | 'present'
  /** The installer ran and `grid` is now resolvable. */
  | 'installed'
  /** Not attempted: switched off, or no `curl` to fetch the installer with. */
  | 'skipped'
  /** The installer ran and failed, or ran and left no `grid` behind. */
  | 'failed'

export interface GridInstallResult {
  status: GridInstallStatus
  /** One sentence for the log or stderr. Never contains a credential — the installer takes none. */
  message: string
}

export interface GridInstallDeps {
  available: () => boolean
  curlOnPath: () => boolean
  /** Run the installer; resolves with its exit code and bounded output. Injected for the tests. */
  run: (script: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }>
  enabled: boolean
}

function capped(sofar: string, chunk: Buffer): string {
  return sofar.length >= MAX_CAPTURED_CHARS ? sofar : (sofar + chunk.toString()).slice(0, MAX_CAPTURED_CHARS)
}

/** The installer, piped to bash the way its README says, with `~/.local/bin` ahead on PATH so the
 *  `uv` it may have just installed is found by the same run. */
export function runInstaller(script: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${GRID_INSTALL_DIR}:${process.env.PATH ?? ''}` },
    })
    let output = ''
    let settled = false
    const settle = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output })
    }
    const timer = setTimeout(() => {
      output = capped(output, Buffer.from(`\n(installer killed after ${Math.round(timeoutMs / 60_000)} minutes)`))
      child.kill('SIGKILL')
      settle(124)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { output = capped(output, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { output = capped(output, chunk) })
    child.on('error', (err) => { output = capped(output, Buffer.from(err.message)); settle(1) })
    child.on('close', (code) => settle(code ?? 1))
  })
}

export const defaultGridInstallDeps: GridInstallDeps = {
  available: () => gridAvailable(),
  curlOnPath: () => binaryOnPath('curl'),
  run: runInstaller,
  enabled: !env.DISABLE_GRID_INSTALL,
}

let inFlight: Promise<GridInstallResult> | null = null

/**
 * Make sure this machine has `grid`, installing it when it does not. Safe to call from anywhere and
 * as often as wanted: a machine that has it answers at once, and concurrent callers share one run.
 */
export function ensureGridInstalled(deps: GridInstallDeps = defaultGridInstallDeps): Promise<GridInstallResult> {
  if (deps.available()) return Promise.resolve({ status: 'present', message: '`grid` is installed' })
  if (!deps.enabled) return Promise.resolve({ status: 'skipped', message: 'grid install is switched off (DISABLE_GRID_INSTALL)' })
  if (!deps.curlOnPath()) {
    return Promise.resolve({ status: 'skipped', message: 'no `grid` on this machine and no `curl` to fetch its installer with — install it from ' + GRID_INSTALL_URL })
  }
  if (inFlight) return inFlight
  inFlight = (async (): Promise<GridInstallResult> => {
    try {
      const { exitCode, output } = await deps.run(`curl -fsSL ${GRID_INSTALL_URL} | bash`, INSTALL_TIMEOUT_MS)
      const tail = output.trim().split('\n').slice(-3).join(' · ').replace(/\[[0-9;]*m/g, '')
      if (exitCode !== 0) {
        return { status: 'failed', message: `grid installer exited ${exitCode}${tail ? ` · ${tail}` : ''}` }
      }
      if (!deps.available()) {
        return { status: 'failed', message: `grid installer finished but left no \`grid\` in ${GRID_INSTALL_DIR}${tail ? ` · ${tail}` : ''}` }
      }
      return { status: 'installed', message: `installed \`grid\` to ${GRID_INSTALL_DIR}` }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
