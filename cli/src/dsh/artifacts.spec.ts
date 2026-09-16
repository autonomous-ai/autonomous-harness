import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCandidateArtifact, newestArtifact } from './artifacts.js'
import { bundledDshRegistry, resetBundledDshRegistry } from './registry.js'
import { resolveInstallSource } from './install.js'

describe('newestArtifact', () => {
  let workspace: string
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'dsh-art-')) })
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  const touch = (rel: string, at: number): void => {
    const path = join(workspace, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
    utimesSync(path, at, at)
  }

  it('picks the most recently modified file with a wanted extension, skipping generated trees', () => {
    touch('models/old.step', 1_000)
    touch('models/new.STEP', 3_000)
    touch('notes.txt', 9_000)
    touch('node_modules/lib/newest.step', 9_000)
    touch('__cadgen__/cache.step', 9_000)
    touch('.hidden/x.step', 9_000)
    touch('models/.new.STEP.glb', 9_000)
    expect(newestArtifact(workspace, ['.step', '.stl', '.glb'])?.path).toBe('models/new.STEP')
    expect(newestArtifact(workspace, ['.glb'])).toBeNull()
    expect(newestArtifact(workspace, [])).toBeNull()
  })
})

describe('isCandidateArtifact', () => {
  it('matches by extension and refuses ignored directories', () => {
    expect(isCandidateArtifact('/ws/models/a.step', ['.step'])).toBe(true)
    expect(isCandidateArtifact('/ws/a.txt', ['.step'])).toBe(false)
    expect(isCandidateArtifact('/ws/node_modules/a.step', ['.step'])).toBe(false)
    expect(isCandidateArtifact('/ws/models/.a.step.glb', ['.glb'])).toBe(false)
  })
})

describe('bundledDshRegistry', () => {
  it('reads the registry off the source tree in dev, with Copper, Toymaker and Marp present', () => {
    resetBundledDshRegistry()
    const ids = bundledDshRegistry().map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining(['autonomous/copper', 'autonomous/toymaker', 'autonomous/marp']))
    expect(resolveInstallSource('autonomous/copper')).toMatchObject({ source: 'https://github.com/autonomous-ai/autonomous-circuit', id: 'autonomous/copper' })
    expect(resolveInstallSource('https://example.com/x.git')).toEqual({ source: 'https://example.com/x.git' })
    expect(resolveInstallSource('bad\nsource')).toBeNull()
  })
})
