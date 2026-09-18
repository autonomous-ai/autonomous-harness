import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as filesystem from 'node:fs/promises'
import * as privateState from '../lib/secureState.js'
import { OrchestratorService, type OrchestratorDependencies } from './service.js'
import { OrchestratorError, type Task } from './model.js'
import { orchestratorRequest } from './wire.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const id = '0123456789abcdef0123456789abcdef'
const task = (id: string, dependsOn: string[] = [], harness = 'test/cad') => ({ id, title: id, harness, prompt: `Build ${id} and verify it`, dependsOn })
describe('durable orchestrator lifecycle', () => {
  let root: string, service: OrchestratorService, deps: OrchestratorDependencies
  let launches: Parameters<OrchestratorDependencies['create']>[0][]
  let agents: Set<string>, sent: string[], cancelled: string[]
  const tasks = (): Task[] => service.snapshot(id).tasks as Task[]
  const active = async (): Promise<void> => { await vi.waitFor(() => expect(service.snapshot(id).state).toBe('active')) }
  const running = async (taskId: string): Promise<Task> => {
    await vi.waitFor(() => expect(tasks().find(t => t.id === taskId)?.state).toBe('running'))
    return tasks().find(t => t.id === taskId)!
  }
  const start = () => service.start({ id, engine: 'claude', prompt: 'Make something useful', parallelism: 2 })
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orchestrator-spec-'))
    launches = []; agents = new Set(); sent = []; cancelled = []
    deps = {
      stateDir: join(root, 'state'), workspaceDir: join(root, 'projects'), command: 'harness orchestrator',
      supportsEngine: e => e === 'claude',
      catalog: () => ['cad', 'blender', 'video', 'research'].map(name => ({ id: `test/${name}`, name, description: name, engine: 'claude', viewer: name !== 'research' })),
      create: async input => { launches.push(input); const agentId = `agent-${launches.length}`; agents.add(agentId); return { agentId } },
      send: (_agent, text) => { sent.push(text) }, cancel: agent => { cancelled.push(agent) },
      agent: agent => agents.has(agent) ? { viewerUrl: `http://127.0.0.1:9999/${agent}` } : null,
    }
    service = new OrchestratorService(deps)
  })
  afterEach(() => { service.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('starts once, preserves permissions, and rejects a conflicting creation retry', async () => {
    await Promise.all([start(), start()]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].bypassPermission).toBe(false)
    expect(launches[0].prompt.length).toBeLessThan(2000)
    expect(readFileSync(join(launches[0].cwd, 'ORCHESTRATOR.md'), 'utf8')).toContain('test/blender')
    await expect(service.start({ id, engine: 'claude', prompt: 'Different' })).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' })
  })
  it('validates every dependency and harness before launching any task', async () => {
    await start(); await active()
    for (const plan of [[task('a', ['missing'])], [task('a', ['b']), task('b', ['a'])], [task('a'), task('b', [], 'missing/harness')]]) {
      expect(() => service.plan(id, plan)).toThrow()
      expect(tasks()).toHaveLength(0)
    }
    expect(launches).toHaveLength(1)
  })
  it('fans out and joins different harnesses using pinned, checksummed copies', async () => {
    await start(); await active()
    service.plan(id, [task('part'), task('research', [], 'test/research'), task('scene', ['part', 'research'], 'test/blender'), task('film', ['scene'], 'test/video')])
    const part = await running('part'), research = await running('research')
    expect(tasks().find(t => t.id === 'scene')!.state).toBe('queued')
    writeFileSync(join(part.cwd, 'part.step'), 'verified CAD v1')
    await service.finish(id, 'part', 1, 'Dimensions checked', ['part.step'])
    writeFileSync(join(part.cwd, 'part.step'), 'unpublished CAD v2')
    await service.finish(id, 'research', 1, 'Use a warm, minimal setting.', [])
    const scene = await running('scene')
    expect(readFileSync(join(scene.cwd, 'inputs/part/part.step'), 'utf8')).toBe('verified CAD v1')
    expect(scene.inputs).toEqual({ part: 1, research: 1 })
    expect(readFileSync(join(scene.cwd, 'ORCHESTRATOR_TASK.md'), 'utf8')).toContain('warm, minimal')
    writeFileSync(join(scene.cwd, 'scene.png'), 'render fixture')
    await service.finish(id, 'scene', 1, 'Render checked', ['scene.png'])
    const film = await running('film')
    expect(readFileSync(join(film.cwd, 'inputs/scene/scene.png'), 'utf8')).toBe('render fixture')
    await service.finish(id, 'film', 1, 'Film ready', [])
    service.complete(id, 'Delivered all outputs')
    expect(service.snapshot(id).state).toBe('completed')
    expect(sent).toHaveLength(4)
    expect(research.agentId).toBeTruthy()
  })
  it('limits parallelism and treats a repeated plan as the same work', async () => {
    await start(); await active()
    const plan = [task('a'), task('b'), task('c')]
    service.plan(id, plan); service.plan(id, plan)
    await running('a'); await running('b')
    expect(launches).toHaveLength(3)
    expect(tasks().find(t => t.id === 'c')!.state).toBe('queued')
    await service.finish(id, 'a', 1, 'done', [])
    await running('c')
    expect(launches).toHaveLength(4)
  })
  it('blocks dependencies after failure and retries in a new workspace', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])])
    const first = await running('a')
    await service.finish(id, 'a', 1, 'A required tool is missing', [], true)
    expect(tasks().find(t => t.id === 'b')!.state).toBe('blocked')
    service.retry(id, 'a')
    const second = await running('a')
    expect(second.cwd).not.toBe(first.cwd)
    expect(second.attempt).toBe(2)
    await expect(service.finish(id, 'a', 1, 'Late old output', [])).rejects.toMatchObject({ code: 'STALE_ATTEMPT' })
    await service.finish(id, 'a', 2, 'Fixed and verified', [])
    await running('b')
  })
  it('does not mistake idle for success or complete unfinished work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    service.ingest({ type: 'turn_ended', agentId: a.agentId, payload: {} })
    expect(tasks()[0].state).toBe('running')
    expect(() => service.complete(id, 'done')).toThrow(/Every task/)
  })
  it('rejects path traversal, outside symlinks, directories, and missing artifacts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    writeFileSync(join(root, 'secret'), 'not a task artifact')
    symlinkSync(join(root, 'secret'), join(a.cwd, 'outside'))
    mkdirSync(join(a.cwd, 'directory'))
    for (const path of ['../secret', join(root, 'secret'), 'outside', 'directory', 'missing']) {
      await expect(service.finish(id, 'a', 1, 'done', [path])).rejects.toThrow()
      expect(tasks()[0].state).toBe('running')
    }
    writeFileSync(join(a.cwd, 'valid.txt'), 'safe')
    await service.finish(id, 'a', 1, 'done', ['valid.txt'])
    expect(tasks()[0].artifacts[0].sha256).toHaveLength(64)
  })
  it('stops only this project, ignores late results, and never kills sessions on close', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b', ['a'])]); const a = await running('a')
    service.cancel(id)
    expect(cancelled.sort()).toEqual(['agent-1', a.agentId].sort())
    expect(tasks().every(t => t.state === 'cancelled')).toBe(true)
    await expect(service.finish(id, 'a', 1, 'late', [])).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    service.stop()
    expect(cancelled).toHaveLength(2)
  })
  it('cancels an agent that finishes launching after cancellation', async () => {
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start(); service.cancel(id); resolve({ agentId: 'late-director' })
    await vi.waitFor(() => expect(cancelled).toContain('late-director'))
    expect(service.snapshot(id).state).toBe('cancelled')
  })
  it('refuses blind retry of an uncertain process spawn', async () => {
    await start(); await active()
    deps.create = async () => { throw new OrchestratorError('SPAWN_FAILED', 'tmux timed out') }
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].uncertain).toBe(true)
    expect(() => service.retry(id, 'a')).toThrow(/uncertain/)
  })
  it('persists transcript and reattaches without launching duplicate agents', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    service.ingest({ type: 'turn_started', agentId: 'agent-1', payload: {} })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Working ' } })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'on it.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1', payload: {} })
    service.stop()
    service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'Working on it.' })]))
    expect(tasks()[0].agentId).toBe('agent-2')
    expect(launches).toHaveLength(2)
    await service.finish(id, 'a', 1, 'recovered result', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('handles lost chat acknowledgments without sending twice', async () => {
    await start(); await active()
    const messageId = '11111111111111111111111111111111'
    service.chat(id, messageId, 'Make it taller')
    service.chat(id, messageId, 'Make it taller')
    expect(sent).toEqual(['Make it taller'])
    expect(() => service.chat(id, messageId, 'Different message')).toThrow()
  })
  it('tracks real delivery receipts and does not silently resend after restart', async () => {
    await start(); await active()
    const messageId = '22222222222222222222222222222222'
    const send = vi.spyOn(deps, 'send')
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledWith('agent-1', 'Make it taller', messageId)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'unknown' })]))
    service.chat(id, messageId, 'Make it taller')
    expect(send).toHaveBeenCalledTimes(1)
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'started' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'started' })]))
  })
  it('recovers a result notification saved before dispatch without rerunning work', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    await service.finish(id, 'a', 1, 'verified result', [])
    service.stop()
    const file = join(deps.stateDir, `${id}.json`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.messages.at(-1).delivery = 'pending' // crash between durable result and dispatch
    writeFileSync(file, JSON.stringify(saved))
    sent.length = 0
    service = new OrchestratorService(deps)
    expect(tasks()[0].state).toBe('succeeded')
    service.snapshot(id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('verified result')
    expect(launches).toHaveLength(2)
  })
  it('keeps assistant turns separate even when a user message arrives mid-stream', async () => {
    await start(); await active()
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'First ' } })
    service.chat(id, '33333333333333333333333333333333', 'New detail')
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'reply.' } })
    service.ingest({ type: 'turn_ended', agentId: 'agent-1' })
    service.ingest({ type: 'turn_started', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: 'Second reply.' } })
    expect((service.snapshot(id).messages as Array<{ role: string; text: string }>).filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['First reply.', 'Second reply.'])
  })
  it('steers the current worker once and rejects stale or finished attempts', async () => {
    await start(); await active(); service.plan(id, [task('a')]); const a = await running('a')
    const send = vi.spyOn(deps, 'send')
    const messageId = '44444444444444444444444444444444'
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    service.steer(id, 'a', 1, messageId, 'Use millimeters')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(a.agentId, expect.stringContaining('Use millimeters'), messageId)
    expect(launches).toHaveLength(2)
    expect(() => service.steer(id, 'a', 2, messageId, 'Too late')).toThrow(/older attempt/)
    await service.finish(id, 'a', 1, 'done', [])
    expect(() => service.steer(id, 'a', 1, '55555555555555555555555555555555', 'Change it')).toThrow(/revision task/)
  })
  it('revokes only this project’s queued receipts when stopped', async () => {
    await start(); await active()
    const cancelDelivery = deps.cancelDelivery = vi.fn(() => true)
    const messageId = '66666666666666666666666666666666'
    service.chat(id, messageId, 'Queued correction')
    service.delivery({ deliveryId: messageId, sessionId: 'agent-1', state: 'queued' })
    service.cancel(id)
    expect(cancelDelivery).toHaveBeenCalledExactlyOnceWith(messageId)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId, delivery: 'failed' })]))
  })
  it('does not race a retry against a worker still being created', async () => {
    await start(); await active()
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    service.plan(id, [task('a')])
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    service.cancel(id, 'a')
    expect(() => service.retry(id, 'a')).toThrow(/previous launch/)
    resolve({ agentId: 'late-worker' })
    await vi.waitFor(() => expect(cancelled).toContain('late-worker'))
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('reports invalid folders as an editable request refusal', async () => {
    expect(await orchestratorRequest(service, { action: 'start', id, engine: 'claude', prompt: 'Hi', cwd: join(root, 'missing') })).toMatchObject({ error: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('exposes actionable wire errors without throwing or weakening validation', async () => {
    expect(await orchestratorRequest(service, { action: 'status', id: '../escape' })).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await orchestratorRequest(service, { action: 'status', id })).toMatchObject({ error: 'PROJECT_NOT_FOUND' })
    expect(await orchestratorRequest(service, { action: 'install' })).toMatchObject({ error: 'INVALID_REQUEST' })
  })
  it('deduplicates simultaneous creation after asynchronous folder validation', async () => {
    const spec = { id, engine: 'claude', prompt: 'Use this existing folder', cwd: root }
    await Promise.all([service.start(spec), service.start(spec)]); await active()
    expect(launches).toHaveLength(1)
    expect(launches[0].cwd).toBe(join(realpathSync(root), '.harness-projects', id))
  })
  it('lists recent projects in order without exposing their full briefs', async () => {
    await start(); await active()
    const second = 'f'.repeat(32)
    await service.start({ id: second, engine: 'claude', prompt: 'A'.repeat(500) })
    await vi.waitFor(() => expect(service.snapshot(second).state).toBe('active'))
    service.chat(second, '1'.repeat(32), 'More detail')
    expect(service.list().map(r => r.id)).toEqual([second, id])
    expect(String(service.list()[0].prompt)).toHaveLength(160)
  })
  it('preserves corrupt state and refuses to overwrite its identity', async () => {
    mkdirSync(deps.stateDir, { recursive: true })
    const file = join(deps.stateDir, `${id}.json`)
    writeFileSync(file, '{not valid JSON')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(service.list()).toEqual([])
    await expect(start()).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    expect(readFileSync(file, 'utf8')).toBe('{not valid JSON')
    expect(launches).toHaveLength(0)
  })
  it('recovers interrupted director and worker launches conservatively', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.state = 'starting'; saved.directorId = null; saved.tasks[0].state = 'launching'
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id)).toMatchObject({ state: 'paused', directorAvailable: false, tasks: [{ state: 'blocked', uncertain: true }] })
    expect(() => service.resume(id)).toThrow(/original director/)
    expect(launches).toHaveLength(2)
  })
  it.each([new Error('Engine not authenticated'), 'unknown process refusal'])('records a director creation failure without hiding it: %s', async failure => {
    deps.create = async () => { throw failure }
    await start()
    await vi.waitFor(() => expect(service.snapshot(id).state).toBe('failed'))
    expect(service.snapshot(id).error).toBe(failure instanceof Error ? failure.message : 'Director launch failed.')
  })
  it('never overwrites an existing workspace, even without a saved run', async () => {
    mkdirSync(join(deps.workspaceDir, id), { recursive: true })
    await expect(start()).rejects.toMatchObject({ code: 'WORKSPACE_EXISTS' })
    expect(launches).toHaveLength(0)
  })
  it('refuses unsupported engines and invalid folder forms before creation', async () => {
    await expect(service.start({ id, engine: 'codex', prompt: 'Test' })).rejects.toMatchObject({ code: 'ENGINE_UNSUPPORTED' })
    const file = join(root, 'file'); writeFileSync(file, 'not a directory')
    for (const cwd of ['relative/path', `${root}\n`, file]) await expect(service.start({ id, engine: 'claude', prompt: 'Test', cwd })).rejects.toMatchObject({ code: 'INVALID_CWD' })
    expect(launches).toHaveLength(0)
  })
  it('does not start cancelled work while its folder is being prepared', async () => {
    await start(); await active(); service.plan(id, [task('a')]); service.cancel(id, 'a')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(tasks()[0].state).toBe('cancelled'); expect(launches).toHaveLength(1)
  })
  it('handles a removed harness without mistaking it for an uncertain spawn', async () => {
    await start(); await active(); service.plan(id, [task('a')]); deps.catalog = () => []
    await vi.waitFor(() => expect(tasks()[0].state).toBe('failed'))
    expect(tasks()[0]).toMatchObject({ uncertain: false, error: expect.stringContaining('no longer installed') })
    expect(launches).toHaveLength(1)
  })
  it('can run general-purpose work, resume, and add a new revision after completion', async () => {
    await start(); await active(); service.plan(id, [task('notes', [], 'engine:claude')]); await running('notes')
    expect(launches[1].dsh).toBeNull()
    await service.finish(id, 'notes', 1, 'Verified notes', [])
    await service.finish(id, 'notes', 1, 'Same completed result', [])
    service.complete(id, 'Done'); service.chat(id, '2'.repeat(32), 'Create a revision')
    expect(service.snapshot(id).state).toBe('active')
    service.plan(id, [task('revision', ['notes'], 'engine:claude')]); await running('revision')
    service.cancel(id); service.resume(id)
    expect(service.snapshot(id).state).toBe('active')
    expect(tasks()[0].state).toBe('succeeded'); expect(tasks()[1].state).toBe('cancelled')
    expect(launches).toHaveLength(3)
  })
  it('reports the same failure only once and rejects overlapping result commits', async () => {
    await start(); await active(); service.plan(id, [task('a'), task('b')]); await running('a'); await running('b')
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    await service.finish(id, 'a', 1, 'Missing tool', [], true)
    expect(sent).toHaveLength(1)
    const first = service.finish(id, 'b', 1, 'Verified', [])
    await expect(service.finish(id, 'b', 1, 'Verified', [])).rejects.toMatchObject({ code: 'FINISH_IN_PROGRESS' })
    await first
  })
  it.each([new Error('Input route disappeared'), 'unknown dispatch failure'])('retains uncertain guidance instead of resending: %s', async failure => {
    await start(); await active(); deps.send = vi.fn(() => { throw failure })
    service.chat(id, '3'.repeat(32), 'Make it taller')
    service.chat(id, '3'.repeat(32), 'Make it taller')
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'unknown', deliveryReason: failure instanceof Error ? failure.message : 'Message delivery could not be confirmed.' })]))
  })
  it('leaves a recovered pending receipt pending when no director was recorded', async () => {
    await start(); await active(); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; saved.messages.push({ id: '4'.repeat(32), role: 'system', text: 'Saved result', at: Date.now(), delivery: 'pending' })
    writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
    expect(sent).toHaveLength(0)
  })
  it('flushes coalesced transcript changes and bounds retained messages', async () => {
    await start(); await active()
    for (let i = 0; i < 205; i++) {
      service.ingest({ type: 'turn_started', agentId: 'agent-1' })
      service.ingest({ type: 'text_delta', agentId: 'agent-1', payload: { content: `Reply ${i}` } })
    }
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'Connection lost' } })
    service.ingest({ type: 'unknown', agentId: 'agent-1' })
    service.ingest({ type: 'text_delta', agentId: 'agent-1', replay: true, payload: { content: 'duplicate replay' } })
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(deps.stateDir, `${id}.json`), 'utf8')).error).toBe('Connection lost'))
    expect(service.snapshot(id).messages).toHaveLength(200)
    service.delivery({ deliveryId: 'missing', sessionId: 'not-this-project', state: 'rejected' })
    service.stop()
    const before = service.snapshot(id)
    service.delivery({ deliveryId: 'missing', sessionId: 'agent-1', state: 'started' })
    service.ingest({ type: 'error', agentId: 'agent-1', payload: { message: 'ignored after shutdown' } })
    expect(service.snapshot(id)).toEqual(before)
  })
  it('pauses after a real background storage failure without duplicating the agent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolve!: (value: { agentId: string }) => void
    deps.create = () => new Promise(r => { resolve = r })
    await start()
    const backup = join(root, 'state-backup')
    renameSync(deps.stateDir, backup); writeFileSync(deps.stateDir, 'blocked directory')
    try {
      resolve({ agentId: 'created-before-storage-failure' })
      await vi.waitFor(() => expect(service.snapshot(id).state).toBe('paused'))
      expect(service.snapshot(id).error).toMatch(/background error/)
    } finally { unlinkSync(deps.stateDir); renameSync(backup, deps.stateDir) }
    service.stop(); service = new OrchestratorService(deps)
    expect(service.snapshot(id).directorId).toBe('created-before-storage-failure')
  })
  it('keeps cancellation authoritative when director creation later rejects', async () => {
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    await start(); service.plan(id, [task('queued-before-director')]); service.cancel(id)
    reject(new Error('Spawn rejected after cancellation'))
    await vi.waitFor(() => expect(service.snapshot(id).error).toBe('Spawn rejected after cancellation'))
    expect(service.snapshot(id).state).toBe('cancelled')
    expect(tasks()[0].state).toBe('cancelled')
  })
  it('keeps cancellation authoritative when worker creation later rejects', async () => {
    await start(); await active()
    let reject!: (error: Error) => void
    deps.create = () => new Promise((_resolve, r) => { reject = r })
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    service.cancel(id, 'a'); reject(new Error('Late spawn refusal'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tasks()[0]).toMatchObject({ state: 'cancelled', uncertain: false })
  })
  it('does not downgrade a very fast worker result while creation is returning', async () => {
    await start(); await active()
    deps.create = async () => {
      await service.finish(id, 'fast', 1, 'Already verified', [])
      return { agentId: 'fast-worker' }
    }
    service.plan(id, [task('fast')])
    await vi.waitFor(() => expect(tasks()[0].agentId).toBe('fast-worker'))
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes non-Error worker failures and explicit input rejection', async () => {
    await start(); await active()
    deps.create = async () => { throw 'untyped refusal' }
    service.plan(id, [task('a')]); await vi.waitFor(() => expect(tasks()[0].state).toBe('blocked'))
    expect(tasks()[0].error).toBe('Could not start this specialist.')
    const receipt = '9'.repeat(32)
    service.chat(id, receipt, 'Explain the blocker')
    service.delivery({ deliveryId: receipt, sessionId: 'agent-1', state: 'rejected', reason: 'Input route closed' })
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: receipt, delivery: 'failed', deliveryReason: 'Input route closed' })]))
  })
  it('preserves orphaned worker results without inventing a director', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a'); service.stop()
    const file = join(deps.stateDir, `${id}.json`), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.directorId = null; writeFileSync(file, JSON.stringify(saved)); service = new OrchestratorService(deps)
    await service.finish(id, 'a', 1, 'Verified despite disconnected director', [])
    expect(tasks()[0].state).toBe('succeeded'); expect(sent).toHaveLength(0)
    expect(service.snapshot(id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'pending' })]))
  })
  it('does not lose a committed result if staging cleanup itself fails', async () => {
    await start(); await active(); service.plan(id, [task('a')]); await running('a')
    vi.mocked(filesystem.rm).mockRejectedValueOnce(new Error('Cleanup refused'))
    await service.finish(id, 'a', 1, 'Verified', [])
    expect(tasks()[0].state).toBe('succeeded')
  })
  it('normalizes untyped private-state and background notification failures', async () => {
    await start(); await active(); service.stop()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(privateState, 'readPrivateStateFile').mockImplementationOnce(() => { throw 'untyped state failure' })
    service = new OrchestratorService(deps); expect(service.list()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid state'))
    service.stop(); service = new OrchestratorService(deps)
    let failOnce = true
    deps.changed = () => { if (failOnce) { failOnce = false; throw 'untyped observer failure' } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const other = 'e'.repeat(32)
    await service.start({ id: other, engine: 'claude', prompt: 'Another project' })
    await vi.waitFor(() => expect(service.snapshot(other).state).toBe('paused'))
    expect(service.snapshot(other).error).toContain('unknown error')
  })
  it('finishes a 64-task mixed-engine graph with bounded parallelism and verified fan-in', async () => {
    deps.supportsEngine = engine => ['claude', 'codex', 'opencode'].includes(engine)
    deps.catalog = () => ['cad', 'blender', 'video', 'research'].map((name, i) => ({
      id: `test/${name}`, name, description: `Synthetic ${name}`, engine: ['codex', 'claude', 'opencode'][i % 3], viewer: i !== 3,
    }))
    await service.start({ id, engine: 'claude', prompt: 'Stress-test a creative fan-out/fan-in project', parallelism: 6 }); await active()
    const graph = Array.from({ length: 64 }, (_, i) => task(`work-${i}`, i < 6 ? [] : [...new Set([`work-${i - 6}`, `work-${Math.floor((i - 6) / 2)}`])], `test/${['cad', 'blender', 'video', 'research'][i % 4]}`))
    service.plan(id, graph.slice(0, 32)); service.plan(id, graph.slice(32))
    expect(() => service.plan(id, [task('one-too-many')])).toThrow(/64 tasks/)
    let finished = 0, checkedInputs = 0
    while (finished < 64) {
      await vi.waitFor(() => expect(tasks().some(t => t.state === 'running')).toBe(true))
      const batch = tasks().filter(t => t.state === 'running')
      expect(tasks().filter(t => ['running', 'launching'].includes(t.state)).length).toBeLessThanOrEqual(6)
      for (const current of batch) {
        for (const parent of current.dependsOn) {
          expect(readFileSync(join(current.cwd, 'inputs', parent, 'result.txt'), 'utf8')).toBe(`Verified ${parent}`)
          checkedInputs++
        }
        writeFileSync(join(current.cwd, 'result.txt'), `Verified ${current.id}`)
        await service.finish(id, current.id, current.attempt, `Checked ${current.dependsOn.length} upstream contracts`, ['result.txt'])
        finished++
      }
    }
    expect(checkedInputs).toBeGreaterThan(100)
    expect(new Set(launches.slice(1).map(l => l.engine))).toEqual(new Set(['claude', 'codex', 'opencode']))
    expect(launches).toHaveLength(65)
    service.complete(id, 'All 64 task results and pinned input contracts verified')
    expect(service.snapshot(id).state).toBe('completed')
  }, 30_000)
})
