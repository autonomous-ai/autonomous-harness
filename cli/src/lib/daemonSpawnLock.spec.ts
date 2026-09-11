import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dataDir = ''

async function loadLock() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonSpawnLock.js')
}

const lockDir = () => join(dataDir, 'adapter.spawn.lock')
const ownerFile = () => join(lockDir(), 'owner.json')

/** A real process that stays alive until killed — a lock owner whose liveness is not faked. */
function sleeper(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' })
}

const waitFor = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('daemon spawn lock', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-spawn-lock-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('acquires, records this process as the owner, and releases', async () => {
    const lock = await loadLock()
    const release = await lock.acquireSpawnLock('start')
    expect(existsSync(ownerFile())).toBe(true)
    const owner = lock.readSpawnLockOwner()
    expect(owner?.pid).toBe(process.pid)
    expect(owner?.purpose).toBe('start')
    release()
    expect(existsSync(lockDir())).toBe(false)
    expect(lock.readSpawnLockOwner()).toBeNull()
  })

  it('is re-entrant within one process and drops the lock only with the outermost release', async () => {
    const lock = await loadLock()
    const outer = await lock.acquireSpawnLock('update')
    const inner = await lock.acquireSpawnLock('start') // update → launch
    expect(lock.readSpawnLockOwner()?.purpose).toBe('update') // the outer section's identity holds
    inner()
    expect(existsSync(lockDir())).toBe(true)
    outer()
    expect(existsSync(lockDir())).toBe(false)
  })

  it('withSpawnLock releases on a throw', async () => {
    const lock = await loadLock()
    await expect(lock.withSpawnLock('handoff', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(existsSync(lockDir())).toBe(false)
  })

  it('waits for a live holder and reports it once, then acquires when it lets go', async () => {
    const lock = await loadLock()
    const holder = sleeper()
    await waitFor(() => !!holder.pid)
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({
      pid: holder.pid, startMarker: '', token: 'held-by-child', purpose: 'handoff', since: Date.now(),
    }), { mode: 0o600 })

    const waiting: unknown[] = []
    const acquired = lock.acquireSpawnLock('start', { waitMs: 5000, onWaiting: (o) => waiting.push(o) })
    // Generous: every poll reads the holder's start marker through `ps`, which a loaded box can
    // take a good fraction of a second over.
    await waitFor(() => waiting.length > 0, 2000)
    expect(waiting).toHaveLength(1)
    expect((waiting[0] as { pid: number }).pid).toBe(holder.pid)
    expect(readFileSync(ownerFile(), 'utf8')).toContain('held-by-child') // still theirs

    holder.kill('SIGKILL')
    const release = await acquired
    expect(lock.readSpawnLockOwner()?.pid).toBe(process.pid)
    release()
  })

  it('gives up with SpawnLockBusyError carrying the owner when the holder outlives the wait', async () => {
    const lock = await loadLock()
    const holder = sleeper()
    await waitFor(() => !!holder.pid)
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({
      pid: holder.pid, startMarker: '', token: 't', purpose: 'update', since: Date.now(),
    }), { mode: 0o600 })
    try {
      await expect(lock.acquireSpawnLock('start', { waitMs: 300 })).rejects.toMatchObject({
        name: 'SpawnLockBusyError',
        owner: { pid: holder.pid, purpose: 'update' },
      })
      expect(existsSync(ownerFile())).toBe(true)
    } finally {
      holder.kill('SIGKILL')
    }
  })

  it('reclaims a lock whose owner is dead', async () => {
    const lock = await loadLock()
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(dead.status).toBe(0)
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({
      pid: 999_999_999, startMarker: '', token: 'stale', purpose: 'start', since: Date.now() - 60_000,
    }), { mode: 0o600 })
    const release = await lock.acquireSpawnLock('start', { waitMs: 1000 })
    expect(lock.readSpawnLockOwner()?.pid).toBe(process.pid)
    release()
  })

  it('reclaims a lock whose pid has been reused by another process generation', async () => {
    const lock = await loadLock()
    mkdirSync(lockDir(), { mode: 0o700 })
    writeFileSync(ownerFile(), JSON.stringify({
      pid: process.pid, startMarker: 'different-process-generation', token: 'stale', purpose: 'start', since: Date.now(),
    }), { mode: 0o600 })
    const release = await lock.acquireSpawnLock('start', { waitMs: 1000 })
    expect(lock.readSpawnLockOwner()?.token).not.toBe('stale')
    release()
  })

  it('reclaims an ownerless directory once it is clearly debris, not one being created', async () => {
    const lock = await loadLock()
    mkdirSync(lockDir(), { mode: 0o700 })
    // Fresh and ownerless: someone is between mkdir and the O_EXCL write — do not touch it yet.
    await expect(lock.acquireSpawnLock('start', { waitMs: 250 })).rejects.toMatchObject({ name: 'SpawnLockBusyError', owner: null })
    // Age it past the debris threshold.
    const old = new Date(Date.now() - 10_000)
    const { utimesSync } = await import('fs')
    utimesSync(lockDir(), old, old)
    const release = await lock.acquireSpawnLock('start', { waitMs: 1000 })
    expect(lock.readSpawnLockOwner()?.pid).toBe(process.pid)
    release()
  })

  it('refuses a lock directory with an unsafe mode rather than reading it', async () => {
    const lock = await loadLock()
    mkdirSync(lockDir(), { mode: 0o777 })
    const { chmodSync } = await import('fs')
    chmodSync(lockDir(), 0o777)
    writeFileSync(ownerFile(), JSON.stringify({ pid: 1, startMarker: '', token: 't', purpose: 'start', since: 0 }), { mode: 0o600 })
    expect(() => lock.readSpawnLockOwner()).toThrow(/unsafe/)
  })

  it('gives up AT ONCE, naming the path, when something that is not a lock sits at the lock path', async () => {
    // A plain file — from a stray `touch`, a bad restore, whatever. Waiting 45s would never turn it
    // into a directory, and a stop that could not get past it would be a stop that does not work.
    const lock = await loadLock()
    writeFileSync(lockDir(), 'not a directory')
    const started = Date.now()
    await expect(lock.acquireSpawnLock('start', { waitMs: 45_000 })).rejects.toMatchObject({
      name: 'SpawnLockBusyError',
      owner: null,
      reason: expect.stringContaining('remove it by hand'),
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(lock.describeSpawnLockFailure(new lock.SpawnLockBusyError(null, 'why'))).toBe('why')
  })

  it('serializes two real spawners racing for the lock', async () => {
    // Each child takes the lock, appends "<pid> in", sleeps, appends "<pid> out". Serialized, the
    // trace is in/out/in/out; a broken lock interleaves in/in.
    const trace = join(dataDir, 'trace.log')
    const script = join(dataDir, 'racer.mts') // .mts: the temp dir has no package.json, so .ts would run as CJS
    const lockModule = join(process.cwd(), 'src', 'lib', 'daemonSpawnLock.ts')
    writeFileSync(script, `
      import { appendFileSync } from 'fs'
      import { withSpawnLock } from ${JSON.stringify(lockModule)}
      await withSpawnLock('start', async () => {
        appendFileSync(${JSON.stringify(trace)}, process.pid + ' in\\n')
        await new Promise((r) => setTimeout(r, 400))
        appendFileSync(${JSON.stringify(trace)}, process.pid + ' out\\n')
      })
    `)
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const run = () => new Promise<number | null>((resolve) => {
      const c = spawn(tsx, [script], { env: { ...process.env, ADAPTER_DATA_DIR: dataDir }, stdio: 'inherit' })
      c.on('exit', (code) => resolve(code))
    })
    const codes = await Promise.all([run(), run(), run()])
    expect(codes).toEqual([0, 0, 0])
    const lines = readFileSync(trace, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(6)
    for (let i = 0; i < lines.length; i += 2) {
      const [inPid, inWord] = lines[i].split(' ')
      const [outPid, outWord] = lines[i + 1].split(' ')
      expect(inWord).toBe('in')
      expect(outWord).toBe('out')
      expect(outPid).toBe(inPid)
    }
    expect(existsSync(lockDir())).toBe(false)
  }, 30_000)
})
