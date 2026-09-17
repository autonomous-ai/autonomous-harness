// Daemon-level end-to-end check for a DSH agent, over the same loopback WebSocket the desktop uses.
// Usage: node dsh-e2e.mjs <machineId> <dshId> <engine> <workspace> [--keep]
import ws_ from '../../cli/node_modules/ws/index.js'
const { WebSocket } = ws_
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const [machineId, dshId, engine, workspace] = process.argv.slice(2)
const keep = process.argv.includes('--keep')
if (!machineId || !dshId || !engine || !workspace) {
  console.error('usage: node dsh-e2e.mjs <machineId> <dshId> <engine> <workspace> [--keep]')
  process.exit(2)
}

const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
const pending = new Map()
const agentFrames = []
let agentId = null

const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))
const request = (type, payload, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  const requestId = randomBytes(8).toString('hex')
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out`)) }, timeoutMs)
  pending.set(requestId, (p) => { clearTimeout(timer); resolve(p) })
  send(type, { requestId, ...payload })
})
const waitFor = (label, predicate, timeoutMs) => new Promise((resolve, reject) => {
  const started = Date.now()
  const tick = () => {
    const hit = agentFrames.find(predicate)
    if (hit) return resolve(hit)
    if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
    setTimeout(tick, 250)
  }
  tick()
})
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

ws.on('message', (raw) => {
  let frame
  try { frame = JSON.parse(raw.toString()) } catch { return }
  const { type, payload } = frame
  if (type?.endsWith('_result') && payload?.requestId && pending.has(payload.requestId)) {
    pending.get(payload.requestId)(payload); pending.delete(payload.requestId); return
  }
  if (type === 'agent_synced' && payload?.agent) {
    const a = payload.agent
    if (agentId && a.id !== agentId) return
    agentFrames.push(a)
    log(`agent_synced · ${a.id.slice(0, 8)} · engine=${a.engine} dsh=${a.dsh} dshName=${a.dshName} launch=${a.launch?.state} viewerUrl=${a.viewerUrl} verdict=${a.verdict ? JSON.stringify(a.verdict) : null}`)
  }
})

ws.on('open', async () => {
  try {
    send('machine_select', { machineId, localProtocolVersion: 1 })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no connected frame')), 5000)
      ws.once('message', (raw) => { clearTimeout(t); const f = JSON.parse(raw.toString()); log('handshake:', f.type, JSON.stringify(f.payload)); f.type === 'connected' ? resolve() : reject(new Error(`handshake ${f.type}`)) })
    })

    const list = await request('dsh_list', {})
    log('dsh_list:', JSON.stringify(list.dsh))
    const entry = (list.dsh ?? []).find((d) => d.id === dshId)
    if (!entry?.installed) throw new Error(`${dshId} not installed on this machine`)

    const creationId = randomBytes(12).toString('hex')
    const created = await request('agent_create', { engine, cwd: workspace, dsh: dshId, creationId, bypassPermission: process.argv.includes('--bypass') }, 60_000)
    log('agent_create_result:', JSON.stringify({ state: created.state, error: created.error, failure: created.failure, agent: created.agent && { id: created.agent.id, dsh: created.agent.dsh, dshName: created.agent.dshName, viewerUrl: created.agent.viewerUrl, launch: created.agent.launch } }))
    if (created.state !== 'created') throw new Error('create did not succeed')
    agentId = created.agent.id
    agentFrames.push(created.agent)

    const withViewer = await waitFor('viewerUrl', (a) => a.id === agentId && a.viewerUrl, 90_000)
    log('viewer url:', withViewer.viewerUrl)
    const status = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{content_type}', withViewer.viewerUrl]).toString()
    log('viewer GET /:', status)

    const ready = await waitFor('launch ready', (a) => a.id === agentId && a.launch?.state === 'ready', 120_000)
    log('launch ready; pane:', ready.tmuxPane)
    // The engine process must carry the DSH marker in its environment.
    const env = execFileSync('sh', ['-c', `ps eww -o command= -p $(tmux list-panes -a -F '#{pane_id} #{pane_pid}' | awk -v p='${ready.tmuxPane}' '$1==p{print $2}') | tr ' ' '\\n' | grep -E '^HARNESS_(DSH|WORKSPACE)=' | sort -u`]).toString().trim()
    log('pane shell env:', env.replace(/\n/g, ' · ') || '(none on the shell; engine child may hold it)')

    if (process.argv.includes('--restart')) {
      log('restarting agent in place')
      const restarted = await request('agent_restart', { agentId }, 120_000)
      log('agent_restart_result:', JSON.stringify({ error: restarted.error, resumed: restarted.resumed, agent: restarted.agent && { dsh: restarted.agent.dsh, viewerUrl: restarted.agent.viewerUrl, launch: restarted.agent.launch } }))
      if (restarted.error) throw new Error(`restart failed: ${restarted.error}`)
      await new Promise((r) => setTimeout(r, 2500))
      const env2 = execFileSync('sh', ['-c', `ps eww -o command= -p $(tmux list-panes -a -F '#{pane_id} #{pane_pid}' | awk -v p='${ready.tmuxPane}' '$1==p{print $2}') | tr ' ' '\\n' | grep -E '^HARNESS_(DSH|WORKSPACE)=' | sort -u`]).toString().trim()
      log('pane shell env after restart:', env2.replace(/\n/g, ' · ') || '(none)')
      if (!env2.includes('HARNESS_DSH=')) throw new Error('HARNESS_DSH lost on restart')
      const latest = agentFrames.filter((a) => a.id === agentId).at(-1)
      log('latest frame after restart:', JSON.stringify({ dsh: latest?.dsh, viewerUrl: latest?.viewerUrl, launch: latest?.launch }))
    }
    if (process.argv.includes('--no-verdict')) {
      if (!keep) { log('deleting agent'); send('agent_delete', { agentId }); await new Promise((r) => setTimeout(r, 4000)) }
      log('done'); ws.close(); process.exit(0)
    }

    console.log('\nNow run the DSH pipeline in the workspace to produce a verdict; waiting up to 15 minutes for a verdict frame…')
    const withVerdict = await waitFor('verdict', (a) => a.id === agentId && a.verdict, 15 * 60_000)
    log('verdict:', JSON.stringify(withVerdict.verdict))

    if (!keep) {
      log('deleting agent')
      send('agent_delete', { agentId })
      await new Promise((r) => setTimeout(r, 4000))
    }
    log('done')
    ws.close()
    process.exit(0)
  } catch (error) {
    log('FAILED:', error.message)
    ws.close()
    process.exit(1)
  }
})
ws.on('error', (e) => { log('ws error', e.message); process.exit(1) })
