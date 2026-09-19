/** Explicitly opt-in paid/account-backed smoke test. Does not touch the user's daemon. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFile, readFile } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { join } from 'node:path'
import { localOrchestratorRequest } from '../src/orchestrator/command.js'

if (process.env.HARNESS_ORCHESTRATOR_LIVE !== '1') throw new Error('This test uses model accounts. Set HARNESS_ORCHESTRATOR_LIVE=1 only with permission.')
const peer = spawn(process.execPath, ['--import', 'tsx', 'scripts/orchestrator-e2e-peer.ts'], { stdio: ['pipe', 'pipe', 'inherit'] })
const config = await new Promise<{ port: number; machineId: string; root: string; workspace: string }>((resolve, reject) => {
  const lines = createInterface({ input: peer.stdout })
  const timer = setTimeout(() => reject(new Error('Live peer startup timed out')), 30_000)
  lines.on('line', line => {
    try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); resolve(value) } else console.log(line) } catch { console.log(line) }
  })
  peer.once('exit', code => { clearTimeout(timer); reject(new Error(`Live peer exited: ${code}`)) })
})
console.log(`LIVE_WORKSPACE ${config.root}`)
const request = (payload: Record<string, unknown>) => localOrchestratorRequest(config.port, config.machineId, payload, 60_000)
const id = randomBytes(16).toString('hex')
const cadFit = process.env.HARNESS_ORCHESTRATOR_LIVE_SCENARIO === 'cad-fit'
let project: any, previous = ''
const checks: Record<string, boolean> = {}
const started = Date.now()
try {
  const reply = await request({ action: 'start', id, engine: cadFit ? 'codex' : 'claude', cwd: config.workspace, parallelism: 2, bypassPermission: false,
    prompt: cadFit ? `Build a SMALL real two-harness mechanical-fit project using autonomous/solid then autonomous/autonomous-workshop. Both use the installed Codex account. Delegate exactly TWO tasks and inspect the checks before completing.
Solid: create a circular desk token 24 mm diameter and 5 mm thick with a 4 mm through-hole offset 6 mm from center. Output model.step, model.stl, dimensions.json (units mm, positive volume_mm3, bounds_mm) and source. Use the actual installed CAD tools, not fake STEP/STL.
Autonomous Workshop: consume that exact pinned model.step and dimensions.json. Design a simple circular holder with 32 mm outer diameter, a 24.6 mm diameter recess, 2 mm base and 5 mm recess depth. Place the imported token in the recess with 0.3 mm radial clearance. Do not redraw the upstream token. Output model.step containing the holder and actual imported token as an assembly, model.stl, fit.json reporting solids, dimensions, radial_clearance_mm, units and explicit geometric validity checks, plus source. The holder must not intersect the token; verify intersection volume is zero (within numerical tolerance) and both solids have positive volume.
Keep source and outputs in each assigned folder. Each worker must call the exact finish command with deliverables after checks pass. No installation, downloads, video or rendering. No extra tasks and no automatic retry if blocked: explain the obstacle. Finish the whole project explicitly when both real harness tasks succeed.` : `Build a SMALL real CAD-to-studio-render project with the installed Solid and Blender harnesses. You are the director; delegate creation, then inspect and complete.
Design a simple circular desk token: 24 mm diameter, 5 mm thick, one 4 mm through-hole offset 6 mm from its center. The CAD worker must create model.step, model.stl and dimensions.json with positive volume_mm3, bounds_mm and units "mm", plus its source and checks. Use the actual Solid harness and its installed tools, not a hand-written fake file.
The dependent Blender worker must import that exact pinned STL (do not redraw the token), explicitly convert millimeters to meters, give it a warm coral material, and create one small 512x512 studio render render.png and scene.glb, plus validation.json describing the source input, scale, geometry checks and image. Use installed bpy only and a cheap render (at most 16 samples). No video, installation or downloads.
Use only TWO specialist tasks: Solid (Codex) followed by Blender (Claude). Do not use a generic engine instead of the installed harnesses. Each worker must report finish with all deliverable paths. Do not retry automatically or create extra tasks if blocked: explain the obstacle. Inspect final artifacts and complete only after acceptance checks pass. Keep this a bounded smoke test, not a production design.` })
  if (reply.error) throw new Error(JSON.stringify(reply))
  project = reply.project
  console.log(`LIVE_PROJECT ${id}`)
  while (Date.now() - started < 11 * 60_000) {
    const reply = await request({ action: 'status', id })
    if (reply.error) throw new Error(JSON.stringify(reply))
    project = reply.project
    const status = `${project.state}: ${project.tasks.map((t: any) => `${t.id}=${t.state}`).join(', ')}`
    if (status !== previous) { console.log(status); previous = status }
    if (project.error && !project.directorWorking) { console.error(`LIVE_DIRECTOR_ERROR ${project.error}`); break }
    if (!project.directorWorking && project.tasks.length === 0 && Date.now() - started > 15_000) {
      console.error('LIVE_NO_PLAN: director ended without delegating. Inspect its transcript; no blind retry.'); break
    }
    if (['completed', 'failed', 'cancelled'].includes(project.state) || project.tasks.some((t: any) => ['failed', 'blocked'].includes(t.state))) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  checks.directorCompleted = project.state === 'completed'
  const cad = project.tasks.find((t: any) => t.harness === 'autonomous/solid')
  const scene = project.tasks.find((t: any) => t.harness === (cadFit ? 'autonomous/autonomous-workshop' : 'autonomous/blender'))
  checks.realHarnessDag = Boolean(cad?.state === 'succeeded' && scene?.state === 'succeeded' && scene.dependsOn.includes(cad.id))
  if (cad && scene) {
    const step = await readFile(join(cad.cwd, 'model.step')).catch(() => Buffer.alloc(0))
    const stl = await readFile(join(cad.cwd, 'model.stl')).catch(() => Buffer.alloc(0))
    const pinned = await readFile(join(scene.cwd, 'inputs', cad.id, 'model.stl')).catch(() => Buffer.alloc(0))
    const png = await readFile(join(scene.cwd, 'render.png')).catch(() => Buffer.alloc(0))
    const glb = await readFile(join(scene.cwd, 'scene.glb')).catch(() => Buffer.alloc(0))
    checks.stepHeader = step.subarray(0, 100).toString().includes('ISO-10303-21')
    checks.pinnedMesh = stl.length > 84 && stl.equals(pinned)
    checks.meshReceiptHash = cad.artifacts.some((a: any) => a.path === 'model.stl' && a.sha256 === createHash('sha256').update(stl).digest('hex'))
    if (cadFit) {
      const assembly = await readFile(join(scene.cwd, 'model.step')).catch(() => Buffer.alloc(0))
      const fit = JSON.parse(await readFile(join(scene.cwd, 'fit.json'), 'utf8').catch(() => '{}'))
      checks.assemblyHeader = assembly.subarray(0, 100).toString().includes('ISO-10303-21')
      checks.clearanceReport = Math.abs(Number(fit.radial_clearance_mm) - 0.3) < 1e-6
    } else {
      checks.pngDimensions = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(16) === 512 && png.readUInt32BE(20) === 512
      checks.glbHeader = glb.length > 12 && glb.subarray(0, 4).toString() === 'glTF' && glb.readUInt32LE(4) === 2 && glb.readUInt32LE(8) === glb.length
    }
  }
  console.log(`LIVE_CHECKS ${JSON.stringify(checks)}`)
  if (Object.values(checks).some(value => !value)) process.exitCode = 1
} catch (error) {
  console.error(error); process.exitCode = 1
} finally {
  if (project && !['completed', 'failed', 'cancelled'].includes(project.state)) await request({ action: 'cancel', id }).catch(() => {})
  await writeFile(join(config.root, 'live-result.json'), JSON.stringify({ id, scenario: cadFit ? 'cad-fit' : 'cad-blender', started, durationMs: Date.now() - started, checks, project }, null, 2), { mode: 0o600 })
  peer.stdin.end()
  await new Promise<void>(resolve => { if (peer.exitCode !== null) resolve(); else peer.once('exit', () => resolve()) })
}
