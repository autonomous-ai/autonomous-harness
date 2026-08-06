/**
 * Release build: bundle the whole CLI into ONE self-contained `dist/cli.js` (all deps are pure-JS, so
 * a single artifact runs on every OS under the user's Node) + copy the standalone hook script.
 *
 * Version is baked in via esbuild `define(__ADAPTER_VERSION__)`, sourced from `ADAPTER_VERSION`
 * (set by scripts/upload-cli.sh) else package.json — so the running binary's version EXACTLY
 * equals the published manifest version (the self-updater compares them).
 *
 * `bufferutil`/`utf-8-validate` are ws's OPTIONAL native deps — mark external and provide a real
 * `require` via the banner so ws's try/catch fallback works without them.
 */
import * as esbuild from 'esbuild'
import { readFileSync, copyFileSync, rmSync } from 'fs'

const version =
  process.env.ADAPTER_VERSION ||
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// Start clean so no stale per-file `dist/*.js` / sourcemaps leak into the release artifact.
rmSync('dist', { recursive: true, force: true })

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  define: { __ADAPTER_VERSION__: JSON.stringify(version) },
  banner: {
    js: 'import{createRequire as ___cr}from"module";const require=___cr(import.meta.url);',
  },
  sourcemap: false,
  minify: true,
  keepNames: true,
  legalComments: 'eof',
  logLevel: 'info',
})

copyFileSync('hook/notify.mjs', 'dist/notify.mjs')
console.log(`✓ Bundled dist/cli.js (v${version}) + dist/notify.mjs`)
