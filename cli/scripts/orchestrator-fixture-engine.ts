/** Deterministic model substitute. Real tmux, real CLI tools, no model billing. */
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const [cwd, role, port, machine, cli, loader] = process.argv.slice(2)
process.chdir(cwd)
const brief = await readFile(join(cwd, role === 'director' ? 'ORCHESTRATOR.md' : 'ORCHESTRATOR_TASK.md'), 'utf8')
const projectId = role === 'director' ? /Project id: ([a-f0-9]{32})/.exec(brief)![1] : /project ([a-f0-9]{32}), task/.exec(brief)![1]
const tool = async (action: string, ...args: string[]) => {
  const result = await exec(process.execPath, ['--import', loader, cli, 'orchestrator', '--port', port, '--machine', machine, action, projectId, ...args], { env: process.env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  const reply = JSON.parse(result.stdout)
  if (reply.error) throw new Error(reply.detail ?? reply.error)
  return reply
}
const event = async (type: string, content = '') => {
  await fetch(`http://127.0.0.1:${port}/fixture-event`, { method: 'POST', body: JSON.stringify({ cwd, type, content }) })
}
let stopped = false
process.on('SIGINT', () => { stopped = true; console.log('FIXTURE_TURN_CANCELLED') })
setInterval(() => {}, 1000)
if (role === 'director') {
  // This is the only substitute: a known plan stands in for model inference.
  await new Promise(resolve => setTimeout(resolve, 300))
  await event('turn_started')
  await event('text_delta', 'I’m combining shape, research, scene, and film specialists.')
  const tasks = [
    { id: 'shape', title: 'Shape', harness: 'fixture/shape', prompt: 'Build a verified shape fixture', dependsOn: [] },
    { id: 'research', title: 'Research', harness: 'fixture/research', prompt: 'Write product context', dependsOn: [] },
    { id: 'scene', title: 'Scene', harness: 'fixture/scene', prompt: 'Combine geometry and product context', dependsOn: ['shape', 'research'] },
    { id: 'film', title: 'Film', harness: 'fixture/film', prompt: 'Make a launch sequence from the scene', dependsOn: ['scene'] },
  ]
  await tool('plan', JSON.stringify(tasks))
  await event('turn_ended')
  let chain = Promise.resolve()
  createInterface({ input: process.stdin }).on('line', line => {
    chain = chain.then(async () => {
      if (stopped) return
      const text = Buffer.from(line.trim(), 'base64').toString('utf8')
      await event('turn_started')
      const reply = await tool('status')
      if (reply.project.tasks.every((t: { state: string }) => t.state === 'succeeded') && reply.project.state === 'active') {
        await tool('complete', 'All four fixture specialists finished and their exact artifact versions were handed off.')
      }
      await event('text_delta', text.startsWith('[Orchestrator update]') ? 'A specialist result arrived and I checked project status.' : `Received your direction: ${text}`)
      await event('turn_ended')
    }).catch(error => console.error(error))
  })
} else {
  const match = /task ([a-z0-9-]+), attempt (\d+)/.exec(brief)!
  const [, taskId, attempt] = match
  await new Promise(resolve => setTimeout(resolve, 1200))
  if (!stopped) {
    const inputs = taskId === 'scene' ? ['shape', 'research'] : taskId === 'film' ? ['scene'] : []
    const consumed = await Promise.all(inputs.map(id => readFile(join(cwd, 'inputs', id, 'deliverable.txt'), 'utf8')))
    const result = `Verified ${taskId} fixture\n${consumed.join('\n')}`
    await writeFile(join(cwd, 'deliverable.txt'), result)
    await tool('finish', taskId, attempt, `${taskId} checks passed; consumed ${inputs.join(', ') || 'no upstream files'}`, 'deliverable.txt')
  }
}
