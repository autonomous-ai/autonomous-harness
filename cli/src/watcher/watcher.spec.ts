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

  it('emits a file-backed transcript from the start when nothing was folded', async () => {
    // The generic byte-tail branch, which every JSONL engine uses. `fromStart` was only ever covered for
    // cursor, and the gap was live: pi's agent is discovered the moment the engine starts but its session
    // file only materialises once the first answer is written, so the re-attach that finally brought the
    // path tailed from the file's END and the whole first turn — prompt, tools and answer — was read as
    // history that never reached web or device.
    const dir = await mkdtemp(join(tmpdir(), 'machine-first-turn-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"a":1}\n{"a":2}\n{"a":3}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession({ sessionId: 'p1', engine: 'pi', transcriptPath }, { fromStart: true })
    await watcher.pollSession('p1')

    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}'])
    await watcher.stop()
  })

  it('still starts at the end by default, so a resumed session does not replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'machine-resume-'))
    cleanup.push(dir)
    const transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"old":1}\n{"old":2}\n')
    const watcher = new Watcher()
    const lines: string[] = []
    watcher.on('line', (event: LineEvent) => lines.push(event.text))

    await watcher.addSession({ sessionId: 'p2', engine: 'pi', transcriptPath })
    await watcher.pollSession('p2')
    expect(lines).toEqual([])

    await writeFile(transcriptPath, '{"old":1}\n{"old":2}\n{"new":3}\n')
    await watcher.pollSession('p2')
    expect(lines).toEqual(['{"new":3}'])
    await watcher.stop()
  })
})
