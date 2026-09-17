import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDsh } from './check.js'

const STARTER = realpathSync(fileURLToPath(new URL('../../../store/starter', import.meta.url)))

describe('checkDsh', () => {
  let copy: string
  beforeEach(() => { copy = mkdtempSync(join(tmpdir(), 'dsh-check-')); cpSync(STARTER, copy, { recursive: true }) })
  afterEach(() => rmSync(copy, { recursive: true, force: true }))

  it('passes the starter fixture with no failures', () => {
    const result = checkDsh(STARTER)
    expect(result.ok).toBe(true)
    expect(result.lines.filter((l) => l.level === 'fail')).toEqual([])
    expect(result.lines.some((l) => l.what.includes('skills/ · hello'))).toBe(true)
  })

  it('fails on a missing path, a reserved env key, and a viewer url without a port', () => {
    writeFileSync(join(copy, 'harness.json'), JSON.stringify({
      spec: 1, id: 'acme/broken', name: 'Broken', engine: 'claude',
      workspace: { template: 'nope', marker: 'x' },
      agent: { instructions: 'AGENTS.md', skills: ['skills'], env: { HARNESS_DSH: 'x', OK: '${dsh}/bin' } },
      toolchain: { doctor: 'toolchain/missing.sh' },
      viewer: { command: 'echo hi', url: 'http://127.0.0.1:4000/' },
    }))
    const result = checkDsh(copy)
    expect(result.ok).toBe(false)
    const fails = result.lines.filter((l) => l.level === 'fail').map((l) => l.what)
    expect(fails.some((w) => w.includes('workspace.template nope'))).toBe(true)
    expect(fails.some((w) => w.includes('agent.env.HARNESS_DSH is reserved'))).toBe(true)
    expect(fails.some((w) => w.includes('toolchain.doctor toolchain/missing.sh'))).toBe(true)
    expect(fails.some((w) => w.includes('viewer.url has no ${port}'))).toBe(true)
  })

  it('a wrapper whose setup fetches the upstream has its instructions, template and skills only after setup: warned, not failed', () => {
    writeFileSync(join(copy, 'harness.json'), JSON.stringify({
      spec: 1, id: 'acme/wrapper', name: 'Wrapper', engine: 'codex', author: 'Acme', description: 'wraps a project',
      workspace: { template: 'upstream/harness/template', marker: 'model.py' },
      agent: { instructions: 'upstream/harness/AGENTS.md', skills: ['upstream/skills'] },
      toolchain: { setup: 'toolchain/setup.sh' },
    }))
    mkdirSync(join(copy, 'toolchain'), { recursive: true })
    writeFileSync(join(copy, 'toolchain', 'setup.sh'), '#!/bin/sh\n', { mode: 0o755 })
    const result = checkDsh(copy)
    const warns = result.lines.filter((l) => l.level === 'warn').map((l) => l.what)
    expect(result.lines.filter((l) => l.level === 'fail')).toEqual([])
    expect(result.ok).toBe(true)
    for (const path of ['workspace.template upstream/harness/template', 'agent.instructions upstream/harness/AGENTS.md', 'agent.skills upstream/skills']) {
      expect(warns.some((w) => w.startsWith(path) && w.includes('toolchain.setup must create it')), path).toBe(true)
    }
  })

  it('reports an unparseable manifest as the one failure', () => {
    writeFileSync(join(copy, 'harness.json'), '{"spec": 3}')
    const result = checkDsh(copy)
    expect(result.ok).toBe(false)
    expect(result.manifest).toBeNull()
    expect(result.lines).toHaveLength(1)
  })
})
