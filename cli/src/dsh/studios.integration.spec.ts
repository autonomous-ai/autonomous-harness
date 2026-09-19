// Explicit opt-in: these checks run the real package installers and native local simulations.
// All index entries and workspaces stay in disposable directories.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { installDsh, removeDsh } from './install.js'
import { installedDsh, invalidateInstalledDsh, listInstalledDsh } from './installed.js'
import { materializeWorkspace } from './materialize.js'
import { DshViewerManager } from './viewer.js'

const store = realpathSync(fileURLToPath(new URL('../../../store/', import.meta.url)))

// The viewer's /api/state, as loosely as this test reads it. `Response.json()` is `unknown` under this
// tsconfig, and the release gate is `tsc --noEmit` — an unshaped read here would hold up a CLI release.
type ViewerStateJson = Record<string, any>
const stateOf = async (url: string): Promise<ViewerStateJson> => (await (await fetch(url)).json()) as ViewerStateJson
const packages = ['juce-agent-toolkit', 'foam-agent', 'autoresearch-mlx', 'ableton-ai', 'dimos', 'simskill', 'bonsai-mcp', 'comfy-mcp']

describe.runIf(process.env.HARNESS_STUDIO_INTEGRATION === '1')('specialist studios through the real Harness lifecycle', () => {
  let root: string
  let savedRoot: string
  let manager: DshViewerManager
  const report: { name: string; checks: string[] }[] = []
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-studio-lifecycle-')))
    savedRoot = env.DSH_DIR
    env.DSH_DIR = join(root, 'installed')
    invalidateInstalledDsh()
    manager = new DshViewerManager({ onUrl: () => {} })
    const viewer = await installDsh({ source: join(store, 'viewers/studio-viewer'), link: true })
    expect(viewer.ok, JSON.stringify(viewer)).toBe(true)
  }, 120_000)
  afterAll(async () => {
    await manager?.stopAll()
    const output = join(store, 'viewers/studio-viewer/test-results')
    mkdirSync(output, { recursive: true })
    if (report.length) writeFileSync(join(output, 'lifecycle-report.json'), JSON.stringify(report, null, 2))
    env.DSH_DIR = savedRoot
    invalidateInstalledDsh()
    if (root) rmSync(root, { recursive: true, force: true })
  })
  for (const name of packages) it(`${name}: installs, initializes, launches, runs, restores and removes`, async () => {
    const phases: string[] = []
    const result = await installDsh({ source: join(store, 'agents', name), expectedId: `autonomous/${name}`, link: true,
      setupTimeoutMs: 600_000, onProgress: p => phases.push(p.phase) })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(phases).toEqual(['clone', 'setup', 'doctor', 'done'])
    expect(installedDsh(result.installed.id)?.realDir).toBe(result.installed.realDir)
    const workspace = join(root, `workspace ${name}`)
    mkdirSync(workspace)
    const materialized = await materializeWorkspace(result.installed, workspace)
    expect(materialized.warnings).toEqual([])
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain(`autonomous/${name}`)
    expect(lstatSync(join(workspace, '.agents/skills', name)).isSymbolicLink()).toBe(true)
    const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
    expect(verdict.ready).toBe(true)
    expect(existsSync(join(workspace, verdict.artifact))).toBe(true)
    await manager.start(name, result.installed, workspace)
    const url = manager.url(name)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const first = await stateOf(`${url}api/state`)
    expect(first.history).toHaveLength(1)
    const run = await fetch(`${url}api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: first.config.actions[0].id, parameters: first.project.parameters, revision: first.revision }) })
    expect(run.status).toBe(202)
    await expect.poll(async () => (await stateOf(`${url}api/state`)).job.status, { timeout: 120_000, interval: 300 }).toBe('done')
    const current = await stateOf(`${url}api/state`)
    expect(current.history).toHaveLength(2)
    for (const artifact of current.result.artifacts) expect((await fetch(`${url}artifacts/${artifact.path}`)).status).toBe(200)
    await manager.stop(name)
    expect(manager.url(name)).toBe(null)
    const again = await materializeWorkspace(result.installed, workspace)
    expect(again.created).toEqual([])
    expect(again.initLines).toEqual([])
    await manager.start(name, result.installed, workspace)
    const restored = await stateOf(`${manager.url(name)}api/state`)
    expect(restored.result.id).toBe(current.result.id)
    expect(restored.history).toHaveLength(2)
    await manager.stop(name)
    expect(removeDsh(result.installed.id)).toEqual({ ok: true })
    expect(installedDsh(result.installed.id)).toBeUndefined()
    expect(existsSync(join(store, 'agents', name, 'harness.json'))).toBe(true)
    expect(listInstalledDsh().map(d => d.id)).toEqual(['autonomous/studio-viewer'])
    report.push({ name, checks: ['install', 'setup', 'doctor', 'index', 'materialize', 'skill discovery', 'verdict',
      'viewer launch', 'run', 'artifact downloads', 'stop', 'idempotent materialization', 'restore', 'remove'] })
  }, 900_000)
  it.runIf(process.env.HARNESS_STUDIO_FRESH_INSTALL === '1')('clean sparse install fetches the package and its viewer from the pushed branch', async () => {
    expect(removeDsh('autonomous/studio-viewer')).toEqual({ ok: true })
    const source = process.env.HARNESS_STUDIO_INSTALL_SOURCE ?? 'https://github.com/autonomous-ai/openharness.git'
    const ref = process.env.HARNESS_STUDIO_INSTALL_REF ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: store, encoding: 'utf8' }).trim()
    const result = await installDsh({ source, ref, path: 'store/agents/ableton-ai', expectedId: 'autonomous/ableton-ai',
      registry: id => id === 'autonomous/studio-viewer' ? { id, kind: 'viewer', name: 'Studio Viewer', repo: source, ref,
        path: 'store/viewers/studio-viewer', tier: 2 } : undefined })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.installed.linked).toBe(false)
    expect(installedDsh('autonomous/studio-viewer')?.linked).toBe(false)
    const workspace = join(root, 'fresh music workspace')
    mkdirSync(workspace)
    expect((await materializeWorkspace(result.installed, workspace)).warnings).toEqual([])
    await manager.start('fresh', result.installed, workspace)
    const state = await stateOf(`${manager.url('fresh')}api/state`)
    expect(state.result.engine).toBe('Local MIDI + synthesized audio')
    expect(state.result.artifacts).toHaveLength(3)
    await manager.stop('fresh')
    const output = join(store, 'viewers/studio-viewer/test-results')
    writeFileSync(join(output, 'fresh-install-report.json'), JSON.stringify({ status: 'passed', source, ref,
      commit: result.installed.commit, package: result.installed.id, viewer: 'autonomous/studio-viewer',
      checks: ['sparse clone', 'locked dependencies', 'upstream fetch', 'viewer dependency install', 'doctor', 'materialize', 'viewer launch', 'real artifacts'] }, null, 2))
  }, 600_000)
})
