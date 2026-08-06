import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { Watcher, type LineEvent } from './watcher.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Watcher.pollAll', () => {
  it('drains every registered transcript to EOF without waiting for chokidar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-watcher-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"n":1}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath })
    await appendFile(transcriptPath, '{"n":2}\n{"n":3}\n')

    await watcher.pollAll()

    expect(lines).toEqual(['{"n":2}', '{"n":3}'])
    await watcher.stop()
  })

  it('replays only the changed Cursor suffix when a trailing turn sentinel is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-cursor-watcher-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    const user = '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}'
    const assistant = '{"role":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
    const ended = '{"type":"turn_ended","status":"completed"}'
    await writeFile(transcriptPath, `${user}\n${ended}\n`)
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))
    await watcher.addSession({ sessionId: 's1', engine: 'cursor', transcriptPath })

    await writeFile(transcriptPath, `${user}\n${assistant}\n`)
    await watcher.pollSession('s1')
    await appendFile(transcriptPath, `${ended}\n`)
    await watcher.pollSession('s1')

    expect(lines).toEqual([assistant, ended])
    await watcher.stop()
  })

  it('can emit an existing Cursor transcript from the start for first-turn discovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-cursor-first-turn-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"n":1}\n{"n":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession(
      { sessionId: 's1', engine: 'cursor', transcriptPath },
      { fromStart: true },
    )
    await watcher.pollSession('s1')

    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    await watcher.stop()
  })
})
