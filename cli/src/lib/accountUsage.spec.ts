import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  accountKey,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  readAccountUsage,
  type AccountUsageDeps,
} from './accountUsage.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'account-usage-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function write(relative: string, value: unknown): void {
  const path = join(home, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

interface Call {
  url: string
  headers: Record<string, string>
}

/** A vendor that answers every request with [status] and [body], and remembers what it was asked. */
function vendor(status = 200, body: unknown = { five_hour: { utilization: 12 } }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { calls, fetchImpl }
}

/** Never the real Keychain: every spec here runs on whatever machine runs the suite. */
function deps(extra: AccountUsageDeps = {}): AccountUsageDeps {
  return { home, readKeychain: async () => null, ...extra }
}

const CLAUDE_TOKEN = 'sk-ant-oat01-secret'
const CODEX_TOKEN = 'codex-access-secret'

describe('accountKey', () => {
  it('matches the vector the desktop pins', () => {
    // ⚠️ A cross-language contract: `test/usage_account_key_test.dart` in autonomous-harness-desktop
    // asserts these same two strings. If they drift, every remote reading looks like a different
    // account and the strip shows the same subscription twice.
    expect(accountKey('claude', 'acct-123')).toBe('85d2541574c31caa')
    expect(accountKey('codex', 'acct-123')).toBe('d9921dd1861038f4')
  })

  it('keeps the same id on two vendors apart', () => {
    expect(accountKey('claude', 'same')).not.toBe(accountKey('codex', 'same'))
  })
})

describe('readAccountUsage', () => {
  it('a machine signed in to nothing asks nobody', async () => {
    const { calls, fetchImpl } = vendor()
    const readings = await readAccountUsage(deps({ fetchImpl }))
    expect(readings).toEqual([
      { provider: 'claude', account: null, outcome: 'signedOut' },
      { provider: 'codex', account: null, outcome: 'signedOut' },
    ])
    expect(calls).toHaveLength(0)
  })

  it('asks Claude the way Claude Code does, and names the account without sending it', async () => {
    write('.claude/.credentials.json', { claudeAiOauth: { accessToken: CLAUDE_TOKEN } })
    write('.claude.json', { oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'a@b.c' } })
    const { calls, fetchImpl } = vendor(200, { seven_day: { utilization: 42 } })

    const [claude] = await readAccountUsage(deps({ fetchImpl }))

    expect(claude).toEqual({
      provider: 'claude',
      account: accountKey('claude', 'uuid-1'),
      outcome: 'answered',
      httpStatus: 200,
      body: { seven_day: { utilization: 42 } },
    })
    const call = calls.find((c) => c.url === CLAUDE_USAGE_URL)
    expect(call?.headers).toEqual({
      Authorization: `Bearer ${CLAUDE_TOKEN}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0',
    })
  })

  it('never puts a token, an id or an email in what goes back', async () => {
    // The reply crosses the relay and the desktop logs it. Only the hashed key may name the account.
    write('.claude/.credentials.json', { claudeAiOauth: { accessToken: CLAUDE_TOKEN } })
    write('.claude.json', { oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'person@example.com' } })
    write('.codex/auth.json', { tokens: { access_token: CODEX_TOKEN, account_id: 'codex-acct' } })
    const { fetchImpl } = vendor()

    const wire = JSON.stringify(await readAccountUsage(deps({ fetchImpl })))

    for (const secret of [CLAUDE_TOKEN, CODEX_TOKEN, 'uuid-1', 'person@example.com', 'codex-acct']) {
      expect(wire).not.toContain(secret)
    }
  })

  it('an expired Claude token is a sign-in, not a round trip', async () => {
    write('.claude/.credentials.json', { claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: 1_000 } })
    const { calls, fetchImpl } = vendor()

    const [claude] = await readAccountUsage(deps({ fetchImpl, now: () => 2_000 }))

    expect(claude).toMatchObject({ outcome: 'signedOut', message: expect.stringContaining('expired') })
    expect(calls.some((c) => c.url === CLAUDE_USAGE_URL)).toBe(false)
  })

  it('reads the Keychain before the file, as the desktop does on macOS', async () => {
    write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'from-file' } })
    const { calls, fetchImpl } = vendor()

    await readAccountUsage(deps({
      fetchImpl,
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain' } }),
    }))

    const call = calls.find((c) => c.url === CLAUDE_USAGE_URL)
    expect(call?.headers.Authorization).toBe('Bearer from-keychain')
  })

  it('scopes the Codex reading to its account', async () => {
    write('.codex/auth.json', { tokens: { access_token: CODEX_TOKEN, account_id: 'codex-acct' } })
    const { calls, fetchImpl } = vendor()

    const [, codex] = await readAccountUsage(deps({ fetchImpl }))

    expect(codex).toMatchObject({ outcome: 'answered', account: accountKey('codex', 'codex-acct') })
    const call = calls.find((c) => c.url === CODEX_USAGE_URL)
    expect(call?.headers).toEqual({
      Authorization: `Bearer ${CODEX_TOKEN}`,
      'ChatGPT-Account-Id': 'codex-acct',
    })
  })

  it('hands a refusal back as an answer, for the client to read', async () => {
    // The desktop already turns a 401 into "sign in" for its own reading; deciding it again here
    // would be a second opinion about the same status code.
    write('.codex/auth.json', { tokens: { access_token: CODEX_TOKEN } })
    const { fetchImpl } = vendor(401, { error: 'unauthorized' })

    const [, codex] = await readAccountUsage(deps({ fetchImpl }))

    expect(codex).toMatchObject({ outcome: 'answered', httpStatus: 401, account: null })
  })

  it('a vendor that cannot be reached is an outcome, not a throw', async () => {
    write('.codex/auth.json', { tokens: { access_token: CODEX_TOKEN } })
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch

    const [, codex] = await readAccountUsage(deps({ fetchImpl }))

    expect(codex).toEqual({ provider: 'codex', account: null, outcome: 'unreachable' })
  })

  it('a half-written credentials file reads as signed out', async () => {
    write('.claude/.credentials.json', '{"claudeAiOauth": {"accessTo')
    write('.codex/auth.json', 'not json at all')

    const readings = await readAccountUsage(deps({ fetchImpl: vendor().fetchImpl }))

    expect(readings.map((r) => r.outcome)).toEqual(['signedOut', 'signedOut'])
  })
})
