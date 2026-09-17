import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InstalledDsh } from './installed.js'
import { readDshManifest } from './manifest.js'
import { dshMarkerLine, materializeWorkspace, resolveDshCommand, skillDirsIn } from './materialize.js'

const STARTER = realpathSync(fileURLToPath(new URL('../../../store/starter', import.meta.url)))

function starter(engine: 'claude' | 'codex' = 'claude'): InstalledDsh {
  const manifest = readDshManifest(STARTER)
  if (!manifest.ok) throw new Error(manifest.error)
  return {
    id: manifest.manifest.id,
    dir: STARTER,
    realDir: STARTER,
    source: STARTER,
    ref: null,
    commit: null,
    linked: true,
    installedAt: 0,
    manifest: { ...manifest.manifest, engine },
  }
}

describe('materializeWorkspace', () => {
  let workspace: string
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-ws-')) })
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('fills an empty workspace: template, AGENTS.md, CLAUDE.md import, skill link, .harness', async () => {
    const result = await materializeWorkspace(starter(), workspace)
    expect(result.warnings).toEqual([])
    expect(readFileSync(join(workspace, 'NOTES.md'), 'utf8')).toContain('# Notes')
    const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
    expect(agents.startsWith(dshMarkerLine('autonomous/starter'))).toBe(true)
    expect(agents).toContain('Starter harness')
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8').trim()).toBe('@AGENTS.md')
    const link = join(workspace, '.claude', 'skills', 'hello')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(STARTER, 'skills', 'hello'))
    expect(existsSync(join(link, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(workspace, '.harness'))).toBe(true)
    expect(result.created).toContain('AGENTS.md')
    // The init ran in the workspace, found by its path inside the harness, with the contract's env.
    expect(readFileSync(join(workspace, '.harness-initialized'), 'utf8')).toBe('initialized by autonomous/starter\n')
    expect(result.warnings).toEqual([])
  })

  it('runs the init only once: a marked workspace is not re-initialized', async () => {
    await materializeWorkspace(starter(), workspace)
    rmSync(join(workspace, '.harness-initialized'))
    await materializeWorkspace(starter(), workspace)
    expect(existsSync(join(workspace, '.harness-initialized'))).toBe(false)
  })

  it('is idempotent: a second run keeps everything and appends nothing', async () => {
    await materializeWorkspace(starter(), workspace)
    const before = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
    const again = await materializeWorkspace(starter(), workspace)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe(before)
    expect(again.created).toEqual([])
    expect(again.kept).toEqual(expect.arrayContaining(['NOTES.md', 'AGENTS.md', 'CLAUDE.md', '.claude/skills/hello']))
  })

  it("appends under a marker to the user's own AGENTS.md and CLAUDE.md, once", async () => {
    writeFileSync(join(workspace, 'NOTES.md'), 'mine\n') // marker present → no template copy
    writeFileSync(join(workspace, 'AGENTS.md'), '# Repo rules\n\nBe kind.\n')
    writeFileSync(join(workspace, 'CLAUDE.md'), '# Claude\n')
    await materializeWorkspace(starter(), workspace)
    await materializeWorkspace(starter(), workspace)
    const agents = readFileSync(join(workspace, 'AGENTS.md'), 'utf8')
    expect(agents.startsWith('# Repo rules')).toBe(true)
    expect(agents.split(dshMarkerLine('autonomous/starter')).length).toBe(2)
    const claude = readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')
    expect(claude.startsWith('# Claude')).toBe(true)
    expect(claude.split('@AGENTS.md').length).toBe(2)
    expect(readFileSync(join(workspace, 'NOTES.md'), 'utf8')).toBe('mine\n')
  })

  it('links Codex skills under .agents and writes no CLAUDE.md', async () => {
    await materializeWorkspace(starter('codex'), workspace)
    expect(lstatSync(join(workspace, '.agents', 'skills', 'hello')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(workspace, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(workspace, '.claude'))).toBe(false)
  })

  it('leaves a real directory in the skills folder alone and says so', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(workspace, '.claude', 'skills', 'hello'), { recursive: true })
    const result = await materializeWorkspace(starter(), workspace)
    expect(lstatSync(join(workspace, '.claude', 'skills', 'hello')).isSymbolicLink()).toBe(false)
    expect(result.warnings.some((w) => w.includes('hello'))).toBe(true)
  })
})

describe('skillDirsIn', () => {
  it('lists SKILL.md-bearing subdirectories, or the directory itself when it is one skill', () => {
    expect(skillDirsIn(join(STARTER, 'skills'))).toEqual([join(STARTER, 'skills', 'hello')])
    expect(skillDirsIn(join(STARTER, 'skills', 'hello'))).toEqual([join(STARTER, 'skills', 'hello')])
    expect(skillDirsIn(join(STARTER, 'template'))).toEqual([])
    expect(skillDirsIn('/nonexistent')).toEqual([])
  })
})

describe('resolveDshCommand', () => {
  it('turns a path inside the harness into a quoted absolute path and leaves shell lines alone', () => {
    expect(resolveDshCommand({ realDir: STARTER }, 'toolchain/init-workspace.sh')).toBe(`'${join(STARTER, 'toolchain', 'init-workspace.sh')}'`)
    expect(resolveDshCommand({ realDir: STARTER }, 'toolchain/missing.sh')).toBe('toolchain/missing.sh')
    expect(resolveDshCommand({ realDir: STARTER }, 'npm run viewer -- --port $HARNESS_VIEWER_PORT')).toBe('npm run viewer -- --port $HARNESS_VIEWER_PORT')
  })
})
