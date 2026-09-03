/**
 * Is this pane's engine talking to a GATEWAY instead of its vendor's own API?
 *
 * `ori claude` (OpenRouter's launcher) does not stay in the process tree: it resolves the vendor binary
 * and `execve`s itself away, so `ps` shows a plain `claude`/`codex` and discovery finds the agent with no
 * help from here. What survives the exec is the ROUTING — env for claude/opencode/hermes
 * (`ANTHROPIC_BASE_URL=https://openrouter.ai/api` + a `sk-or-…` token), argv for codex
 * (`-c model_provider=openrouter …`, which is how `ori codex` configures the provider at all).
 *
 * So the gateway is read off the live process rather than declared: a hand-rolled
 * `ANTHROPIC_BASE_URL=…openrouter…` alias is treated exactly like `ori claude`, and nothing about ori's
 * internals is hard-coded here. Two things follow from a positive read — the runtime profile becomes
 * display-only (nothing may type `/model` into a pane whose catalog we cannot enumerate), and the
 * daemon's own recap/route calls go straight to OpenRouter with the key below instead of spawning a
 * vendor CLI that has no credential to spend.
 *
 * The key is held in memory only: never written to the registry, never logged, never sent to the backend.
 */

import { readProcessEnv } from './processEnv.js'
import type { ProcessIdentity } from './registry.js'

// Moved to processEnv.ts once the grid probe needed the same read; re-exported so the callers and
// specs that already knew them here keep working.
export { parseEnviron, parsePsEnviron } from './processEnv.js'

export interface GatewayRuntime {
  /** 'ori' ⇔ an OpenRouter endpoint is in play. null = a normal vendor login, or we could not look. */
  kind: 'ori' | null
  /** The OpenRouter key as the pane itself received it, when the probe could read one. */
  apiKey?: string
}

const NONE: GatewayRuntime = { kind: null }

/**
 * Env vars worth reading. Everything else in the process env is the user's business, not ours.
 *
 * Which variable carries the key is version-dependent and must not be assumed: measured on ori 0.7.1,
 * `ori claude` sets OPENROUTER_API_KEY **and** ANTHROPIC_API_KEY to the same `sk-or-…` value while
 * leaving ANTHROPIC_AUTH_TOKEN empty — the exact opposite of the layout its own bundled launcher code
 * describes. So try all of them, in the order that is unambiguous first, and skip empty values. Reading
 * a key at all is already gated on the endpoint being OpenRouter, so nothing here can pick up a vendor
 * credential by mistake.
 */
const BASE_URL_VARS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'] as const
const KEY_VARS = ['OPENROUTER_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

const OPENROUTER_HOST = /(?:^|\.)openrouter\.ai$/i

/**
 * Cache the probe so it costs one read per agent, not one per 5s scan — but cache the two answers
 * differently, because only one of them is permanent.
 *
 * A POSITIVE is permanent: a process's environment cannot change under it, so an agent seen routed
 * through OpenRouter stays routed for its whole life.
 *
 * A NEGATIVE expires. A launcher is discoverable for the ~100ms before it replaces itself, and in that
 * window "not a gateway" is the honest answer — `ori` carries none of the routing it is about to install.
 * Measured, not theorised: `ori codex` was scanned as `ori`, cached null, and stayed a non-gateway agent
 * for the rest of its life while the codex it became ran `-c model_provider=openrouter`.
 *
 * Keying on the executable was the first fix and it is NOT sufficient: macOS truncates `comm` to 16
 * chars, so `~/.local/bin/ori` and `~/.local/bin/claude` are the SAME string and the exec is invisible.
 * A short TTL closes that hole and every other one like it (an engine that rewrites its own argv, a slow
 * launcher) for one extra `ps eww` per non-gateway agent per minute.
 */
const cache = new Map<string, { runtime: GatewayRuntime; at: number }>()
const CACHE_LIMIT = 256
const NEGATIVE_TTL_MS = 60_000

/** Exported only so a test can pin the key's shape — the bugs above are invisible otherwise. */
export function gatewayRuntimeCacheKey(identity: ProcessIdentity): string {
  return `${identity.pid}\u0000${identity.startMarker}\u0000${identity.executable}`
}

export function clearGatewayRuntimeCache(): void {
  cache.clear()
}

function isOpenRouterUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    return OPENROUTER_HOST.test(new URL(value).hostname)
  } catch {
    return false
  }
}

/** `ori codex` passes its provider as argv, so codex panes are recognized without reading any env. */
export function argvNamesOpenRouterProvider(args: string): boolean {
  return /(?:^|\s)-c\s+model_provider=openrouter(?:\s|$)/.test(args)
    || /model_providers\.openrouter\./.test(args)
}

/** Classify an already-read env + argv. Exported for fixtures; the probe below adds I/O and caching. */
export function classifyGatewayRuntime(processEnv: Record<string, string>, args = ''): GatewayRuntime {
  const routed = BASE_URL_VARS.some((name) => isOpenRouterUrl(processEnv[name]))
  if (!routed && !argvNamesOpenRouterProvider(args)) return NONE
  const apiKey = KEY_VARS.map((name) => processEnv[name]?.trim()).find((value) => !!value)
  return apiKey ? { kind: 'ori', apiKey } : { kind: 'ori' }
}

/**
 * Read the routing of one live engine process.
 *
 * A failed read returns `{ kind: null }` and is NOT cached: "we could not look" is not "this is a normal
 * login", and it must never cost an agent its chip or its recap on the next pass.
 */
export async function probeGatewayRuntime(identity: ProcessIdentity, args = ''): Promise<GatewayRuntime> {
  const key = gatewayRuntimeCacheKey(identity)
  const hit = cache.get(key)
  if (hit && (hit.runtime.kind !== null || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.runtime

  const processEnv = await readProcessEnv(identity)
  if (!processEnv) return argvNamesOpenRouterProvider(args) ? { kind: 'ori' } : NONE

  const runtime = classifyGatewayRuntime(processEnv, args)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, { runtime, at: Date.now() })
  return runtime
}
