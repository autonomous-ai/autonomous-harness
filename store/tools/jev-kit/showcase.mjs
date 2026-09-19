#!/usr/bin/env node
// showcase.mjs — take a store showcase picture of a Jev harness: real output, 1600x1000 JPEG under
// 350 KB, saved to store/showcase/<harness>/<name>.jpg (the rules in store/README.md).
//
//   node store/tools/jev-kit/showcase.mjs <harness> <name> [--wait 6000] [--steps steps.json] [--port 4990] [--config '{"k":1}']
//
// It boots the harness's own viewer on a temp workspace seeded from template/ (with --config merged
// into the marker file), drives a headless Chrome on CDP port 9333 through shot.mjs, and converts
// the PNG with macOS `sips`. A steps file uses shot.mjs's format; its last shot is the picture.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const STORE = dirname(dirname(HERE))
const [harness, name, ...rest] = process.argv.slice(2)
const opt = Object.fromEntries(rest.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
if (!harness || !name) { console.error('usage: showcase.mjs <harness> <name> [--wait ms] [--steps file] [--port n] [--config json]'); process.exit(2) }

const dir = join(STORE, 'agents', harness)
const manifest = JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8'))
const ws = mkdtempSync(join(tmpdir(), `showcase-${harness}-`))
cpSync(join(dir, manifest.workspace.template), ws, { recursive: true })
if (opt.config) {
  const marker = join(ws, manifest.workspace.marker)
  writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, 'utf8')), ...JSON.parse(opt.config) }, null, 2))
}
const mod = await import(join(dir, 'viewer/viewer.mjs'))
const start = mod[Object.keys(mod).find((k) => /^start.*Viewer$/.test(k))]
const port = Number(opt.port || 4990)
const viewer = await start({ workspace: ws, port })

const png = join(ws, 'shot.png')
const steps = opt.steps
  ? JSON.parse(readFileSync(opt.steps, 'utf8')).map((s) => (s.shot ? { shot: png } : s))
  : [{ wait: Number(opt.wait || 6000) }, { shot: png }]
const stepsFile = join(ws, 'steps.json')
writeFileSync(stepsFile, JSON.stringify(steps))
try {
  // Async on purpose: this process also hosts the viewer, so a blocking call would freeze the page.
  const { stdout: out } = await promisify(execFile)(process.execPath, [join(HERE, 'shot.mjs'), '--url', `http://127.0.0.1:${port}/`, '--steps', stepsFile, '--w', '1600', '--h', '1000'], { encoding: 'utf8' })
  for (const line of out.split('\n')) if (/PAGE (EXCEPTION|console\.error)/.test(line)) console.log(line)
  const destDir = join(STORE, 'showcase', harness)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `${name}.jpg`)
  let kb = 0
  for (const q of [82, 74, 66, 58, 50, 42]) {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), png, '--out', dest], { stdio: 'ignore' })
    kb = statSync(dest).size / 1024
    if (kb <= 350) { console.log(`${dest}  ${kb.toFixed(0)} KB at quality ${q}`); break }
  }
  if (kb > 350) console.log(`WARNING: ${dest} is ${kb.toFixed(0)} KB, over the 350 KB limit`)
} finally {
  await viewer.close()
  rmSync(ws, { recursive: true, force: true })
}
process.exit(0)
