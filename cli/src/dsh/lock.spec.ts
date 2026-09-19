import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { lockDsh } from './lock.js'

const faults = vi.hoisted(() => ({ mkdir: false, write: false, race: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      if (faults.mkdir && String(args[0]).includes('/.lock-')) throw Object.assign(new Error('read only'), { code: 'EROFS' })
      if (faults.race && String(args[0]).endsWith('.lock-acme_thing')) {
        fs.mkdirSync(args[0], { recursive: true })
        fs.writeFileSync(join(String(args[0]), 'pid'), '123456')
        throw Object.assign(new Error('racing lock'), { code: 'EEXIST' })
      }
      return fs.mkdirSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (faults.write && String(args[0]).endsWith('/pid')) throw new Error('disk full')
      return fs.writeFileSync(...args)
    },
  }
})

describe('package mutation locks', () => {
  let root: string
  let saved: string
  const id = 'acme/thing'
  const owner = (pid?: string): string => {
    const path = join(root, '.lock-acme_thing')
    mkdirSync(path, { recursive: true })
    if (pid !== undefined) writeFileSync(join(path, 'pid'), pid)
    return path
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
    saved = env.DSH_DIR
    env.DSH_DIR = root
  })
  afterEach(() => {
    faults.mkdir = faults.write = faults.race = false
    vi.restoreAllMocks()
    env.DSH_DIR = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects invalid ids, excludes another owner, and releases for the next mutation', () => {
    expect(lockDsh('../../escape')).toBeNull()
    const release = lockDsh(id)!
    expect(lockDsh(id)).toBeNull()
    release()
    expect(existsSync(join(root, '.lock-acme_thing'))).toBe(false)
    lockDsh(id)!()
    // These two valid package ids must never share a lock filename.
    const first = lockDsh('acme--one/thing')!
    const second = lockDsh('acme/one--thing')!
    first(); second()
  })

  it('does not steal an incomplete owner record or another reaper', () => {
    const path = owner()
    expect(lockDsh(id)).toBeNull()
    for (const pid of ['nonsense', '-1', '0']) {
      writeFileSync(join(path, 'pid'), pid)
      expect(lockDsh(id)).toBeNull()
    }
    mkdirSync(`${path}.reap`)
    expect(lockDsh(id)).toBeNull()
  })

  it('recovers a dead owner and treats permission-denied process probes as live owners', () => {
    const path = owner('123456')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    expect(lockDsh(id)).toBeNull()
    expect(existsSync(path)).toBe(true)
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const release = lockDsh(id)
    expect(release).toBeTypeOf('function')
    release!()
  })

  it('reports filesystem failures, removing a lock whose owner could not be saved', () => {
    faults.mkdir = true
    expect(() => lockDsh(id)).toThrow('read only')
    faults.mkdir = false
    faults.write = true
    expect(() => lockDsh(id)).toThrow('disk full')
    expect(existsSync(join(root, '.lock-acme_thing'))).toBe(false)
  })

  it('bounds recovery attempts when another process keeps changing the owner', () => {
    faults.race = true
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(lockDsh(id)).toBeNull()
  })
})
