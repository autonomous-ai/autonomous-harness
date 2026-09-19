import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'

export function localOrchestratorRequest(port: number, machineId: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(16).toString('hex')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/local-ws`)
    let settled = false
    const finish = (error?: Error, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('The daemon did not confirm this operation. Check status before retrying.')), timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } })))
    ws.on('error', error => finish(error))
    ws.on('close', () => finish(new Error('The local daemon disconnected. Check status before retrying.')))
    ws.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'connected') ws.send(JSON.stringify({ type: 'orchestrator', payload: { ...payload, requestId } }))
        if (frame.type === 'orchestrator_result' && frame.payload?.requestId === requestId) finish(undefined, frame.payload)
      } catch { finish(new Error('The local daemon returned an invalid response.')) }
    })
  })
}

export function parseOrchestratorArgs(argv: readonly string[]): { port: number; machineId: string; payload: Record<string, unknown> } {
  const args: string[] = []
  let port = env.PORT, machineId = readAuthSession()?.machineId ?? ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i])
    else if (argv[i] === '--machine') machineId = argv[++i] ?? ''
    else args.push(argv[i])
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !machineId) throw new Error('A running local daemon and machine identity are required (--port, --machine).')
  const [action, id, ...rest] = args
  const payload: Record<string, unknown> = { action, id }
  switch (action) {
    case 'list': case 'catalog': case 'status': case 'resume': break
    case 'plan': payload.tasks = JSON.parse(rest[0] ?? 'null'); break
    case 'retry': case 'cancel': if (rest[0]) payload.taskId = rest[0]; break
    case 'finish': case 'fail':
      Object.assign(payload, { taskId: rest[0], attempt: Number(rest[1]), summary: rest[2], artifacts: rest.slice(3) }); break
    case 'complete': payload.summary = rest[0]; break
    case 'message': Object.assign(payload, { text: rest[0], messageId: rest[1] ?? randomBytes(16).toString('hex') }); break
    case 'steer': Object.assign(payload, { taskId: rest[0], attempt: Number(rest[1]), text: rest[2], messageId: rest[3] ?? randomBytes(16).toString('hex') }); break
    default: throw new Error('Usage: harness orchestrator [--port N --machine ID] list|catalog|status|plan|finish|fail|retry|cancel|resume|complete|message|steer [project-id] [arguments]')
  }
  return { port, machineId, payload }
}
export async function orchestratorCommand(argv: readonly string[]): Promise<number> {
  try {
    const { port, machineId, payload } = parseOrchestratorArgs(argv)
    const reply = await localOrchestratorRequest(port, machineId, payload)
    console.log(JSON.stringify(summarizeOrchestratorReply(reply), null, 2))
    return reply.error ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Orchestrator request failed.')
    return 1
  }
}

/** Tool output is a work ledger, not a repeated copy of the director's whole
 * conversation and every specialist brief. The UI still receives full state. */
export function summarizeOrchestratorReply(reply: Record<string, unknown>): Record<string, unknown> {
  if (!reply.project || typeof reply.project !== 'object' || Array.isArray(reply.project)) return reply
  const { fingerprint: _fingerprint, messages, tasks, ...project } = reply.project as Record<string, unknown>
  return { ...reply, project: {
    ...project,
    tasks: Array.isArray(tasks) ? tasks.map(({ prompt: _prompt, ...task }) => task) : [],
    deliveries: Array.isArray(messages) ? messages.filter(m => m.delivery).slice(-20).map(m => ({
      id: m.id, targetAgentId: m.targetAgentId, delivery: m.delivery,
      deliveryReason: m.deliveryReason, text: String(m.text).slice(0, 160),
    })) : [],
  } }
}
