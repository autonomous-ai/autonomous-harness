// Delete an agent over the daemon's loopback WebSocket. Usage: node dsh-delete.mjs <agentId>
import ws_ from '../../cli/node_modules/ws/index.js'
const { WebSocket } = ws_
const [agentId] = process.argv.slice(2)
const machineId = process.argv[3] ?? (() => { console.error('usage: node dsh-delete.mjs <agentId> <machineId>'); process.exit(2) })()
const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
  ws.once('message', (raw) => {
    const f = JSON.parse(raw.toString()); console.log('handshake', f.type)
    ws.send(JSON.stringify({ type: 'agent_delete', payload: { agentId } }))
    setTimeout(() => { ws.close(); process.exit(0) }, 4000)
  })
})
ws.on('message', (raw) => { const f = JSON.parse(raw.toString()); if (f.type === 'agent_deleted' || f.type === 'agent_delete_result') console.log(f.type, JSON.stringify(f.payload).slice(0, 120)) })
ws.on('error', (e) => { console.error(e.message); process.exit(1) })
