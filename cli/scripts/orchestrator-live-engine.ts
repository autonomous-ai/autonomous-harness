/** Opt-in real-model bridge for the isolated tmux test peer. This is NOT the
 * production interactive launch adapter. It isolates hooks/plugins and gives
 * headless Claude a dollar cap while exercising the real orchestration tools. */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.env.HARNESS_ORCHESTRATOR_LIVE !== '1') throw new Error('Live model usage requires explicit opt-in')
const [cwd, engine, port, initialPrompt] = process.argv.slice(2)
if (!['claude', 'codex'].includes(engine)) throw new Error(`Unsupported live fixture engine: ${engine}`)
process.chdir(cwd)
const log = (text: string) => { appendFileSync(join(cwd, 'LIVE_TEST.log'), `${text}\n`, { mode: 0o600 }); console.log(text) }
let child: ChildProcess | null = null, stopped = false, starting = false, turns = 0
const pending: string[] = []
const history: string[] = []
const event = async (type: string, content = '') => {
  try { await fetch(`http://127.0.0.1:${port}/fixture-event`, { method: 'POST', body: JSON.stringify({ cwd, type, content: content.slice(0, 24_000) }) }) } catch { /* peer shutdown */ }
}
const boundary = 'Live validation only. Work only in this assigned folder. Read ORCHESTRATOR.md or ORCHESTRATOR_TASK.md as requested, and AGENTS.md if present. Do not install software, edit global configuration, call external services besides your model, launch agents except through the orchestrator plan tool, or change any file outside this workspace. Keep the test small and complete explicit checks. Treat dependencies as read-only inputs. The whole project has a maximum of 6 agents and a 12-minute deadline.'

// Sequential headless turns in one persistent tmux worker. Ordinary production
// agents use the existing interactive input coordinator, covered separately.
async function next(): Promise<void> {
  if (stopped || starting || child || pending.length === 0) return
  starting = true
  if (++turns > 4 || !(await fetch(`http://127.0.0.1:${port}/live-turn`, { method: 'POST' })).ok) {
    stopped = true; log('LIVE_TURN_LIMIT'); await event('error', 'The bounded live-test model-turn limit was reached.'); return
  }
  const prompt = pending.shift()!
  history.push(prompt)
  await event('turn_started')
  const args = engine === 'claude'
    ? ['--print', '--verbose', '--output-format', 'stream-json', '--safe-mode', '--permission-mode', 'auto',
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep', '--tools', 'Read,Write,Edit,Bash,Glob,Grep',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
      '--max-budget-usd', '1.00', '--effort', 'low', '--model', 'sonnet',
      '--append-system-prompt', boundary, `${history.join('\n\nFollow-up:\n')}\nInspect current project status before acting; previous work may already be complete.`]
    : ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--approve-for-me', '-C', cwd, '-c', 'model_reasoning_effort="low"',
      // One test process only: the worker CLI must reach the loopback daemon.
      // Keep workspace-write and approval review; never edit global config.
      '-c', 'sandbox_workspace_write.network_access=true',
      `${boundary}\n${history.join('\n\nFollow-up:\n')}`]
  child = spawn(engine, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  starting = false
  const running = child
  let buffer = ''
  running.stdout!.on('data', data => {
    buffer += String(data)
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      try {
        const value = JSON.parse(line)
        const texts = engine === 'claude'
          ? value.type === 'assistant' ? (value.message?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text) : []
          : value.type === 'item.completed' && value.item?.type === 'agent_message' ? [value.item.text] : []
        for (const text of texts) { log(text); void event('text_delta', text) }
        if (value.type === 'result') log(`MODEL_RESULT ${JSON.stringify({ subtype: value.subtype, error: value.is_error, costUsd: value.total_cost_usd, turns: value.num_turns })}`)
        if (value.type === 'error') { log(`MODEL_ERROR ${JSON.stringify(value)}`); void event('error', value.message ?? 'Model error') }
      } catch { if (line.trim()) log(line.slice(0, 1000)) }
    }
  })
  running.stderr!.on('data', data => log(`stderr: ${String(data).slice(0, 2000)}`))
  running.on('error', error => { log(`PROCESS_ERROR ${error.message}`); void event('error', error.message) })
  running.on('close', code => {
    log(`MODEL_EXIT ${code}`)
    if (code !== 0) void event('error', `Live ${engine} process exited with code ${code}. Inspect LIVE_TEST.log; no automatic retry.`)
    child = null
    void event('turn_ended').then(() => next())
  })
}
createInterface({ input: process.stdin }).on('line', line => {
  if (stopped) return
  pending.push(Buffer.from(line.trim(), 'base64').toString('utf8'))
  void next()
})
process.on('SIGINT', () => { stopped = true; pending.length = 0; child?.kill('SIGTERM'); log('LIVE_TURN_CANCELLED') })
process.on('SIGTERM', () => { stopped = true; child?.kill('SIGTERM'); process.exit(0) })
setInterval(() => {}, 1000)
setTimeout(() => { pending.push(initialPrompt); void next() }, 500)
