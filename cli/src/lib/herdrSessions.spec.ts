import { describe, expect, it } from 'vitest'
import { parseHerdrSessionList, resolveConfiguredHerdrSessions } from './herdrSessions.js'

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
