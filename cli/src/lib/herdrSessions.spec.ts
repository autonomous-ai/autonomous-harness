import { describe, expect, it, vi } from 'vitest'
import {
  discoverRunningHerdrSessions,
  herdrBinaryAvailable,
  herdrHintSelects,
  parseHerdrSessionList,
  resolveConfiguredHerdrSessions,
} from './herdrSessions.js'

describe('configured Herdr session bootstrap', () => {
  it('parses bounded session-list output without treating pane content as CLI data', () => {
    expect(parseHerdrSessionList(JSON.stringify({ sessions: [{
      name: 'default', running: true, session_dir: '/config/default', socket_path: '/config/default/herdr.sock',
    }] }))).toEqual([{
      name: 'default', running: true, session_dir: '/config/default', socket_path: '/config/default/herdr.sock',
    }])
  })

  it('reports configured targets independently and never falls back to an unconfigured session', async () => {
    const result = await resolveConfiguredHerdrSessions(['default', 'work'], async () => [{
      name: 'other', running: true, session_dir: '/other', socket_path: '/other/herdr.sock',
    }])
    expect(result).toEqual([
      { state: 'unavailable', sessionName: 'default', reason: 'configured Herdr session is not running' },
      { state: 'unavailable', sessionName: 'work', reason: 'configured Herdr session is not running' },
    ])
  })

  it('rejects configured aliases that resolve to the same canonical endpoint', async () => {
    const result = await resolveConfiguredHerdrSessions(
      ['default', 'alias'],
      async () => [
        { name: 'default', running: true, session_dir: '/safe', socket_path: '/safe/herdr.sock' },
        { name: 'alias', running: true, session_dir: '/safe', socket_path: '/safe/herdr.sock' },
      ],
      async ({ sessionName, socketPath }) => ({
        sessionName,
        socketPath,
        endpointId: `endpoint-${sessionName}`,
        generation: { device: 1, inode: 2 },
      }),
    )
    expect(result).toEqual([
      {
        state: 'unavailable', sessionName: 'default',
        reason: 'configured Herdr sessions resolve to the same canonical endpoint',
      },
      {
        state: 'unavailable', sessionName: 'alias',
        reason: 'configured Herdr sessions resolve to the same canonical endpoint',
      },
    ])
  })

  it('rejects malformed and oversized output', () => {
    expect(() => parseHerdrSessionList('{"sessions":[{}]}')).toThrow('incompatible shape')
    expect(() => parseHerdrSessionList('x'.repeat(512 * 1024 + 1))).toThrow('size limit')
  })
})

describe('Herdr auto-discovery (no configuration)', () => {
  const endpoint = async ({ sessionName, socketPath }: { sessionName: string; socketPath: string }) => ({
    sessionName, socketPath, endpointId: `id:${socketPath}`, generation: { device: 1, inode: 1 },
  })

  it('adopts every RUNNING session, whatever it is called', async () => {
    // The point of auto-detection: the user starts a session with a name we were never told about, and
    // its panes are watched on the next pass. A stopped session is not a target.
    const result = await discoverRunningHerdrSessions(
      'herdr',
      async () => [
        { name: 'scratch', running: true, session_dir: '/a', socket_path: '/a/herdr.sock' },
        { name: 'default', running: true, session_dir: '/b', socket_path: '/b/herdr.sock' },
        { name: 'stopped', running: false, session_dir: '/c', socket_path: '/c/herdr.sock' },
      ],
      endpoint,
    )
    expect(result.map((target) => [target.sessionName, target.state])).toEqual([
      ['scratch', 'available'],
      ['default', 'available'],
    ])
  })

  it('costs nothing on a machine without Herdr — no spawn, no targets', async () => {
    const list = vi.fn()
    await expect(discoverRunningHerdrSessions('herdr-does-not-exist-anywhere', list, endpoint)).resolves.toEqual([])
    expect(list).not.toHaveBeenCalled()
    expect(herdrBinaryAvailable('herdr-does-not-exist-anywhere')).toBe(false)
  })

  it('stays quiet when an installed Herdr cannot answer', async () => {
    // Installed but broken, or a build whose `session list --json` shape moved. Nobody asked for Herdr,
    // so there is nothing to report and nothing to adopt — never a startup failure.
    await expect(discoverRunningHerdrSessions('herdr', async () => { throw new Error('exit 1') }, endpoint))
      .resolves.toEqual([])
    await expect(discoverRunningHerdrSessions('herdr', async () => [], endpoint)).resolves.toEqual([])
  })

  it('still refuses two discovered sessions that alias one endpoint', async () => {
    // Discovery must not become a way around the alias rule the configured path enforces.
    const result = await discoverRunningHerdrSessions(
      'herdr',
      async () => [
        { name: 'one', running: true, session_dir: '/same', socket_path: '/same/herdr.sock' },
        { name: 'two', running: true, session_dir: '/same', socket_path: '/same/herdr.sock' },
      ],
      endpoint,
    )
    expect(result.every((target) => target.state === 'unavailable')).toBe(true)
  })
})

describe('hook hint → endpoint selection', () => {
  const endpoint = { sessionName: 'default', socketPath: '/config/default/herdr.sock' }

  it('matches on the socket path alone, because herdr 0.8.0 exports no HERDR_SESSION', () => {
    // The pane env measured on 0.8.0: HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_ENV, HERDR_TAB_ID,
    // HERDR_WORKSPACE_ID. Requiring a session name rejected every real hook, so nothing ever bound —
    // a resumed session opened blank and a turn typed in the pane emitted no frames.
    expect(herdrHintSelects(endpoint, { socketPath: '/config/default/herdr.sock' })).toBe(true)
    expect(herdrHintSelects(endpoint, { sessionName: 'default' })).toBe(true)
    expect(herdrHintSelects(endpoint, { sessionName: 'default', socketPath: '/config/default/herdr.sock' })).toBe(true)
  })

  it('refuses a hint that identifies nothing, or that disagrees', () => {
    // A hint with no identifying field must never match "whatever backend is first" — that would let a
    // pane in one session speak for an agent in another.
    expect(herdrHintSelects(endpoint, {})).toBe(false)
    expect(herdrHintSelects(endpoint, { sessionName: 'other' })).toBe(false)
    expect(herdrHintSelects(endpoint, { socketPath: '/somewhere/else.sock' })).toBe(false)
    expect(herdrHintSelects(endpoint, { sessionName: 'default', socketPath: '/somewhere/else.sock' })).toBe(false)
  })
})
