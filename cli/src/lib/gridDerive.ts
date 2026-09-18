/**
 * The account's own private grid, worked out on this machine when the backend has not said.
 *
 * The backend mints the name and pushes it on every connect (`machine_meta.gridName`,
 * `backendSocket.ts`); that is the source of truth. But a backend that predates the route pushes
 * nothing, and then every picker on every pane was empty while `grid models <name>` listed the
 * model fine — the daemon knew how to ask, just not what to ask about. The name is recognisable
 * without asking anyone, by the same rule the Grid harness gives its agent
 * (`store/agents/autonomous-grid`, "Which grid"): the signed-in email's local part, lowercased,
 * runs of non-alphanumerics folded to `-`, followed by `-` and eight hex digits, of type
 * `permissioned-public`. Exactly one grid this computer is signed into matches, or the answer is
 * null — never a guess, because names are global and a wrong one is someone else's grid.
 *
 * Read from `~/.grid/credentials.toml` (the email) and `grid ls --json` (the grids), cached for a
 * short while: the list costs a `grid` spawn and a network round trip, and the picker asks on
 * every open.
 */
import { readFileSync } from 'node:fs'
import { gridCredentialsPath } from './gridCredentials.js'
import { gridJson } from './gridExec.js'

const TTL_MS = 60_000

let memo: { at: number; name: string | null } | null = null

/** The email `grid login` recorded, or null when this machine has no grid credentials. */
export function signedInGridEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const toml = readFileSync(gridCredentialsPath(env), 'utf-8')
    const match = /^\s*email\s*=\s*"([^"]+)"/m.exec(toml)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** The name a private grid for [email] carries, as a pattern: `<slug>-<8 hex>`. */
export function privateGridPattern(email: string): RegExp {
  const local = email.split('@')[0] ?? ''
  const slug = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user'
  return new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}$`)
}

/** Pick the one private grid for [email] out of `grid ls --json` rows, or null. */
export function pickPrivateGrid(
  email: string,
  rows: Array<{ grid?: unknown; type?: unknown }>,
): string | null {
  const pattern = privateGridPattern(email)
  const names = rows
    .filter((row) => row.type === 'permissioned-public' && typeof row.grid === 'string' && pattern.test(row.grid))
    .map((row) => row.grid as string)
  return names.length === 1 ? names[0]! : null
}

/**
 * The account's private grid as this machine can tell, or null. Memoised for [TTL_MS]; pass
 * `fresh` to bypass the memo (a sign-in that just created the grid).
 */
export async function deriveHarnessGridName(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh && memo && Date.now() - memo.at < TTL_MS) return memo.name
  const email = signedInGridEmail()
  let name: string | null = null
  if (email) {
    const { value } = await gridJson<Array<{ grid?: unknown; type?: unknown }>>(['--remote', 'ls'])
    if (Array.isArray(value)) name = pickPrivateGrid(email, value)
  }
  memo = { at: Date.now(), name }
  return name
}

/** For tests. */
export function resetGridDeriveMemo(): void { memo = null }
