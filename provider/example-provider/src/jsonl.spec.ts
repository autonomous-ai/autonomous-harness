// Transcript discovery, plus a regression on the bug that made every history read come back empty.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadAgents } from './config.js'
import { isSessionFile, listSessions, mangleCwd, readTranscript, sessionIdFromFile, sliceByTime } from './jsonl.js'

const root = mkdtempSync(join(tmpdir(), 'example-provider-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function transcript(projectsDir: string, cwd: string, sessionId: string, lines: unknown[]): void {
  const dir = join(projectsDir, mangleCwd(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
}

const userLine = (text: string, timestamp: string) => ({
  type: 'user', timestamp, cwd: '/w', sessionId: 's1',
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantLine = (text: string, timestamp: string) => ({
  type: 'assistant', timestamp, cwd: '/w', sessionId: 's1',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

describe('mangleCwd', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(mangleCwd('/Users/me/go/src/x.y')).toBe('-Users-me-go-src-x-y')
  })
  it('is lossy — two different paths can collide, which is why cwd is read off the lines', () => {
    expect(mangleCwd('/a/b')).toBe(mangleCwd('/a-b'))
  })
})

describe('session files', () => {
  it('accepts a session and rejects a subagent mirror', () => {
    expect(isSessionFile('abc.jsonl')).toBe(true)
    expect(isSessionFile('agent-abc.jsonl')).toBe(false)
    expect(isSessionFile('notes.txt')).toBe(false)
  })
  it('takes the session id from the filename', () => {
    expect(sessionIdFromFile('/x/y/abc-123.jsonl')).toBe('abc-123')
  })
})

describe('readTranscript', () => {
  const projectsDir = join(root, 'agents')

  it('keeps only conversation lines and drops the rest', () => {
    transcript(projectsDir, '/w1', 's1', [
      { type: 'last-prompt' }, { type: 'mode' }, { type: 'permission-mode' },
      userLine('hello', '2026-08-04T09:00:00Z'),
      { type: 'ai-title', title: 'x' },
      assistantLine('hi', '2026-08-04T09:00:01Z'),
      { type: 'file-history-snapshot' }, { type: 'system' },
    ])
    const lines = readTranscript(projectsDir, '/w1', 's1')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.type)).toEqual(['user', 'assistant'])
  })

  it('drops sidechain lines, which belong to subagents', () => {
    transcript(projectsDir, '/w2', 's1', [
      userLine('main', '2026-08-04T09:00:00Z'),
      { ...assistantLine('sub', '2026-08-04T09:00:01Z'), isSidechain: true },
    ])
    expect(readTranscript(projectsDir, '/w2', 's1')).toHaveLength(1)
  })

  it('survives a half-written trailing line while claude is mid-turn', () => {
    const dir = join(projectsDir, mangleCwd('/w3'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's1.jsonl'), `${JSON.stringify(userLine('ok', '2026-08-04T09:00:00Z'))}\n{"type":"assist`)
    expect(readTranscript(projectsDir, '/w3', 's1')).toHaveLength(1)
  })

  it('returns empty rather than throwing for an unknown session', () => {
    expect(readTranscript(projectsDir, '/nope', 'missing')).toEqual([])
  })
})

describe('listSessions', () => {
  it('orders newest first and titles from the first user message', () => {
    const projectsDir = join(root, 'agents-list')
    transcript(projectsDir, '/w', 'old', [userLine('the older question', '2026-08-04T08:00:00Z')])
    transcript(projectsDir, '/w', 'new', [userLine('the newer question', '2026-08-04T10:00:00Z')])
    const sessions = listSessions(projectsDir, '/w')
    expect(sessions.map((s) => s.sessionId)).toEqual(['new', 'old'])
    expect(sessions[0]!.title).toBe('the newer question')
  })

  it('ignores subagent mirrors', () => {
    const projectsDir = join(root, 'agents-mirror')
    transcript(projectsDir, '/w', 's1', [userLine('real', '2026-08-04T08:00:00Z')])
    const dir = join(projectsDir, mangleCwd('/w'))
    writeFileSync(join(dir, 'agent-sub.jsonl'), JSON.stringify(userLine('sub', '2026-08-04T09:00:00Z')))
    expect(listSessions(projectsDir, '/w').map((s) => s.sessionId)).toEqual(['s1'])
  })
})

describe('sliceByTime — one A2A task out of a whole Claude session', () => {
  const lines = [
    userLine('turn one', '2026-08-04T09:00:00Z'),
    assistantLine('reply one', '2026-08-04T09:00:05Z'),
    userLine('turn two', '2026-08-04T09:10:00Z'),
    assistantLine('reply two', '2026-08-04T09:10:05Z'),
  ]
  it('selects only the requested window', () => {
    const first = sliceByTime(lines, Date.parse('2026-08-04T08:59:00Z'), Date.parse('2026-08-04T09:01:00Z'))
    expect(first).toHaveLength(2)
  })
  it('leaves the list untouched when unbounded', () => {
    expect(sliceByTime(lines)).toHaveLength(4)
  })
  it('treats a still-running task as open-ended', () => {
    expect(sliceByTime(lines, Date.parse('2026-08-04T09:09:00Z'))).toHaveLength(2)
  })
})

describe('agent cwd resolution', () => {
  it('resolves symlinks, because Claude records the resolved path', () => {
    // REGRESSION: on macOS `/tmp` is a symlink to `/private/tmp`. Configuring `/tmp/x` made this
    // provider look in `-tmp-x` while Claude wrote `-private-tmp-x`, so every history read came back
    // empty and HP-201 failed against a live agent.
    const real = join(root, 'real-dir')
    const link = join(root, 'link-dir')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)

    const agentsFile = join(root, 'agents.json')
    writeFileSync(agentsFile, JSON.stringify([{ id: 'a', name: 'A', description: '', cwd: link }]))
    const resolved = loadAgents(agentsFile)[0]!.cwd

    // Compare against realpath(real), not `real` itself: the temp root is already under a symlink on
    // macOS (`/var` → `/private/var`), which is the very hazard this test exists for.
    expect(resolved).toBe(realpathSync(real))
    expect(resolved).not.toBe(link)
  })

  it('rejects a cwd that does not exist, at load rather than at the first turn', () => {
    const agentsFile = join(root, 'agents-bad.json')
    writeFileSync(agentsFile, JSON.stringify([{ id: 'a', name: 'A', cwd: '/definitely/not/here' }]))
    expect(() => loadAgents(agentsFile)).toThrow(/does not exist/)
  })

  it('rejects duplicate ids and bad id shapes', () => {
    const dup = join(root, 'agents-dup.json')
    writeFileSync(dup, JSON.stringify([{ id: 'a', name: 'A', cwd: root }, { id: 'a', name: 'B', cwd: root }]))
    expect(() => loadAgents(dup)).toThrow(/duplicate/)

    const bad = join(root, 'agents-badid.json')
    writeFileSync(bad, JSON.stringify([{ id: '../escape', name: 'A', cwd: root }]))
    expect(() => loadAgents(bad)).toThrow(/id must match/)
  })
})
