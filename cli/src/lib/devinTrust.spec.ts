import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Devin 3000.3.22 refuses to run in a directory it has not been trusted in, and the recap runs in a
 * throwaway scratch dir — so every devin recap failed until the dir is added to its trust list. The list
 * is the USER's file: other entries and any unrelated keys must survive.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

async function loadOneShot(devinHome: string) {
  vi.resetModules()
  process.env.DEVIN_HOME = devinHome
  return import('./oneshot.js')
}

function devinHome(seed?: unknown): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'adapter-devin-trust-'))
  dirs.push(home)
  const file = join(home, 'trusted_workspaces.json')
  if (seed !== undefined) writeFileSync(file, JSON.stringify(seed))
  return { home, file }
}

const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>

describe('devin scratch-dir trust', () => {
  it('appends the scratch dir, keeping the paths and keys already there', async () => {
    const { home, file } = devinHome({ trusted_paths: ['/Users/me/project'], other_setting: true })
    const { runDevinOneShot } = await loadOneShot(home)

    // The spawn fails (no `devin` on PATH under this test) — the trust write happens first, by design.
    await runDevinOneShot({ prompt: 'x', cwd: '/tmp/scratch-a', timeoutMs: 200 }).catch(() => {})

    expect(read(file)).toEqual({
      trusted_paths: ['/Users/me/project', '/tmp/scratch-a'],
      other_setting: true,
    })
  })

  it('is idempotent and starts a list when the file is absent or junk', async () => {
    const { home, file } = devinHome({ trusted_paths: ['/tmp/scratch-a'] })
    const { runDevinOneShot } = await loadOneShot(home)
    await runDevinOneShot({ prompt: 'x', cwd: '/tmp/scratch-a', timeoutMs: 200 }).catch(() => {})
    expect(read(file).trusted_paths).toEqual(['/tmp/scratch-a'])

    const fresh = devinHome()
    const one = await loadOneShot(fresh.home)
    await one.runDevinOneShot({ prompt: 'x', cwd: '/tmp/scratch-b', timeoutMs: 200 }).catch(() => {})
    expect(read(fresh.file).trusted_paths).toEqual(['/tmp/scratch-b'])

    const junk = devinHome('not an object')
    const two = await loadOneShot(junk.home)
    await two.runDevinOneShot({ prompt: 'x', cwd: '/tmp/scratch-c', timeoutMs: 200 }).catch(() => {})
    expect(read(junk.file).trusted_paths).toEqual(['/tmp/scratch-c'])
  })
})
