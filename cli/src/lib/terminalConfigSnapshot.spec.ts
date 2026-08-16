import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTerminalConfigSnapshot, terminalConfigSnapshotPath, writeTerminalConfigSnapshot } from './terminalConfigSnapshot.js'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('terminal config snapshot', () => {
  it('atomically persists only configured endpoints in configured order', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'terminal-config-'))
    cleanup.push(dataDir)
    writeTerminalConfigSnapshot(dataDir, { backends: ['herdr'], herdrSessions: ['work', 'default'] }, [
      { sessionName: 'default', endpointId: 'default-id', socketPath: '/safe/default.sock', generation: { device: 1, inode: 2 } },
      { sessionName: 'ignored', endpointId: 'ignored-id', socketPath: '/safe/ignored.sock', generation: { device: 3, inode: 4 } },
      { sessionName: 'work', endpointId: 'work-id', socketPath: '/safe/work.sock', generation: { device: 5, inode: 6 } },
    ])

    const file = terminalConfigSnapshotPath(dataDir)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readTerminalConfigSnapshot(dataDir)?.herdrEndpoints.map((endpoint) => endpoint.sessionName)).toEqual(['work', 'default'])
    expect(readFileSync(file, 'utf8')).not.toContain('ignored-id')
  })

  it('tightens an owner-owned legacy snapshot before reading it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'terminal-config-'))
    cleanup.push(dataDir)
    writeTerminalConfigSnapshot(dataDir, { backends: ['tmux'], herdrSessions: [] }, [])
    chmodSync(terminalConfigSnapshotPath(dataDir), 0o644)
    expect(readTerminalConfigSnapshot(dataDir)?.backends).toEqual(['tmux'])
    expect(statSync(terminalConfigSnapshotPath(dataDir)).mode & 0o777).toBe(0o600)
  })

  it('rejects a group-writable snapshot instead of tightening and trusting it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'terminal-config-'))
    cleanup.push(dataDir)
    writeTerminalConfigSnapshot(dataDir, { backends: ['tmux'], herdrSessions: [] }, [])
    chmodSync(terminalConfigSnapshotPath(dataDir), 0o660)
    expect(readTerminalConfigSnapshot(dataDir)).toBeNull()
    expect(statSync(terminalConfigSnapshotPath(dataDir)).mode & 0o777).toBe(0o660)
  })

  it('neither reads nor replaces a symlinked snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-config-'))
    cleanup.push(root)
    const dataDir = join(root, 'data')
    const target = join(root, 'target.json')
    writeFileSync(target, '{}', { mode: 0o600 })
    writeTerminalConfigSnapshot(dataDir, { backends: ['tmux'], herdrSessions: [] }, [])
    rmSync(terminalConfigSnapshotPath(dataDir))
    symlinkSync(target, terminalConfigSnapshotPath(dataDir))

    expect(readTerminalConfigSnapshot(dataDir)).toBeNull()
    expect(() => writeTerminalConfigSnapshot(dataDir, { backends: ['tmux'], herdrSessions: [] }, [])).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('{}')
  })
})
