/**
 * The adapter's own version, the single runtime source of truth for the self-updater's compare.
 *
 * `__ADAPTER_VERSION__` is injected at build time via esbuild `define` (both the bundle build
 * `build-bundle.mjs` and the per-file `build.mjs`), sourced from `package.json` (or the release
 * script's `ADAPTER_VERSION`). Under `tsx` dev there is no define, so we fall back to reading
 * `package.json` at runtime — `npm run dev` still reports the real version, not a sentinel.
 */
import { readFileSync } from 'node:fs'

declare const __ADAPTER_VERSION__: string | undefined

function resolveVersion(): string {
  if (typeof __ADAPTER_VERSION__ !== 'undefined') return __ADAPTER_VERSION__
  try {
    // src/version.ts (or dist/version.js) → ../package.json = package.json.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}

export const VERSION: string = resolveVersion()
