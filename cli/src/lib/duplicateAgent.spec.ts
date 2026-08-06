import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { refuseDuplicateAgent, sameDirSync } from './duplicateAgent.js'

/**
 * The rule exists because muse gives repair nothing to tell two agents in one directory apart, so the
 * second one could never stream. Refusing a launch is a heavy hammer — the daemon answers `exit`, and a
 * launcher acting on that ends the engine — so most of these tests are about what it must NOT block.
 */
describe('one agent per directory', () => {
  const CWD = '/Users/demo/work/project'
  const SELF = 'agent-self'
  const all = { selfId: SELF, isLive: () => true }
  const agent = (agentId: string, engine: string, cwd: string | null = CWD) => ({ agentId, engine, cwd })

  it('turns away a second muse agent in the same directory', () => {
    const reason = refuseDuplicateAgent([agent('agent-1', 'muse')], 'muse', CWD, all)
    expect(reason).toContain(CWD)
    expect(reason).toMatch(/one muse agent per directory/)
  })

  it('lets the FIRST muse agent in — a directory is only taken once someone is there', () => {
    expect(refuseDuplicateAgent([], 'muse', CWD, all)).toBeNull()
    expect(refuseDuplicateAgent([agent('agent-1', 'claude')], 'muse', CWD, all)).toBeNull()
  })

  it('lets muse run in a different directory', () => {
    expect(refuseDuplicateAgent([agent('agent-1', 'muse', '/Users/demo/other')], 'muse', CWD, all)).toBeNull()
  })

  it('never lets a launcher block itself', () => {
    // A reconnect arrives under the agent id it already owns — the registry entry it is about to reclaim.
    expect(refuseDuplicateAgent([agent(SELF, 'muse')], 'muse', CWD, all)).toBeNull()
  })

  it('ignores an agent whose launcher is gone', () => {
    // MEASURED failure: the registry is persisted, so a restarted daemon starts out holding agents that
    // may no longer exist. Treating those as occupancy killed two live muse panes — each refused by its
    // own saved entry. Only an agent still on the socket counts.
    const dead = { selfId: SELF, isLive: () => false }
    expect(refuseDuplicateAgent([agent('agent-1', 'muse')], 'muse', CWD, dead)).toBeNull()
  })

  it('applies to muse ONLY — every other engine may share a directory', () => {
    // The other eight report their session id, so two of them in one folder are still told apart.
    for (const engine of ['claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin']) {
      expect(refuseDuplicateAgent([agent('agent-1', engine)], engine, CWD, all)).toBeNull()
    }
  })

  it('does not refuse on an unknown directory', () => {
    // A launcher that reports no cwd must never be blocked by a rule about directories.
    expect(refuseDuplicateAgent([agent('agent-1', 'muse')], 'muse', null, all)).toBeNull()
    expect(refuseDuplicateAgent([agent('agent-1', 'muse', null)], 'muse', CWD, all)).toBeNull()
  })

  it('sees through a symlink, so one directory under two names is still one directory', () => {
    // `/tmp` is itself a symlink to `/private/tmp` on macOS, which is why string equality is not enough.
    const real = mkdtempSync(join(tmpdir(), 'dup-'))
    const link = `${real}-link`
    try {
      symlinkSync(real, link)
      expect(sameDirSync(real, link)).toBe(true)
      expect(refuseDuplicateAgent([agent('agent-1', 'muse', real)], 'muse', link, all)).not.toBeNull()
    } finally {
      rmSync(link, { force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })
})
