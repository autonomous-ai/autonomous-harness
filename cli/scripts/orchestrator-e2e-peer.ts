/** Isolated daemon adapter + real tmux + real viewers. No live Harness state.
 * Deterministic by default; real models require the separate LIVE opt-in. */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const live = process.env.HARNESS_ORCHESTRATOR_LIVE === '1'
if (!live && process.env.HARNESS_ORCHESTRATOR_E2E !== '1') throw new Error('Opt in with HARNESS_ORCHESTRATOR_E2E=1, or explicitly authorize model usage with HARNESS_ORCHESTRATOR_LIVE=1')
const installedRoot = process.env.DSH_DIR ?? join(homedir(), '.harness', 'dsh')
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'orchestrator-e2e-'))
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const socket = join(root, 'tmux.sock')
const machineId = randomBytes(16).toString('hex')
const loader = fileURLToPath(import.meta.resolve('tsx'))
Object.assign(process.env, {
  ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
  HARNESS_AUTH_DIR: join(root, 'auth'), DSH_DIR: join(root, 'dsh'),
  ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
  DISABLE_HOOK_INSTALL: 'true', DISABLE_GRID_INSTALL: 'true',
})
const [{ BackendSocket }, { attachLocalWsServer }, { registry }, { createAndRegisterPane },
  { installedDsh, upsertInstalledRecord }, { materializeWorkspace }, { DshViewerManager }, { shellQuote }, { dshLaunch }] = await Promise.all([
  import('../src/backendSocket.js'), import('../src/localWsServer.js'), import('../src/lib/registry.js'), import('../src/lib/createAgentPane.js'),
  import('../src/dsh/installed.js'), import('../src/dsh/materialize.js'), import('../src/dsh/viewer.js'), import('../src/orchestrator/prompts.js'), import('../src/dsh/launch.js'),
])
const backend = new BackendSocket(machineId)
const urls = new Map<string, string | null>()
const viewers = new DshViewerManager({ onUrl: (id, url) => urls.set(id, url), log: line => console.error(line) })
let created = 0, modelTurns = 0, stopped = false
const inputs: string[] = []
const pending = new Set<Promise<unknown>>()
const track = (work: Promise<unknown>) => { pending.add(work); void work.catch(e => console.error(e)).finally(() => pending.delete(work)) }
const server = createServer(async (req, res) => {
  if (req.url === '/fixture-stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ created, modelTurns, inputs })); return }
  if (live && req.url === '/live-turn' && req.method === 'POST') {
    if (modelTurns >= 12 || stopped) { res.writeHead(429); res.end('Live test turn limit reached'); return }
    modelTurns++; res.end('ok'); return
  }
  if (req.url !== '/fixture-event' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
  let body = ''
  for await (const chunk of req) { body += chunk; if (body.length > 32_000) { res.writeHead(413); res.end(); return } }
  try {
    const event = JSON.parse(body)
    const agent = registry.list().find(a => a.cwd === event.cwd)
    if (!agent || !['text_delta', 'turn_started', 'turn_ended', 'error'].includes(event.type)) { res.writeHead(400); res.end(); return }
    backend.send({ type: event.type, agentId: agent.agentId, payload: { content: event.content, message: event.content } })
    res.end('ok')
  } catch { res.writeHead(400); res.end() }
})
const local = attachLocalWsServer(server, { machineId, backend })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
backend.orchestratorCommand = `${[process.execPath, '--import', loader, join(cliRoot, 'src/cli.ts')].map(shellQuote).join(' ')} orchestrator --port ${port} --machine ${machineId}`
if (!live) backend.engineProbeProvider = async (engines = ['claude']) => engines.map(engine => ({ engine, installed: true, command: process.execPath, installable: false }))
backend.dshFrameProvider = agent => ({ id: agent.dsh ?? null, name: agent.dsh ?? null, viewerUrl: urls.get(agent.agentId) ?? null, viewerName: 'Fixture viewer', verdict: null })
if (live) {
  // Read-only links to ALREADY installed harnesses; never change the real index.
  const records = JSON.parse(await readFile(join(installedRoot, 'installed.json'), 'utf8'))
  for (const record of records) if (['autonomous/solid', 'autonomous/autonomous-workshop', 'autonomous/blender', 'autonomous/model-viewer', 'autonomous/cad-viewer'].includes(record.id)) upsertInstalledRecord(record)
} else for (const name of ['shape', 'research', 'scene', 'film']) {
  const dir = join(root, 'dsh', 'fixture', name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'AGENTS.md'), `This is the ${name} integration-test harness. Produce deliverable.txt and verify its inputs.\n`)
  await writeFile(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id: `fixture/${name}`, name, engine: 'claude',
    description: `${name} deterministic integration fixture`, agent: { instructions: 'AGENTS.md' },
    ...(name === 'research' ? {} : { viewer: { command: `${shellQuote(process.execPath)} ${shellQuote(join(cliRoot, 'scripts/orchestrator-fixture-viewer.mjs'))}`, url: 'http://127.0.0.1:${port}/', artifactExtensions: ['.txt'] } }),
  }))
  upsertInstalledRecord({ id: `fixture/${name}`, dir, source: dir, ref: null, commit: null, linked: true, installedAt: Date.now() })
}
await mkdir(join(root, 'workspace'), { mode: 0o700 })
await exec('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper', '/bin/sleep', '3600'])
backend.onCreateAgent = async input => {
  if (live && created >= 6) return { ok: false, error: 'LIVE_TEST_LIMIT', detail: 'The live validation is limited to six agents total. Report the result instead of creating more.' }
  const dsh = input.dsh ? installedDsh(input.dsh) : undefined
  if (dsh) await materializeWorkspace(dsh, input.cwd)
  const result = await createAndRegisterPane({
    tmuxBackend: {
      create: async request => {
        const environment = Object.entries(request.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
        const result = await exec('tmux', ['-S', socket, 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', request.label!, '-c', input.cwd, ...environment, ...request.command!])
        return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: result.stdout.trim() } }
      },
      kill: async runtime => {
        await exec('tmux', ['-S', socket, 'kill-pane', '-t', runtime.paneId])
        return { state: 'succeeded', dispatch: 'executed' }
      },
    },
    registry, engine: input.engine, cwd: input.cwd, dsh: input.dsh, defaultName: input.name,
    ...(dsh ? { env: dshLaunch(dsh, input.cwd).env } : {}),
    sessionLabel: `harness-fixture-${++created}`,
    argv: live
      ? [process.execPath, '--import', loader, join(cliRoot, 'scripts/orchestrator-live-engine.ts'), input.cwd, input.engine, String(port), input.prompt]
      : [process.execPath, '--import', loader, join(cliRoot, 'scripts/orchestrator-fixture-engine.ts'), input.cwd, dsh ? 'worker' : 'director', String(port), machineId, join(cliRoot, 'src/cli.ts'), loader],
  })
  if (!result.ok) return result
  if (dsh?.manifest.viewer) track(viewers.start(result.pending.agentId, dsh, input.cwd))
  return { ok: true, session: result.pending }
}
backend.onMessage = (id, text, deliveryId) => {
  const agent = registry.resolve(id)
  if (!agent?.tmuxPane) throw new Error('Fixture director unavailable')
  inputs.push(text)
  if (deliveryId) backend.orchestratorDelivery({ sessionId: id, deliveryId, state: 'queued' })
  track(exec('tmux', ['-S', socket, 'send-keys', '-t', agent.tmuxPane, '-l', Buffer.from(text).toString('base64')])
    .then(() => exec('tmux', ['-S', socket, 'send-keys', '-t', agent.tmuxPane!, 'Enter']))
    .then(() => { if (deliveryId) backend.orchestratorDelivery({ sessionId: id, deliveryId, state: 'delivered' }) }))
}
backend.onCancel = id => {
  const pane = registry.resolve(id)?.tmuxPane
  if (pane) track(exec('tmux', ['-S', socket, 'send-keys', '-t', pane, 'C-c']))
}
async function cleanup(code: number) {
  if (stopped) return
  stopped = true
  if (live) for (const agent of registry.list()) backend.onCancel?.(agent.agentId)
  await local.close(); await backend.stop(); await viewers.stopAll()
  await Promise.allSettled([...pending])
  await exec('tmux', ['-S', socket, 'kill-server']).catch(() => {})
  server.close()
  if (!live && code === 0 && process.env.HARNESS_ORCHESTRATOR_KEEP !== '1') await rm(root, { recursive: true, force: true })
  else console.error(`Fixture files retained at ${root}`)
  process.exit(code)
}
process.stdin.resume(); process.stdin.on('end', () => { void cleanup(0) })
process.on('SIGTERM', () => { void cleanup(0) }); process.on('SIGINT', () => { void cleanup(0) })
process.on('uncaughtException', e => { console.error(e); void cleanup(1) })
process.on('unhandledRejection', e => { console.error(e); void cleanup(1) })
if (live) setTimeout(() => { console.error('Live validation reached its 12-minute limit.'); void cleanup(1) }, 12 * 60_000).unref()
console.log(JSON.stringify({ port, machineId, workspace: join(root, 'workspace'), root }))
