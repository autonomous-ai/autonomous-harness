import { WebSocketServer, WebSocket } from 'ws'

const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (ws) => {
  console.log('server: connection established')
  ws.on('message', (raw) => {
    console.log('server got:', raw.toString())
  })
})
wss.on('listening', () => console.log('server listening'))

setTimeout(() => {
  const port = wss.address().port
  console.log('port', port)
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/web-ws?autonomousEnv=prod`, ['tok'])
  client.on('open', () => { console.log('client open'); client.send(JSON.stringify({type:'machine_select'})) })
  client.on('close', (code, reason) => console.log('client close', code, reason.toString()))
  client.on('error', (e) => console.log('client error', e))
}, 100)
