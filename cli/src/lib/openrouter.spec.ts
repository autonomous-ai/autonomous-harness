import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { openRouterComplete, redactKeys, resolveOpenRouterKey } from './openrouter.js'

const KEY = 'sk-or-v1-file-key'
const originalPath = env.ORI_CREDENTIALS_PATH
const originalEnvKey = process.env.OPENROUTER_API_KEY
const dirs: string[] = []

function credentialsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ori-cred-'))
  dirs.push(dir)
  const file = join(dir, 'credentials.json')
  writeFileSync(file, contents)
  return file
}

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY
  // A path that does not exist is the normal state on a machine without ori.
  env.ORI_CREDENTIALS_PATH = join(tmpdir(), 'ori-cred-absent', 'credentials.json')
})

afterEach(() => {
  env.ORI_CREDENTIALS_PATH = originalPath
  if (originalEnvKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = originalEnvKey
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('resolveOpenRouterKey', () => {
  it('prefers the daemon env, then the agent process, then the credentials file', async () => {
    env.ORI_CREDENTIALS_PATH = credentialsFile(JSON.stringify({ key: KEY }))
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-daemon'
    expect(await resolveOpenRouterKey({ kind: 'ori', apiKey: 'sk-or-v1-process' })).toBe('sk-or-v1-daemon')

    delete process.env.OPENROUTER_API_KEY
    expect(await resolveOpenRouterKey({ kind: 'ori', apiKey: 'sk-or-v1-process' })).toBe('sk-or-v1-process')

    expect(await resolveOpenRouterKey({ kind: 'ori' })).toBe(KEY)
    expect(await resolveOpenRouterKey()).toBe(KEY)
  })

  it('returns null — never throws — when the file is absent, corrupt or keyless', async () => {
    expect(await resolveOpenRouterKey()).toBeNull()
    env.ORI_CREDENTIALS_PATH = credentialsFile('{not json')
    expect(await resolveOpenRouterKey()).toBeNull()
    env.ORI_CREDENTIALS_PATH = credentialsFile(JSON.stringify({ userId: 'or_user_1' }))
    expect(await resolveOpenRouterKey()).toBeNull()
  })

  it('re-reads after the file changes, so `ori login` needs no daemon restart', async () => {
    const file = credentialsFile(JSON.stringify({ key: 'sk-or-v1-old' }))
    env.ORI_CREDENTIALS_PATH = file
    expect(await resolveOpenRouterKey()).toBe('sk-or-v1-old')
    writeFileSync(file, JSON.stringify({ key: 'sk-or-v1-new' }))
    expect(await resolveOpenRouterKey()).toBe('sk-or-v1-new')
  })
})

describe('openRouterComplete', () => {
  const options = { prompt: 'summarize this', model: 'deepseek/deepseek-v4-flash', apiKey: KEY }

  it('sends the prompt and returns the completion text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: ' recap\n\nbody ' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await openRouterComplete(options)).toBe('recap\n\nbody')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
    })
  })

  it('returns null on an HTTP error instead of failing the turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 402, text: async () => 'no credits' }))
    expect(await openRouterComplete(options)).toBeNull()
  })

  it('returns null on a transport failure and on an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    expect(await openRouterComplete(options)).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) }))
    expect(await openRouterComplete(options)).toBeNull()
  })

  it("re-throws the CALLER's abort, so a superseded recap stays superseded", async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }))
    await expect(openRouterComplete({ ...options, signal: controller.signal })).rejects.toThrow('aborted')
  })
})

describe('redactKeys', () => {
  it('keeps a key out of anything that can be logged', () => {
    expect(redactKeys(`bad request for ${KEY}`)).toBe('bad request for sk-…')
    expect(redactKeys('nothing secret here')).toBe('nothing secret here')
  })
})
