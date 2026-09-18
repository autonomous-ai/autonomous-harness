import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import * as authSession from '../lib/authSession.js'
import { summarizeOrchestratorReply, parseOrchestratorArgs, localOrchestratorRequest, orchestratorCommand } from './command.js'

describe('orchestrator tool output', () => {
  it('keeps large projects readable without discarding worker results or mutating UI state', () => {
    const reply = { project: {
      id: 'a'.repeat(32), state: 'active', fingerprint: 'private-request-hash',
      tasks: [{ id: 'shape', prompt: 'long brief'.repeat(2000), summary: 'Verified', artifacts: [{ path: 'shape.step', sha256: 'a'.repeat(64) }] }],
      messages: Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: 'long conversation'.repeat(1500), delivery: 'started' })),
    } }
    const output = summarizeOrchestratorReply(reply)
    expect(JSON.stringify(output).length).toBeLessThan(8000)
    expect(output).toMatchObject({ project: { tasks: [{ id: 'shape', summary: 'Verified', artifacts: [{ path: 'shape.step' }] }] } })
    expect(reply.project.messages).toHaveLength(200)
    expect(reply.project.tasks[0].prompt.length).toBeGreaterThan(10000)
  })
  it('keeps coded refusals unchanged and parses scoped steering receipts', () => {
    const error = { error: 'TASK_INACTIVE', detail: 'Add a revision task.' }
    expect(summarizeOrchestratorReply(error)).toBe(error)
    expect(parseOrchestratorArgs(['--port', '1234', '--machine', 'fixture', 'steer', 'a'.repeat(32), 'shape', '2', 'Use millimeters', 'b'.repeat(32)]).payload).toMatchObject({
      action: 'steer', taskId: 'shape', attempt: 2, text: 'Use millimeters', messageId: 'b'.repeat(32),
    })
  })
  it('handles sparse and non-project replies without inventing a transcript', () => {
    for (const project of [null, 3, [], 'no project']) {
      const reply = { project }; expect(summarizeOrchestratorReply(reply)).toBe(reply)
    }
    expect(summarizeOrchestratorReply({ project: {} })).toEqual({ project: { tasks: [], deliveries: [] } })
    expect(summarizeOrchestratorReply({ project: { messages: [{ text: 'No receipt' }] } })).toEqual({ project: { tasks: [], deliveries: [] } })
  })
})

describe('orchestrator argument validation', () => {
  afterEach(() => vi.restoreAllMocks())
  const parse = (...args: string[]) => parseOrchestratorArgs(['--port', '1234', '--machine', 'local-test', ...args]).payload
  it.each(['list', 'catalog', 'status', 'resume'])('parses %s without changing its identity', action => {
    expect(parse(action, 'project')).toEqual({ action, id: 'project' })
  })
  it('parses plan, both result outcomes, scoped cancel/retry, completion and chat', () => {
    expect(parse('plan', 'project', '[{"id":"x"}]')).toEqual({ action: 'plan', id: 'project', tasks: [{ id: 'x' }] })
    expect(parse('plan', 'project').tasks).toBeNull()
    for (const action of ['finish', 'fail']) expect(parse(action, 'project', 'task', '2', 'verified', 'a.step', 'b.png')).toEqual({ action, id: 'project', taskId: 'task', attempt: 2, summary: 'verified', artifacts: ['a.step', 'b.png'] })
    for (const action of ['retry', 'cancel']) {
      expect(parse(action, 'project', 'task')).toEqual({ action, id: 'project', taskId: 'task' })
      expect(parse(action, 'project')).toEqual({ action, id: 'project' })
    }
    expect(parse('complete', 'project', 'verified').summary).toBe('verified')
    expect(parse('message', 'project', 'hello').messageId).toMatch(/^[a-f0-9]{32}$/)
    expect(parse('message', 'project', 'hello', 'fixed').messageId).toBe('fixed')
    expect(parse('steer', 'project', 'task', '1', 'hello').messageId).toMatch(/^[a-f0-9]{32}$/)
  })
  it('rejects malformed JSON, unknown commands, missing identity and invalid ports', () => {
    expect(() => parse('plan', 'project', '{')).toThrow()
    expect(() => parse('install')).toThrow(/Usage/)
    for (const port of ['0', '65536', '1.1', 'no']) expect(() => parseOrchestratorArgs(['--port', port, '--machine', 'local', 'list'])).toThrow(/running local daemon/)
    expect(() => parseOrchestratorArgs(['--port', '1234', '--machine'])).toThrow(/identity/)
  })
  it('uses a saved local identity and safely formats untyped configuration failures', async () => {
    vi.spyOn(authSession, 'readAuthSession').mockReturnValue({ machineId: 'saved-machine' } as ReturnType<typeof authSession.readAuthSession>)
    expect(parseOrchestratorArgs(['--port', '1234', 'list']).machineId).toBe('saved-machine')
    vi.spyOn(authSession, 'readAuthSession').mockImplementation(() => { throw 'untyped configuration failure' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await orchestratorCommand(['list'])).toBe(1)
    expect(error).toHaveBeenCalledWith('Orchestrator request failed.')
  })
})

describe('real loopback orchestrator transport', () => {
  const servers: WebSocketServer[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()) })))
  })
  async function server(mode: 'ok' | 'refusal' | 'disconnect' | 'invalid' | 'silent' = 'ok') {
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); servers.push(ws)
    await new Promise<void>(resolve => ws.once('listening', resolve))
    const received: any[] = []
    ws.on('connection', socket => socket.on('message', data => {
      const frame = JSON.parse(data.toString()); received.push(frame)
      if (mode === 'disconnect') { socket.close(); return }
      if (mode === 'invalid') { socket.send('{'); return }
      if (mode === 'silent') return
      if (frame.type === 'machine_select') socket.send(JSON.stringify({ type: 'connected' }))
      else {
        socket.send(JSON.stringify({ type: 'orchestrator_changed', payload: { requestId: 'unrelated' } }))
        socket.send(JSON.stringify({ type: 'orchestrator_result', payload: { requestId: frame.payload.requestId, ...(mode === 'refusal' ? { error: 'PROJECT_INACTIVE' } : { projects: [] }) } }))
      }
    }))
    return { port: (ws.address() as { port: number }).port, received, ws }
  }
  it('selects the machine and correlates replies by receipt rather than unsolicited events', async () => {
    const peer = await server()
    expect(await localOrchestratorRequest(peer.port, 'test-machine', { action: 'list' })).toMatchObject({ projects: [] })
    expect(peer.received[0]).toEqual({ type: 'machine_select', payload: { machineId: 'test-machine', localProtocolVersion: 1 } })
    expect(peer.received[1].payload).toMatchObject({ action: 'list', requestId: expect.stringMatching(/^[a-f0-9]{32}$/) })
  })
  it.each([['disconnect', /disconnected/], ['invalid', /invalid response/], ['silent', /did not confirm/]] as const)('fails safely on %s without retrying', async (mode, message) => {
    const peer = await server(mode)
    await expect(localOrchestratorRequest(peer.port, 'machine', { action: 'list' }, 50)).rejects.toThrow(message)
    expect(peer.received.filter(frame => frame.type === 'machine_select')).toHaveLength(1)
  })
  it('surfaces connection errors and command exit codes', async () => {
    const peer = await server()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await orchestratorCommand(['--port', String(peer.port), '--machine', 'machine', 'list'])).toBe(0)
    expect(JSON.parse(output.mock.calls[0][0]).projects).toEqual([])
    const refusal = await server('refusal')
    expect(await orchestratorCommand(['--port', String(refusal.port), '--machine', 'machine', 'list'])).toBe(1)
    expect(await orchestratorCommand(['--port', '0', '--machine', 'machine', 'list'])).toBe(1)
    expect(error).toHaveBeenCalled()
    await new Promise<void>(resolve => peer.ws.close(() => resolve()))
    await expect(localOrchestratorRequest(peer.port, 'machine', { action: 'list' })).rejects.toThrow(/ECONNREFUSED/)
  })
})
