/**
 * One viewer server per DSH agent, owned by the daemon the way a terminal stream is: started when
 * the agent is, torn down with it, restarted a bounded number of times if it dies.
 *
 * The daemon picks a free loopback port and hands it to the manifest's `viewer.command` as
 * `HARNESS_VIEWER_PORT`, then waits for something to listen there before it publishes a URL — a
 * pane that navigates to a port nobody serves yet renders a connection error and never recovers.
 *
 * The URL is a template: `${port}` and `${artifact}`. The artifact is the verdict's `artifact` when
 * it names one, else the newest file under the workspace with one of `viewer.artifactExtensions`
 * (rescanned when such a file changes). Either change republishes the URL, which is how the 3D pane
 * follows the newest STEP without the DSH knowing Harness exists.
 */
import chokidar, { type FSWatcher } from 'chokidar'
import type { ChildProcess } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { isCandidateArtifact, isArtifactDirIgnored, newestArtifact } from './artifacts.js'
import { installedDsh, type InstalledDsh } from './installed.js'
import { isViewerPackage } from './manifest.js'
import { isShellNoise, killProcessGroup, spawnDshCommand } from './shell.js'

/** The viewer that will actually run for a harness: its own, or the package it points at. */
export interface ResolvedViewer {
  /** The package whose command runs: the harness itself, or the viewer package it uses. */
  id: string
  dir: string
  command: string
  url: string
  artifactExtensions: readonly string[]
}

/**
 * A harness's own viewer resolves to itself. `viewer.use` resolves through the installed index to
 * a viewer package (spec 1.1): the command and directory are the package's; the URL and the
 * extensions are the harness's when it narrows them, else the package's. Missing or wrong-kind
 * packages are named, not guessed.
 */
export function resolveViewer(
  dsh: InstalledDsh,
  lookup: (id: string) => InstalledDsh | undefined = installedDsh,
): { ok: true; viewer: ResolvedViewer } | { ok: false; error: string } {
  const viewer = dsh.manifest.viewer
  if (!viewer) return { ok: false, error: `${dsh.id} has no viewer` }
  if ('command' in viewer) {
    return { ok: true, viewer: { id: dsh.id, dir: dsh.realDir, command: viewer.command, url: viewer.url, artifactExtensions: viewer.artifactExtensions ?? [] } }
  }
  const pkg = lookup(viewer.use)
  if (!pkg) return { ok: false, error: `${dsh.id} uses viewer ${viewer.use}, which is not installed on this machine` }
  if (!isViewerPackage(pkg.manifest) || !pkg.manifest.viewer || !('command' in pkg.manifest.viewer)) {
    return { ok: false, error: `${dsh.id} uses ${viewer.use}, which is not a viewer package` }
  }
  return {
    ok: true,
    viewer: {
      id: pkg.id,
      dir: pkg.realDir,
      command: pkg.manifest.viewer.command,
      url: viewer.url ?? pkg.manifest.viewer.url,
      artifactExtensions: viewer.artifactExtensions ?? pkg.manifest.viewer.artifactExtensions ?? [],
    },
  }
}

export interface DshViewerDeps {
  /** The URL clients should show for this agent's viewer, or null when there is none right now. */
  onUrl: (agentId: string, url: string | null) => void
  log?: (line: string) => void
  /** Test seams. */
  freePort?: () => Promise<number>
  waitForPort?: (port: number, timeoutMs: number) => Promise<boolean>
  spawn?: typeof spawnDshCommand
  now?: () => number
  /** How `viewer.use` finds its package; the installed index by default. */
  lookup?: (id: string) => InstalledDsh | undefined
}

interface ViewerState {
  agentId: string
  dsh: InstalledDsh
  viewer: ResolvedViewer
  workspace: string
  port: number | null
  child: ChildProcess | null
  url: string | null
  verdictArtifact: string | null
  scannedArtifact: string | null
  watcher: FSWatcher | null
  rescanTimer: NodeJS.Timeout | null
  stopping: boolean
  /** Exit timestamps inside the restart window — three in a minute and we give up. */
  exits: number[]
  generation: number
}

const PORT_TIMEOUT_MS = 60_000
const RESTART_WINDOW_MS = 60_000
const RESTART_LIMIT = 3
const RESCAN_DEBOUNCE_MS = 300
const LOG_LINE_LIMIT = 40

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

export function waitForLoopbackPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = connect({ port, host: '127.0.0.1' })
      socket.setTimeout(1_000)
      const done = (ok: boolean): void => {
        socket.destroy()
        if (ok) { resolve(true); return }
        if (Date.now() >= deadline) { resolve(false); return }
        const timer = setTimeout(attempt, 250)
        timer.unref?.()
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.once('timeout', () => done(false))
    }
    attempt()
  })
}

/** The template with its two variables filled; the artifact is url-encoded per path segment. */
export function buildViewerUrl(template: string, port: number, artifact: string | null): string {
  const encoded = artifact ? artifact.split('/').map(encodeURIComponent).join('/') : ''
  return template.replace(/\$\{port\}/g, String(port)).replace(/\$\{artifact\}/g, encoded)
}

export class DshViewerManager {
  private readonly states = new Map<string, ViewerState>()

  constructor(private readonly deps: DshViewerDeps) {}

  private log(line: string): void {
    this.deps.log?.(line)
  }

  url(agentId: string): string | null {
    return this.states.get(agentId)?.url ?? null
  }

  /** Idempotent: the same agent, DSH and workspace keep their running viewer. */
  async start(agentId: string, dsh: InstalledDsh, workspace: string): Promise<void> {
    if (!dsh.manifest.viewer) return
    const resolved = resolveViewer(dsh, this.deps.lookup)
    if (!resolved.ok) {
      this.log(`[dsh] ${resolved.error} · agent ${agentId.slice(0, 8)} has no viewer pane`)
      return
    }
    const viewer = resolved.viewer
    const current = this.states.get(agentId)
    if (current && current.dsh.realDir === dsh.realDir && current.viewer.dir === viewer.dir && current.workspace === workspace && !current.stopping) return
    if (current) await this.stop(agentId)
    const state: ViewerState = {
      agentId, dsh, viewer, workspace, port: null, child: null, url: null,
      verdictArtifact: null, scannedArtifact: null, watcher: null, rescanTimer: null,
      stopping: false, exits: [], generation: 0,
    }
    this.states.set(agentId, state)
    if (viewer.artifactExtensions.length) {
      state.scannedArtifact = newestArtifact(workspace, viewer.artifactExtensions)?.path ?? null
      this.watchArtifacts(state, viewer.artifactExtensions)
    }
    await this.launch(state)
  }

  /** The verdict named (or stopped naming) an artifact. */
  setVerdictArtifact(agentId: string, artifact: string | null): void {
    const state = this.states.get(agentId)
    if (!state || state.verdictArtifact === artifact) return
    state.verdictArtifact = artifact
    this.publish(state)
  }

  private effectiveArtifact(state: ViewerState): string | null {
    return state.verdictArtifact ?? state.scannedArtifact
  }

  private publish(state: ViewerState): void {
    const url = state.port !== null && state.child
      ? buildViewerUrl(state.viewer.url, state.port, this.effectiveArtifact(state))
      : null
    if (url === state.url) return
    state.url = url
    this.deps.onUrl(state.agentId, url)
  }

  private watchArtifacts(state: ViewerState, extensions: readonly string[]): void {
    const watcher = chokidar.watch(state.workspace, {
      ignoreInitial: true,
      persistent: true,
      depth: 6,
      ignored: (path: string) => path !== state.workspace
        && path.slice(state.workspace.length).split(/[\\/]/).some((segment) => segment && (isArtifactDirIgnored(segment) || segment.startsWith('.'))),
    })
    const bump = (path: string): void => {
      if (!isCandidateArtifact(path, extensions)) return
      if (state.rescanTimer) clearTimeout(state.rescanTimer)
      state.rescanTimer = setTimeout(() => {
        state.rescanTimer = null
        const next = newestArtifact(state.workspace, extensions)?.path ?? null
        if (next === state.scannedArtifact) return
        state.scannedArtifact = next
        this.publish(state)
      }, RESCAN_DEBOUNCE_MS)
      state.rescanTimer.unref?.()
    }
    watcher.on('add', bump).on('change', bump).on('unlink', bump)
      .on('error', (error: unknown) => this.log(`[dsh] artifact watch error · ${error instanceof Error ? error.message : error}`))
    state.watcher = watcher
  }

  private async launch(state: ViewerState): Promise<void> {
    const viewer = state.viewer
    const generation = ++state.generation
    let port: number
    try {
      port = await (this.deps.freePort ?? freeLoopbackPort)()
    } catch (error) {
      this.log(`[dsh] ${state.dsh.id} viewer: no free port · ${error instanceof Error ? error.message : error}`)
      return
    }
    if (state.stopping || state.generation !== generation) return
    state.port = port
    // A used viewer runs in ITS directory with ITS files, and is told which harness it draws for:
    // HARNESS_DSH/_DIR stay the harness's (the contract every DSH script relies on), HARNESS_VIEWER
    // and HARNESS_VIEWER_DIR name the package. A harness's own viewer sees both pairs agree.
    const child = (this.deps.spawn ?? spawnDshCommand)(viewer.command, {
      cwd: viewer.dir,
      env: {
        HARNESS_DSH: state.dsh.id,
        HARNESS_DSH_DIR: state.dsh.realDir,
        HARNESS_VIEWER: viewer.id,
        HARNESS_VIEWER_DIR: viewer.dir,
        HARNESS_WORKSPACE: state.workspace,
        HARNESS_VIEWER_PORT: String(port),
      },
    })
    state.child = child
    let logged = 0
    const onData = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim() || isShellNoise(line)) continue
        if (logged++ < LOG_LINE_LIMIT) this.log(`[dsh] ${state.dsh.id} viewer · ${line}`)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => this.log(`[dsh] ${state.dsh.id} viewer could not start · ${error.message}`))
    child.on('exit', (code, signal) => {
      if (state.child !== child) return
      state.child = null
      state.port = null
      this.publish(state)
      if (state.stopping) return
      const now = (this.deps.now ?? Date.now)()
      state.exits = [...state.exits.filter((at) => now - at < RESTART_WINDOW_MS), now]
      if (state.exits.length > RESTART_LIMIT) {
        this.log(`[dsh] ${state.dsh.id} viewer exited ${code ?? signal} ${RESTART_LIMIT + 1} times in a minute · giving up`)
        return
      }
      const delay = 1_000 * 2 ** (state.exits.length - 1)
      this.log(`[dsh] ${state.dsh.id} viewer exited ${code ?? signal} · restarting in ${delay}ms`)
      const timer = setTimeout(() => { void this.launch(state) }, delay)
      timer.unref?.()
    })
    const up = await (this.deps.waitForPort ?? waitForLoopbackPort)(port, PORT_TIMEOUT_MS)
    if (state.child !== child || state.stopping) return
    if (!up) {
      this.log(`[dsh] ${state.dsh.id} viewer did not listen on ${port} within ${PORT_TIMEOUT_MS / 1000}s`)
      killProcessGroup(child)
      return
    }
    this.log(`[dsh] ${state.dsh.id} viewer up on 127.0.0.1:${port} for ${state.workspace}`)
    this.publish(state)
  }

  async stop(agentId: string): Promise<void> {
    const state = this.states.get(agentId)
    if (!state) return
    state.stopping = true
    this.states.delete(agentId)
    if (state.rescanTimer) clearTimeout(state.rescanTimer)
    if (state.watcher) await state.watcher.close().catch(() => undefined)
    const child = state.child
    state.child = null
    state.port = null
    if (child) killProcessGroup(child)
    if (state.url !== null) {
      state.url = null
      this.deps.onUrl(agentId, null)
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((agentId) => this.stop(agentId)))
  }
}
