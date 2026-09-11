/**
 * This machine's agent-account usage — Claude's and Codex's rate limits — read with THIS machine's
 * own credentials, for a client that cannot read them itself.
 *
 * The desktop app reads the account on the computer it runs on directly. A remote machine may be
 * signed in to a DIFFERENT account, and a rate limit belongs to an account rather than to a
 * computer, so the only honest way to show that one is to ask the machine that holds it. This is the
 * answer to `usage_read`.
 *
 * **The credential never leaves this machine.** The vendor is called from here, and what goes back
 * over the relay is the vendor's answer — its HTTP status and body — plus an opaque account key.
 * Never the token, never the account's email or id.
 *
 * **Deliberately a thin proxy, not a parser.** The body is returned as the vendor sent it, and the
 * client interprets it with the SAME code that interprets its own local reading
 * (`autonomous-harness-desktop/lib/usage/*_usage_source.dart`). Parsing it here would put the
 * window-naming rules — "five_hour" is "Session", Codex derives its labels from
 * `limit_window_seconds`, Fable has been spelled three ways — in two languages, and the two copies
 * would drift the first time either vendor renamed a field.
 *
 * ⚠️ **Both endpoints are undocumented**, on exactly the terms the desktop app uses them: they are
 * what `claude /usage` and the Codex CLI ask, the Claude one answers only a token minted for Claude
 * Code (hence the beta header and the CLI's own user agent), and either can change without notice.
 * Every failure here is an `outcome`, never a throw — the reply must go back either way.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type UsageProviderId = 'claude' | 'codex'

/**
 * How far the question got. `answered` means the vendor was asked and replied — WHATEVER it
 * replied, a 401 included; the client decides what a status means, because it already does for
 * its own reading.
 */
export type UsageOutcome = 'answered' | 'signedOut' | 'unreachable'

export interface AccountUsageReading {
  provider: UsageProviderId
  /**
   * `accountKey(provider, id)`, or null when this machine cannot name the account it is signed in
   * as. The client compares these to show one figure per ACCOUNT rather than one per machine.
   */
  account: string | null
  outcome: UsageOutcome
  httpStatus?: number
  body?: unknown
  /** Why there is no answer, when this side knows better than a status code can say. */
  message?: string
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Under the client's own 10s request timeout, so a slow vendor still produces a reply. */
const FETCH_TIMEOUT_MS = 8_000

/**
 * An account, as the wire names it: the first 16 hex characters of sha256(`<provider>:<id>`).
 *
 * Hashed rather than sent raw because the reply is LOGGED — the desktop writes every RPC answer to
 * `~/.harness/logs` — and an account id or email has no business there. Equality survives hashing,
 * which is all the client needs.
 *
 * ⚠️ **A cross-language contract.** The desktop computes the same key for its own account
 * (`lib/usage/usage_account_key.dart`) and the two must agree byte for byte, or every remote reading
 * would look like a different account. Both test suites pin the same vector for that reason.
 */
export function accountKey(provider: UsageProviderId, accountId: string): string {
  return createHash('sha256').update(`${provider}:${accountId}`).digest('hex').slice(0, 16)
}

/** Everything that reaches outside this function, so a spec never touches a real home, keychain or
 *  network. Production passes nothing. */
export interface AccountUsageDeps {
  home?: string
  platform?: NodeJS.Platform
  fetchImpl?: typeof fetch
  readKeychain?: () => Promise<string | null>
  now?: () => number
}

/** Both accounts, asked at once — one being slow says nothing about the other. */
export async function readAccountUsage(deps: AccountUsageDeps = {}): Promise<AccountUsageReading[]> {
  return Promise.all([readClaude(deps), readCodex(deps)])
}

async function readClaude(deps: AccountUsageDeps): Promise<AccountUsageReading> {
  const home = deps.home ?? homedir()
  // The Keychain first and the file second, as the desktop reads its own: macOS keeps the token in
  // the login Keychain and Linux in a file, and a Keychain that will not answer is a state, not the
  // end of the road.
  const stored = (await readKeychain(deps)) ?? (await readText(join(home, '.claude', '.credentials.json')))
  const oauth = asRecord(asRecord(parseJson(stored))?.claudeAiOauth)
  const token = stringField(oauth?.accessToken)
  // The account lives beside the token rather than in it: `~/.claude.json` is where Claude Code
  // records who it is signed in as, on every platform.
  const profile = asRecord(asRecord(parseJson(await readText(join(home, '.claude.json'))))?.oauthAccount)
  const accountId = stringField(profile?.accountUuid)
  const account = accountId ? accountKey('claude', accountId) : null
  if (!token) return { provider: 'claude', account, outcome: 'signedOut' }

  // Spent as a sign-in rather than as a round trip: nothing here refreshes a token Claude Code owns,
  // so the request could only fail. The sentence is the desktop's own, word for word.
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null
  if (expiresAt !== null && expiresAt < (deps.now ?? Date.now)()) {
    return {
      provider: 'claude',
      account,
      outcome: 'signedOut',
      message: 'Claude session expired — run claude to sign in again',
    }
  }
  return ask('claude', account, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.1.0',
  }, deps)
}

async function readCodex(deps: AccountUsageDeps): Promise<AccountUsageReading> {
  const home = deps.home ?? homedir()
  const tokens = asRecord(asRecord(parseJson(await readText(join(home, '.codex', 'auth.json'))))?.tokens)
  const token = stringField(tokens?.access_token)
  const accountId = stringField(tokens?.account_id)
  const account = accountId ? accountKey('codex', accountId) : null
  if (!token) return { provider: 'codex', account, outcome: 'signedOut' }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  // The account the backend scopes the reading to — the same id the key above is made from.
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  return ask('codex', account, CODEX_USAGE_URL, headers, deps)
}

async function ask(
  provider: UsageProviderId,
  account: string | null,
  url: string,
  headers: Record<string, string>,
  deps: AccountUsageDeps,
): Promise<AccountUsageReading> {
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const text = await response.text()
    return { provider, account, outcome: 'answered', httpStatus: response.status, body: parseJson(text) }
  } catch {
    // No detail on purpose: a network error's message can carry the URL, and the client already
    // knows which vendor it asked.
    return { provider, account, outcome: 'unreachable' }
  }
}

/** The macOS Keychain item Claude Code writes — `security` rather than a native module, for one
 *  read of one generic password. */
async function readKeychain(deps: AccountUsageDeps): Promise<string | null> {
  if (deps.readKeychain) return deps.readKeychain()
  if ((deps.platform ?? process.platform) !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5_000 },
    )
    const out = stdout.trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** A half-written credentials file is not news — the CLI that owns it is mid-refresh, and the next
 *  poll a minute from now reads it whole. */
function parseJson(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
