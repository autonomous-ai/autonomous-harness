// Does the daemon label a pane it did NOT create, from HARNESS_DSH alone? Polls agents_list.
import ws_ from '../../cli/node_modules/ws/index.js'
const { WebSocket } = ws_
import { randomBytes } from 'node:crypto'
const [machineId, workspace, action] = process.argv.slice(2)
const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
const pending = new Map()
const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))
const request = (type, payload = {}) => new Promise((resolve, reject) => {
  const requestId = randomBytes(8).toString('hex')
  const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 20000)
  pending.set(requestId, (p) => { clearTimeout(timer); resolve(p) })
  send(type, { requestId, ...payload })
})
ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString())
  if (f.type?.endsWith('_result') && pending.has(f.payload?.requestId)) { pending.get(f.payload.requestId)(f.payload); pending.delete(f.payload.requestId) }
})
ws.on('open', async () => {
  send('machine_select', { machineId, localProtocolVersion: 1 })
  await new Promise((r) => setTimeout(r, 300))
  const deadline = Date.now() + 40000
  let hit = null
  while (Date.now() < deadline) {
    const list = await request('agents_list')
    hit = (list.agents ?? []).find((a) => a.project?.directory === workspace || a.project?.cwd === workspace || JSON.stringify(a).includes(workspace))
    if (hit && (action === 'find' ? hit.dsh && hit.viewerUrl : true)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(hit ? JSON.stringify({ id: hit.id, engine: hit.engine, dsh: hit.dsh, dshName: hit.dshName, viewerUrl: hit.viewerUrl, verdict: hit.verdict, launch: hit.launch, tmuxPane: hit.tmuxPane }) : 'NOT FOUND')
  if (hit && action === 'delete') { send('agent_delete', { agentId: hit.id }); await new Promise((r) => setTimeout(r, 3000)); console.log('deleted') }
  ws.close(); process.exit(hit ? 0 : 1)
})
