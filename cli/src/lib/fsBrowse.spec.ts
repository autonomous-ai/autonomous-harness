import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { listDir } from './fsBrowse.js'

const root = mkdtempSync(join(homedir(), '.harness-fsbrowse-test-'))
mkdirSync(join(root, 'Projects'))
mkdirSync(join(root, 'workspace'))
mkdirSync(join(root, '.hidden'))
mkdirSync(join(root, 'restricted'))
try { chmodSync(join(root, 'restricted'), 0o000) } catch { /* best effort — see permission-denied test below */ }

afterAll(() => {
  try { chmodSync(join(root, 'restricted'), 0o700) } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true })
})

describe('listDir', () => {
  it('lists directories, sorted, excluding hidden entries', () => {
    const result = listDir(root)
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.entries).toEqual([
      { name: 'Projects', isDir: true },
      { name: 'restricted', isDir: true },
      { name: 'workspace', isDir: true },
    ])
    expect(result.truncated).toBe(false)
  })

  it('defaults to the home directory when path is empty', () => {
    const result = listDir('')
    expect('error' in result).toBe(false)
    if (!('error' in result)) expect(result.path).toBe(homedir())
  })

  it('rejects a relative path', () => {
    expect(listDir('relative/path')).toEqual({ error: 'INVALID_PATH' })
  })

  it('rejects a path outside $HOME by default', () => {
    expect(listDir(tmpdir())).toEqual({ error: 'FORBIDDEN' })
  })

  it('reports NOT_FOUND for a missing directory', () => {
    expect(listDir(join(root, 'does-not-exist'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('reports NOT_A_DIRECTORY for a file', () => {
    const filePath = join(root, 'a-file.txt')
    writeFileSync(filePath, 'x')
    expect(listDir(filePath)).toEqual({ error: 'NOT_A_DIRECTORY' })
  })

  // Skipped when running as root (e.g. some CI containers), where chmod 000 doesn't block reads.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'maps EACCES to PERMISSION_DENIED',
    () => {
      expect(listDir(join(root, 'restricted'))).toEqual({ error: 'PERMISSION_DENIED' })
    },
  )
})
