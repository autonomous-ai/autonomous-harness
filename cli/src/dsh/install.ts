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
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  dshInstallDir, dshRootDir, installedDsh, readInstalledIndex, removeInstalledRecord, upsertInstalledRecord,
  type InstalledDsh, type InstalledDshRecord,
} from './installed.js'
import { readDshManifest, viewerUse, type DshManifest } from './manifest.js'
import { PACKAGE_PATH_RE, type DshRegistryEntry } from './registry.js'
import { catalogEntry, refreshDshRegistry } from './catalog.js'
import { resolveDshCommand } from './materialize.js'
import { runDshCommand } from './shell.js'
import { lockDsh, dshBusy } from './lock.js'

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
  /** A catalog install must resolve to the package the user selected. */
  expectedId?: string
  ref?: string
  /**
   * The folder inside `source` that is the package (`store/agents/typst` of the Harness monorepo).
   * Only that folder is fetched — a sparse, blob-less clone — and only that folder is installed.
   */
  path?: string
  /** Symlink a local checkout instead of cloning it — the development loop. */
  link?: boolean
  onProgress?: (progress: DshInstallProgress) => void
  /** Setup/doctor output, line by line. */
  onLine?: (line: string) => void
  setupTimeoutMs?: number
  /** Where a `viewer.use` id resolves to a repo; the bundled registry by default. Test seam. */
  registry?: (id: string) => DshRegistryEntry | undefined
}

export interface DshDoctorResult {
  ok: boolean
  lines: string[]
}

export type DshInstallResult =
  | { ok: true; installed: InstalledDsh; doctor: DshDoctorResult; setupLines: string[] }
  | { ok: false; error: string; detail: string }

/** A registry id (`autonomous/typst`) resolves to its repo, ref and folder; anything else is a source. */
export function resolveInstallSource(
  idOrSource: string,
  registry: (id: string) => DshRegistryEntry | undefined = catalogEntry,
): { source: string; ref?: string; path?: string; id?: string } | null {
  const entry = registry(idOrSource)
  if (entry) return { source: entry.repo, ref: entry.ref, ...(entry.path ? { path: entry.path } : {}), id: entry.id }
  if (!idOrSource || /[\x00-\x1f\x7f]/.test(idOrSource)) return null
  return { source: idOrSource }
}

async function gitHead(dir: string, revision = 'HEAD'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', revision], { timeout: 10_000 })
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
  // Placing the link first clears the install directory. When the checkout IS that directory (a clone
  // installed earlier), or lives inside it, that would delete the only copy before linking to it.
  const installDir = dshInstallDir(manifest.manifest.id)
  let placed: ReturnType<typeof lstatSync> | null = null
  try { placed = lstatSync(installDir) } catch { placed = null }
  if (placed && !placed.isSymbolicLink()) {
    const installed = realpathSync(installDir)
    if (realDir === installed || realDir.startsWith(installed + sep)) {
      return { ok: false, error: 'INVALID_SOURCE', detail: `${source} is inside the installed copy of ${manifest.manifest.id}; link a checkout that lives elsewhere` }
    }
  }
  return { ok: true, realDir, manifest: manifest.manifest }
}

export async function cloneInstall(
  source: string,
  ref: string | undefined,
  path: string | undefined,
  onLine: ((line: string) => void) | undefined,
): Promise<{ ok: true; tmpDir: string; manifest: DshManifest; commit: string | null; revision: string | null } | { ok: false; error: string; detail: string }> {
  const root = dshRootDir()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const tmpDir = join(root, `.tmp-${randomUUID()}`)
  const fail = (error: string, detail: string, ...dirs: string[]): { ok: false; error: string; detail: string } => {
    for (const dir of [tmpDir, ...dirs]) rmSync(dir, { recursive: true, force: true })
    return { ok: false, error, detail: detail.slice(0, 2000) }
  }
  if (path !== undefined && !PACKAGE_PATH_RE.test(path)) return fail('INVALID_SOURCE', `${path} is not a folder inside the repo`)
  let commit: string | null
  let revision: string | null
  if (path === undefined) {
    // `--progress` because stderr is not a tty here and git would otherwise stay silent until the end;
    // streamed, not collected, so "Receiving objects: 39%" reaches the dialog while it is true.
    const clone = await cloneRepo(source, ref, tmpDir, false, onLine)
    if (!clone.ok) return fail('CLONE_FAILED', clone.detail)
    commit = await gitHead(tmpDir)
    revision = await gitHead(tmpDir, 'HEAD^{tree}')
  } else {
    // A package that is ONE FOLDER of a bigger repo — the built-in shelf is `store/*/*` of the Harness
    // monorepo, whose other folders are the app, the CLI and the backend. A blob-less, sparse clone
    // fetches the tree of one commit and the file contents of that folder alone; the folder is then
    // moved out and the rest of the clone thrown away, so the install is laid out exactly like a
    // whole-repo one (the manifest at its root) and nothing else of the monorepo lands on the machine.
    const repoDir = join(root, `.tmp-${randomUUID()}`)
    const clone = await cloneRepo(source, ref, repoDir, true, onLine)
    if (!clone.ok) return fail('CLONE_FAILED', clone.detail, repoDir)
    const sparse = await streamGit(['-C', repoDir, 'sparse-checkout', 'set', '--', path], onLine)
    if (!sparse.ok) return fail('CLONE_FAILED', sparse.detail, repoDir)
    const folder = join(repoDir, ...path.split('/'))
    let isFolder = false
    try { isFolder = lstatSync(folder).isDirectory() } catch { isFolder = false }
    if (!isFolder) return fail('CLONE_FAILED', `${source}${ref ? ` at ${ref}` : ''} has no folder ${path}`, repoDir)
    commit = await gitHead(repoDir)
    revision = await gitHead(repoDir, `HEAD:${path}`)
    renameSync(folder, tmpDir)
    rmSync(repoDir, { recursive: true, force: true })
  }
  const manifest = readDshManifest(tmpDir)
  if (!manifest.ok) return fail('INVALID_MANIFEST', manifest.error)
  return { ok: true, tmpDir, manifest: manifest.manifest, commit, revision }
}

/** How long one git command may take: a clone of a large repository over a slow link, not a hang. */
const GIT_TIMEOUT_MS = 10 * 60_000

/** Catalogs pin built-ins to the commit they describe; `git clone --branch` cannot take a SHA. */
async function cloneRepo(source: string, ref: string | undefined, dir: string, sparse: boolean, onLine: DshInstallOptions['onLine']): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!ref || !/^[a-f0-9]{40}$/i.test(ref)) {
    return streamGit(['clone', '--depth', '1', ...(sparse ? ['--filter=blob:none', '--sparse'] : []), '--progress', ...(ref ? ['--branch', ref] : []), '--', source, dir], onLine)
  }
  const steps = [
    ['init', '--quiet', dir],
    ['-C', dir, 'remote', 'add', 'origin', source],
    ['-C', dir, 'fetch', '--depth', '1', ...(sparse ? ['--filter=blob:none'] : []), '--progress', 'origin', ref],
    ...(sparse ? [['-C', dir, 'sparse-checkout', 'init', '--cone']] : []),
    ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'],
  ]
  for (const args of steps) {
    const result = await streamGit(args, onLine)
    if (!result.ok) return result
  }
  return { ok: true }
}

/** Run git, handing each stderr line (and each carriage-return progress segment) to `onLine` as it lands. */
function streamGit(args: string[], onLine: ((line: string) => void) | undefined): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const tail: string[] = []
    let rest = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, GIT_TIMEOUT_MS)
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
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (rest.trim()) { onLine?.(rest.trim()); tail.push(rest.trim()) }
      if (code === 0) { resolve({ ok: true }); return }
      const what = `git ${args[0] === '-C' ? args[2] : args[0]}`
      const said = tail.filter((l) => !/^(Receiving|Resolving|Updating|remote:)/.test(l)).slice(-3).join(' · ') || tail.slice(-1).join('')
      const how = timedOut ? `${what} was still running after ${GIT_TIMEOUT_MS / 60_000} min` : `${what} exited ${code ?? signal}`
      resolve({ ok: false, detail: said ? `${how}: ${said}` : how })
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
  // Resolved inside the harness, as check.ts reads it: a bare `doctor.sh` is that file, not a PATH lookup.
  const result = await runDshCommand(resolveDshCommand(installed, doctor), {
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
  const wrongId = (actual: string): DshInstallResult => {
    const detail = `Catalog requested ${opts.expectedId}, but the package declares ${actual}`
    progress({ id: opts.expectedId ?? null, phase: 'failed', detail })
    return { ok: false, error: 'PACKAGE_ID_MISMATCH', detail }
  }
  let manifest: DshManifest
  let dir: string
  let commit: string | null = null
  let realDir: string
  let revision: string | null = null
  let unlock: (() => void) | null = null
  let staged: string | null = null

  try {
    progress({ id: null, phase: 'clone', detail: opts.link ? `linking ${opts.source}` : `cloning ${opts.source}${opts.path ? ` · ${opts.path}` : ''}` })
    if (opts.link) {
      const linked = linkInstall(opts.source)
      if (!linked.ok) { progress({ id: null, phase: 'failed', detail: linked.detail }); return linked }
      manifest = linked.manifest
      if (opts.expectedId && manifest.id !== opts.expectedId) return wrongId(manifest.id)
      unlock = lockDsh(manifest.id)
      if (!unlock) return dshBusy(manifest.id)
      realDir = linked.realDir
      dir = placeAt(manifest.id, { linkTo: realDir })
      commit = await gitHead(realDir)
    } else {
      const cloned = await cloneInstall(opts.source, opts.ref, opts.path, opts.onLine)
      if (!cloned.ok) { progress({ id: null, phase: 'failed', detail: cloned.detail }); return cloned }
      staged = cloned.tmpDir
      manifest = cloned.manifest
      if (opts.expectedId && manifest.id !== opts.expectedId) {
        rmSync(cloned.tmpDir, { recursive: true, force: true })
        return wrongId(manifest.id)
      }
      unlock = lockDsh(manifest.id)
      if (!unlock) return dshBusy(manifest.id)
      commit = cloned.commit
      revision = cloned.revision
      dir = placeAt(manifest.id, { tmpDir: cloned.tmpDir })
      realDir = realpathSync(dir)
    }

    const record: InstalledDshRecord = {
      id: manifest.id,
      dir,
      source: opts.link || existsSync(opts.source) ? resolve(opts.source) : opts.source,
      ref: opts.ref ?? null,
      ...(opts.link || !opts.path ? {} : { path: opts.path }),
      commit,
      revision,
      linked: opts.link === true,
      installedAt: Date.now(),
    }
    return await finishInstall({ ...record, manifest, realDir }, opts, true)
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true })
    unlock?.()
  }
}

/** Run at the permanent path: venvs and generated launchers often embed it. */
export async function finishInstall(resolved: InstalledDsh, opts: DshInstallOptions, recordDoctorFailure: boolean): Promise<DshInstallResult> {
  const { manifest, realDir } = resolved
  const progress = (p: DshInstallProgress): void => opts.onProgress?.(p)

  const setupLines: string[] = []
  if (manifest.toolchain?.setup) {
    progress({ id: manifest.id, phase: 'setup', detail: manifest.toolchain.setup })
    const setup = await runDshCommand(resolveDshCommand({ realDir }, manifest.toolchain.setup), {
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
    if (!opts.registry && !catalogEntry(uses)) await refreshDshRegistry()
    const entry = (opts.registry ?? catalogEntry)(uses)
    if (entry) {
      opts.onLine?.(`viewer ${uses} · installing`)
      // The viewer's own phases are narrated UNDER THE HARNESS: the dialog watches the id it asked
      // for, and a frame carrying the viewer's id would land in a run nobody is looking at — the
      // install would read as hung for the minutes OpenCascade takes to arrive. The viewer's `done`
      // is not the harness's done, so it reports as the harness's setup still going.
      const dep = await installDsh({
        source: entry.repo, expectedId: entry.id, ref: entry.ref, path: entry.path, registry: opts.registry, setupTimeoutMs: opts.setupTimeoutMs, onLine: opts.onLine,
        onProgress: (p) => {
          if (p.phase === 'failed') return // reported below, once, with the viewer named
          const phase: DshInstallPhase = p.phase === 'done' ? 'setup' : p.phase
          progress({ id: manifest.id, phase, detail: `viewer ${uses} · ${p.phase}${p.detail ? ` · ${p.detail}` : ''}`.slice(0, 300) })
        },
      })
      if (!dep.ok) {
        const detail = `viewer ${uses} · ${dep.detail}`.slice(0, 2000)
        progress({ id: manifest.id, phase: 'failed', detail })
        return { ok: false, error: dep.error, detail }
      }
      progress({ id: manifest.id, phase: 'setup', detail: `viewer ${uses} · installed` })
    } else {
      opts.onLine?.(`miss viewer ${uses} is not installed and not in the registry · install it first`)
    }
  }

  if (!recordDoctorFailure && uses && installedDsh(uses)?.manifest.kind !== 'viewer') {
    const detail = `viewer ${uses} is not available; the previous package will be kept`
    progress({ id: manifest.id, phase: 'failed', detail })
    return { ok: false, error: 'VIEWER_UNAVAILABLE', detail }
  }

  progress({ id: manifest.id, phase: 'doctor' })
  const doctor = await runDshDoctor(resolved, opts.onLine)
  // Recorded even when the doctor complains: the user can fix the machine and run the doctor again
  // without re-cloning. The desktop reads the doctor's answer, not the index, before a create.
  if (doctor.ok || recordDoctorFailure) {
    const { manifest: _manifest, realDir: _realDir, ...record } = resolved
    upsertInstalledRecord(record)
  }
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
  const unlock = lockDsh(id)
  if (!unlock) return dshBusy(id)
  try {
    try {
      // A linked install is a symlink: remove the link, never the checkout it points at.
      let isLink = false
      try { isLink = lstatSync(record.dir).isSymbolicLink() } catch { isLink = false }
      if (isLink) rmSync(record.dir, { force: true })
      else if (existsSync(record.dir)) rmSync(record.dir, { recursive: true, force: true })
    } catch (error) {
      // rmSync throws only system errors (EACCES, EBUSY).
      return { ok: false, error: 'REMOVE_FAILED', detail: (error as Error).message }
    }
    removeInstalledRecord(id)
    return { ok: true }
  } finally { unlock() }
}

export { installedDsh }
