import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { restoreLaunchRefusal, workdirAvailable } from './workdirAvailable.js'

const base = mkdtempSync(join(tmpdir(), 'workdir-available-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('workdirAvailable', () => {
  it('accepts a directory that is there', () => {
    expect(workdirAvailable(base)).toEqual({ ok: true })
  })

  it('refuses a path that is gone, and names it', () => {
    const gone = join(base, 'worktrees', 'feat-org-links')
    const result = workdirAvailable(gone)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain(gone)
    expect(result.ok === false && result.detail).toContain('no longer exists')
  })

  it('refuses a path that exists but is not a directory', () => {
    const file = join(base, 'not-a-folder')
    writeFileSync(file, '')
    const result = workdirAvailable(file)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.detail).toContain('is not a folder')
  })
})

describe('restoreLaunchRefusal', () => {
  it('passes a row that never had a folder', () => {
    expect(restoreLaunchRefusal({ cwd: null })).toBeNull()
  })

  it('passes a row whose folder is there', () => {
    expect(restoreLaunchRefusal({ cwd: base })).toBeNull()
  })

  it('refuses a row whose folder is gone, as CWD_NOT_FOUND', () => {
    const gone = join(base, 'gone')
    expect(restoreLaunchRefusal({ cwd: gone })).toEqual({
      error: 'CWD_NOT_FOUND',
      detail: `its folder ${gone} no longer exists — put it back, or create the agent again somewhere else`,
    })
  })
})
