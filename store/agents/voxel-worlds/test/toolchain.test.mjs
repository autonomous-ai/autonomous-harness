// The Voxel Worlds harness scripts, run the way Harness runs them. Copy the starter's contract and
// keep it passing as the harness grows.
//   node --test test/*.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'harness.json'), 'utf8'))
const scratch = []
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'voxel-'))
  scratch.push(dir)
  return dir
}

function run(script, { cwd = here, env = {} } = {}) {
  const merged = { ...process.env }
  for (const [key, value] of Object.entries(env)) value === null ? delete merged[key] : (merged[key] = value)
  const result = spawnSync(join(here, script), { cwd, env: merged, encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('every script the manifest names is in the folder and executable', () => {
  for (const script of [manifest.workspace.init, manifest.toolchain.setup, manifest.toolchain.doctor]) {
    assert.doesNotThrow(() => accessSync(join(here, script), constants.X_OK), script)
  }
})

test('setup installs nothing and succeeds quietly', () => {
  assert.deepEqual(run(manifest.toolchain.setup), { code: 0, stdout: '', stderr: '' })
})

test('doctor says ok when sh is on PATH', () => {
  const { code } = run(manifest.toolchain.doctor)
  assert.equal(code, 0)
})

test('init lays out a workspace and seeds a not-ready verdict', () => {
  const workspace = tempDir()
  assert.equal(run(manifest.workspace.init, { cwd: workspace, env: { HARNESS_DSH: manifest.id } }).code, 0)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.equal(readFileSync(join(workspace, '.harness-initialized'), 'utf8'), `initialized by ${manifest.id}\n`)
})

test('the manifest names a viewer package and an HTML artifact', () => {
  assert.equal(manifest.viewer.use, 'autonomous/web-viewer')
  assert.deepEqual(manifest.viewer.artifactExtensions, ['.html'])
})

test('seed-verdict reflects whether a world exists', () => {
  const workspace = tempDir()
  run(manifest.workspace.init, { cwd: workspace })
  // the script takes the workspace by argument and writes the feed inside it
  const script = join(here, 'skills/world-builder/scripts/seed-verdict.sh')
  assert.equal(spawnSync(script, [workspace], { cwd: workspace, encoding: 'utf8' }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8')).ready, false)
  // a world appears; the feed should flip to ready
  mkdirSync(join(workspace, 'world'), { recursive: true })
  writeFileSync(join(workspace, 'world/index.html'), '<!doctype html><title>w</title>')
  assert.equal(spawnSync(script, [workspace], { cwd: workspace, encoding: 'utf8' }).status, 0)
  assert.equal(JSON.parse(readFileSync(join(workspace, '.harness/verdict.json'), 'utf8')).ready, true)
})
