import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { findGrokTranscript } from './session.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'grok-session-spec-'))
  cleanup.push(path)
  return path
}

describe('Grok transcript discovery', () => {
  it('resolves the URL-encoded cwd layout', async () => {
    const root = await home()
    const cwd = '/workspace/project with spaces'
    const sessionId = '8184b11d-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(root, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(transcript, '{}\n')

    await expect(findGrokTranscript(root, cwd, sessionId)).resolves.toBe(transcript)
  })

  it('resolves the long-cwd hash layout through its .cwd sidecar', async () => {
    const root = await home()
    const cwd = `/workspace/${'long-segment/'.repeat(30)}`
    const sessionId = '019fea5b-3a9c-7903-a30a-8d88a9342df6'
    const group = join(root, 'sessions', 'a1b2c3d4')
    const transcript = join(group, sessionId, 'updates.jsonl')
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(join(group, '.cwd'), `${cwd}\n`)
    await writeFile(transcript, '{}\n')

    await expect(findGrokTranscript(root, cwd, sessionId)).resolves.toBe(transcript)
  })

  it('does not bind a session from another cwd', async () => {
    const root = await home()
    const sessionId = '98ee3dac-40b1-4146-91dc-f65591f6289a'
    const group = join(root, 'sessions', 'a1b2c3d4')
    await mkdir(join(group, sessionId), { recursive: true })
    await writeFile(join(group, '.cwd'), '/workspace/other\n')
    await writeFile(join(group, sessionId, 'updates.jsonl'), '{}\n')

    await expect(findGrokTranscript(root, '/workspace/wanted', sessionId)).resolves.toBeNull()
  })

  it('rejects a non-UUID session id before joining it into a path', async () => {
    const root = await home()
    await expect(findGrokTranscript(root, '/workspace/wanted', '../../outside')).resolves.toBeNull()
  })
})
