/**
 * `harness dsh install`: clone (or link) a DSH repo under `~/.harness/dsh/<owner>/<name>`, run its
 * setup once, run its doctor, and record it in the index. The same function backs the desktop's
 * "Harness will install Circuit on this machine before starting" — the phases it reports are the
 * `dsh_install_status` frames the app shows.
 *
 * The clone lands in a temporary directory first, because the install path is derived from the
 * manifest's own id — which we cannot know until the clone exists. A manifest that fails to parse
 * leaves nothing behind.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  dshInstallDir, dshRootDir, installedDsh, readInstalledIndex, removeInstalledRecord, resolveInstalled,
  upsertInstalledRecord, isBrokenDsh, type InstalledDsh, type InstalledDshRecord,
} from './installed.js'
import { readDshManifest, viewerUse, type DshManifest } from './manifest.js'
import { registryEntry } from './registry.js'
import { runDshCommand } from './shell.js'

const execFileAsync = promisify(execFile)

export type DshInstallPhase = 'clone' | 'setup' | 'doctor' | 'done' | 'failed'

export interface DshInstallProgress {
  /** Known once the manifest has been read; null while cloning by URL. */
  id: string | null
  phase: DshInstallPhase
  detail?: string
  /**
   * The latest line the phase's command printed — what the install is ON right now, for a dialog
   * that would otherwise say "Setting up…" for three minutes. Sent by the daemon's narrator, not by
   * installDsh itself (which reports lines through `onLine`), throttled to a few a second.
   */
  line?: string
}

export interface DshInstallOptions {
  /** A git URL, or a local path (cloned unless `link`). */
  source: string
  ref?: string
  /** Symlink a local checkout instead of cloning it — the development loop. */
  link?: boolean
  onProgress?: (progress: DshInstallProgress) => void
  /** Setup/doctor output, line by line. */
  onLine?: (line: string) => void
  setupTimeoutMs?: number
}

export interface DshDoctorResult {
  ok: boolean
  lines: string[]
}

export type DshInstallResult =
  | { ok: true; installed: InstalledDsh; doctor: DshDoctorResult; setupLines: string[] }
  | { ok: false; error: string; detail: string }

/** A registry id (`autonomous/copper`) resolves to its repo and ref; anything else is a source. */
export function resolveInstallSource(idOrSource: string): { source: string; ref?: string; id?: string } | null {
  const entry = registryEntry(idOrSource)
  if (entry) return { source: entry.repo, ref: entry.ref, id: entry.id }
  if (!idOrSource || /[\x00-\x1f\x7f]/.test(idOrSource)) return null
  return { source: idOrSource }
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 10_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function linkInstall(source: string): { ok: true; realDir: string; manifest: DshManifest } | { ok: false; error: string; detail: string } {
  if (!isAbsolute(source)) return { ok: false, error: 'INVALID_SOURCE', detail: '--link needs an absolute path to a checkout' }
  let realDir: string
  try {
    realDir = realpathSync(source)
  } catch {
    return { ok: false, error: 'SOURCE_NOT_FOUND', detail: `${source} does not exist` }
  }
  const manifest = readDshManifest(realDir)
  if (!manifest.ok) return { ok: false, error: 'INVALID_MANIFEST', detail: manifest.error }
  return { ok: true, realDir, manifest: manifest.manifest }
}

async function cloneInstall(
  source: string,
  ref: string | undefined,
  onLine: ((line: string) => void) | undefined,
): Promise<{ ok: true; tmpDir: string; manifest: DshManifest; commit: string | null } | { ok: false; error: string; detail: string }> {
  const root = dshRootDir()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const tmpDir = join(root, `.tmp-${randomUUID()}`)
  // `--progress` because stderr is not a tty here and git would otherwise stay silent until the end;
  // streamed, not collected, so "Receiving objects: 39%" reaches the dialog while it is true.
  const args = ['clone', '--depth', '1', '--progress', ...(ref ? ['--branch', ref] : []), '--', source, tmpDir]
  const clone = await streamGit(args, onLine)
  if (!clone.ok) {
    rmSync(tmpDir, { recursive: true, force: true })
    return { ok: false, error: 'CLONE_FAILED', detail: clone.detail.slice(0, 2000) }
  }
  const manifest = readDshManifest(tmpDir)
  if (!manifest.ok) {
    rmSync(tmpDir, { recursive: true, force: true })
    return { ok: false, error: 'INVALID_MANIFEST', detail: manifest.error }
  }
  return { ok: true, tmpDir, manifest: manifest.manifest, commit: await gitHead(tmpDir) }
}

/** Run git, handing each stderr line (and each carriage-return progress segment) to `onLine` as it lands. */
function streamGit(args: string[], onLine: ((line: string) => void) | undefined): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const tail: string[] = []
    let rest = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      let at: number
      while ((at = rest.search(/[\r\n]/)) >= 0) {
        const line = rest.slice(0, at).trim()
        rest = rest.slice(at + 1)
        if (!line) continue
        onLine?.(line)
        tail.push(line)
        if (tail.length > 20) tail.shift()
      }
    })
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, detail: error.message }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (rest.trim()) { onLine?.(rest.trim()); tail.push(rest.trim()) }
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, detail: `git ${args[0]} exited ${code}: ${tail.filter((l) => !/^(Receiving|Resolving|Updating|remote:)/.test(l)).slice(-3).join(' · ') || tail.slice(-1).join('')}` })
    })
  })
}

/** Put the clone (or the link) at its final path, replacing whatever an earlier install left there. */
function placeAt(id: string, from: { tmpDir: string } | { linkTo: string }): string {
  const dir = dshInstallDir(id)
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(dir) } catch { existing = null }
  if (existing) rmSync(dir, { recursive: true, force: true })
  if ('tmpDir' in from) renameSync(from.tmpDir, dir)
  else symlinkSync(from.linkTo, dir)
  return dir
}

/**
 * How long a doctor may take. Five minutes, not one: the FIRST run after setup is the slow one — a
 * check like Solid's `import cadgen, build123d` loads OCP and vtk from packages downloaded seconds
 * ago, and macOS verifies every one of those dylibs on first load. Measured 2026-09-16: over two
 * minutes cold, five seconds warm. At 60s the install reported "doctor failed" after two `ok` lines
 * on a machine that was fine.
 */
export const DOCTOR_TIMEOUT_MS = 5 * 60_000

export async function runDshDoctor(installed: InstalledDsh, onLine?: (line: string) => void): Promise<DshDoctorResult> {
  const doctor = installed.manifest.toolchain?.doctor
  if (!doctor) return { ok: true, lines: [] }
  const result = await runDshCommand(doctor, {
    cwd: installed.realDir,
    env: { HARNESS_DSH: installed.id, HARNESS_DSH_DIR: installed.realDir },
    onLine,
    timeoutMs: DOCTOR_TIMEOUT_MS,
  })
  if (result.timedOut) {
    // Said as what it is. A timeout reported as "failed" with the last three (passing) lines under
    // it reads as a machine with a fault nobody can find.
    const line = `miss doctor still running after ${DOCTOR_TIMEOUT_MS / 60_000} min — stopped; run \`harness dsh doctor ${installed.id}\` again`
    result.lines.push(line)
    onLine?.(line)
  }
  return { ok: result.code === 0 && !result.timedOut, lines: result.lines }
}

export async function installDsh(opts: DshInstallOptions): Promise<DshInstallResult> {
  const progress = (p: DshInstallProgress): void => opts.onProgress?.(p)
  let manifest: DshManifest
  let dir: string
  let commit: string | null = null
  let realDir: string

  progress({ id: null, phase: 'clone', detail: opts.link ? `linking ${opts.source}` : `cloning ${opts.source}` })
  if (opts.link) {
    const linked = linkInstall(opts.source)
    if (!linked.ok) { progress({ id: null, phase: 'failed', detail: linked.detail }); return linked }
    manifest = linked.manifest
    realDir = linked.realDir
    dir = placeAt(manifest.id, { linkTo: realDir })
    commit = await gitHead(realDir)
  } else {
    const cloned = await cloneInstall(opts.source, opts.ref, opts.onLine)
    if (!cloned.ok) { progress({ id: null, phase: 'failed', detail: cloned.detail }); return cloned }
    manifest = cloned.manifest
    commit = cloned.commit
    dir = placeAt(manifest.id, { tmpDir: cloned.tmpDir })
    realDir = realpathSync(dir)
  }

  const record: InstalledDshRecord = {
    id: manifest.id,
    dir,
    source: opts.link ? resolve(opts.source) : opts.source,
    ref: opts.ref ?? null,
    commit,
    linked: opts.link === true,
    installedAt: Date.now(),
  }
  const resolved = resolveInstalled(record)
  if (isBrokenDsh(resolved)) {
    progress({ id: manifest.id, phase: 'failed', detail: resolved.error })
    return { ok: false, error: 'INVALID_MANIFEST', detail: resolved.error }
  }

  const setupLines: string[] = []
  if (manifest.toolchain?.setup) {
    progress({ id: manifest.id, phase: 'setup', detail: manifest.toolchain.setup })
    const setup = await runDshCommand(manifest.toolchain.setup, {
      cwd: realDir,
      env: { HARNESS_DSH: manifest.id, HARNESS_DSH_DIR: realDir },
      onLine: (line) => { setupLines.push(line); opts.onLine?.(line) },
      timeoutMs: opts.setupTimeoutMs ?? 30 * 60_000,
    })
    if (setup.code !== 0 || setup.timedOut) {
      const detail = setup.timedOut
        ? 'setup timed out'
        : `setup exited ${setup.code ?? setup.signal} · ${setup.lines.slice(-5).join(' · ')}`.slice(0, 2000)
      progress({ id: manifest.id, phase: 'failed', detail })
      return { ok: false, error: 'SETUP_FAILED', detail }
    }
  }

  // The viewer it points at is part of the install: without it the tile opens with no pane. The
  // registry names the package's repo; a package not in the registry is the author's to install
  // first (`harness dsh install <url>`), and the doctor says so rather than the pane going blank.
  const uses = viewerUse(manifest)
  if (uses && !installedDsh(uses)) {
    const entry = registryEntry(uses)
    if (entry) {
      opts.onLine?.(`viewer ${uses} · installing`)
      const dep = await installDsh({ source: entry.repo, ref: entry.ref, onProgress: opts.onProgress, onLine: opts.onLine, setupTimeoutMs: opts.setupTimeoutMs })
      if (!dep.ok) {
        const detail = `viewer ${uses} · ${dep.detail}`.slice(0, 2000)
        progress({ id: manifest.id, phase: 'failed', detail })
        return { ok: false, error: dep.error, detail }
      }
    } else {
      opts.onLine?.(`miss viewer ${uses} is not installed and not in the registry · install it first`)
    }
  }

  progress({ id: manifest.id, phase: 'doctor' })
  const doctor = await runDshDoctor(resolved, opts.onLine)
  // Recorded even when the doctor complains: the user can fix the machine and run the doctor again
  // without re-cloning. The desktop reads the doctor's answer, not the index, before a create.
  upsertInstalledRecord(record)
  if (!doctor.ok) {
    const detail = `doctor failed · ${doctor.lines.filter((line) => line.startsWith('miss')).join(' · ') || doctor.lines.slice(-3).join(' · ')}`.slice(0, 2000)
    progress({ id: manifest.id, phase: 'failed', detail })
    return { ok: false, error: 'DOCTOR_FAILED', detail }
  }
  progress({ id: manifest.id, phase: 'done' })
  return { ok: true, installed: resolved, doctor, setupLines }
}

export function removeDsh(id: string): { ok: true } | { ok: false; error: string; detail: string } {
  const record = readInstalledIndex().find((row) => row.id === id)
  if (!record) return { ok: false, error: 'NOT_INSTALLED', detail: `${id} is not installed` }
  try {
    // A linked install is a symlink: remove the link, never the checkout it points at.
    let isLink = false
    try { isLink = lstatSync(record.dir).isSymbolicLink() } catch { isLink = false }
    if (isLink) rmSync(record.dir, { force: true })
    else if (existsSync(record.dir)) rmSync(record.dir, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: 'REMOVE_FAILED', detail: error instanceof Error ? error.message : String(error) }
  }
  removeInstalledRecord(id)
  return { ok: true }
}

export { installedDsh }
