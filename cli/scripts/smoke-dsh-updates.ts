/** Desktop → real websocket/daemon → git/setup/doctor → existing workspace/viewer.
 * Only runs against the explicit temporary profile passed by store_update_e2e_test.dart. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { BackendSocket } from '../src/backendSocket.js'
import { env } from '../src/config/env.js'
import { mutateDsh } from '../src/dsh/service.js'
import { installedDsh, readInstalledIndex } from '../src/dsh/installed.js'
import { materializeWorkspace } from '../src/dsh/materialize.js'
import { resetBundledDshRegistry } from '../src/dsh/registry.js'
import { DshViewerManager } from '../src/dsh/viewer.js'

const root = process.argv[2]
if (process.env.HARNESS_DSH_UPDATE_SMOKE !== '1' || !root ||
    env.DSH_DIR !== join(resolve(root), 'installed') || env.ADAPTER_DATA_DIR !== join(resolve(root), 'data')) {
  throw new Error('An explicit, isolated update test profile is required')
}
const repo = join(root, 'repo')
const workspace = join(root, 'workspace')
const packagePath = 'store/agents/thing'
const viewerPath = 'store/viewers/pane'
const id = 'acme/thing'
const viewerId = 'acme/pane'
const write = (name: string, body: string): void => {
  const file = join(repo, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body, { mode: name.endsWith('.sh') ? 0o755 : 0o644 })
}
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' },
}).trim()
const shell = join(root, 'test-shell')
writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
process.env.SHELL = shell
write(`${packagePath}/harness.json`, JSON.stringify({ spec: 1, id, name: 'Update smoke', engine: 'claude',
  agent: { instructions: 'AGENTS.md', skills: ['skills'] }, workspace: { template: 'template', marker: 'project.txt' },
  viewer: { use: viewerId }, toolchain: { setup: './setup.sh', doctor: './doctor.sh' } }))
write(`${packagePath}/AGENTS.md`, 'original instructions')
write(`${packagePath}/skills/task/SKILL.md`, 'skill version 1')
write(`${packagePath}/template/project.txt`, 'starter')
write(`${packagePath}/setup.sh`, '#!/bin/sh\nprintf "%s" "$HARNESS_DSH_DIR" > setup-path\nsleep 0.4\necho "ok setup"\n')
write(`${packagePath}/doctor.sh`, '#!/bin/sh\ntest -f setup-path\n')
write(`${viewerPath}/harness.json`, JSON.stringify({ spec: 1, kind: 'viewer', id: viewerId, name: 'Smoke viewer',
  viewer: { command: './viewer.sh', url: 'http://127.0.0.1:${port}/' } }))
write(`${viewerPath}/viewer.sh`, `#!/bin/sh\nexec '${process.execPath}' server.mjs\n`)
write(`${viewerPath}/server.mjs`, `import {createServer} from 'node:http'; import {readFileSync} from 'node:fs';
createServer((req,res)=>res.end(readFileSync(process.env.HARNESS_WORKSPACE+'/project.txt'))).listen(Number(process.env.HARNESS_VIEWER_PORT),'127.0.0.1');\n`)
git('init', '-q', '-b', 'main')
let version = 0
function publish(fail = false, viewerOnly = false): string {
  version++
  if (viewerOnly) write(`${viewerPath}/release.txt`, `viewer ${version}`)
  else {
    write(`${packagePath}/skills/task/SKILL.md`, `skill version ${version}`)
    write(`${packagePath}/doctor.sh`, `#!/bin/sh\ntest -f setup-path || exit 1\necho "${fail ? 'miss broken release' : 'ok ready'}"\nexit ${fail ? 1 : 0}\n`)
  }
  git('add', '-A'); git('commit', '-qm', `release ${version}`)
  const ref = git('rev-parse', 'HEAD')
  Object.assign(globalThis, { __DSH_REGISTRY__: JSON.stringify([
    { id, name: 'Update smoke', engine: 'claude', repo, ref, path: packagePath, revision: git('rev-parse', `HEAD:${packagePath}`) },
    { id: viewerId, name: 'Smoke viewer', kind: 'viewer', repo, ref, path: viewerPath, revision: git('rev-parse', `HEAD:${viewerPath}`) },
  ]) })
  resetBundledDshRegistry()
  return ref
}
publish()
const installed = await mutateDsh({ id }, () => {})
if (!installed.ok) throw new Error(installed.detail)
mkdirSync(workspace)
await materializeWorkspace(installedDsh(id)!, workspace)
writeFileSync(join(workspace, 'project.txt'), 'my finished project')
writeFileSync(join(workspace, 'AGENTS.md'), readFileSync(join(workspace, 'AGENTS.md'), 'utf8') + '\nmy custom instructions\n')
writeFileSync(join(workspace, '.harness', 'verdict.json'), '{"ready":true,"summary":"finished"}')
publish(true)
let viewerUrl: string | null = null
const viewers = new DshViewerManager({ onUrl: (_, url) => { viewerUrl = url } })
await viewers.start('smoke-agent', installedDsh(id)!, workspace)
const backend = new BackendSocket('fixture-token')
backend.onDshInstall = (input, progress) => mutateDsh(input, progress)
backend.onDshUpdate = (packageId, progress) => mutateDsh({ id: packageId, update: true }, progress)
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise<void>(done => server.once('listening', done))
let sequence = 0
server.on('connection', socket => {
  const client = `local:update-smoke-${++sequence}`
  backend.registerLocalClient(client, { sendFrame: frame => { socket.send(JSON.stringify(frame)); return true }, sendBinary: () => true })
  socket.on('close', () => { void backend.unregisterLocalClient(client) })
  socket.on('message', async raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type === 'machine_select') {
      socket.send(JSON.stringify({ type: 'connected', payload: { machineId: 'm' } })); return
    }
    if (frame.type === 'smoke_publish') {
      const ref = publish(frame.payload.fail === true, frame.payload.viewerOnly === true)
      socket.send(JSON.stringify({ type: 'smoke_publish_result', payload: { requestId: frame.payload.requestId, ref } })); return
    }
    if (frame.type === 'smoke_reopen') {
      await viewers.stopAll()
      await materializeWorkspace(installedDsh(id)!, workspace)
      await viewers.start('smoke-agent', installedDsh(id)!, workspace)
      const preview = viewerUrl ? await (await fetch(viewerUrl)).text() : null
      socket.send(JSON.stringify({ type: 'smoke_reopen_result', payload: { requestId: frame.payload.requestId, preview,
        instructions: readFileSync(join(workspace, 'AGENTS.md'), 'utf8'),
        skill: readFileSync(join(workspace, '.claude', 'skills', 'task', 'SKILL.md'), 'utf8'),
        verdict: JSON.parse(readFileSync(join(workspace, '.harness', 'verdict.json'), 'utf8')), installed: readInstalledIndex() } })); return
    }
    if (frame.type === 'engines_probe') {
      socket.send(JSON.stringify({ type: 'engines_probe_result', payload: { requestId: frame.payload.requestId, engines: [] } })); return
    }
    backend.handleLocalFrame(client, frame)
  })
})
console.log(JSON.stringify({ port: (server.address() as { port: number }).port }))
process.stdin.resume()
process.stdin.on('end', () => { void viewers.stopAll().then(() => process.exit(0)) })
