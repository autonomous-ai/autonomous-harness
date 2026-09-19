// Proofs: a fresh engine agent that knows only the harness's own AGENTS.md and skills turns a real
// prompt into a result in a workspace laid out exactly as Harness lays it out, with the harness's
// viewer running and photographed as the work lands.
//
// `proof run` starts a detached runner and returns at once — a proof takes minutes and an agent's shell
// call does not — and `proof wait` follows it. The runner owns the agent and the frames; the viewer is
// left running afterwards so Builder Studio can keep showing it live.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { launchEnv, materialize, readManifest, skillsDirFor } from './materialize.mjs'
import { log, paths, readBuild, readJson, saveBuild, writeJsonAtomic } from './state.mjs'
import { openBrowser, snapshot } from './snapshot.mjs'
import { alive, currentArtifact, resolveViewer, startViewer, stopViewer, viewerUrl } from './viewer.mjs'

export const ENGINE_COMMANDS = {
  // Only the project's settings: the proof must not borrow this machine's personal instructions or
  // skills, or it proves the machine rather than the harness.
  claude: (prompt) => ['claude', ['-p', prompt, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local']],
  // Codex's automatic review inside the workspace-write sandbox, with network allowed: a harness's
  // toolchain may fetch (a package index, map tiles) while it works.
  codex: (prompt) => ['codex', ['exec', '--approve-for-me', '--skip-git-repo-check', '--json', '-c', 'sandbox_workspace_write.network_access=true', prompt]],
}

export function proofDir(workspace, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error(`proof id "${id}" must be lower case letters, digits and dashes`)
  return join(paths(workspace).proofs, id)
}

/** The environment a proof agent runs in: the machine's, without the Builder's own context. */
export function agentEnv(base, manifest, pkg, workspace) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|BUILDER|HARNESS_)/.test(key)) continue
    env[key] = value
  }
  return { ...env, ...launchEnv(manifest, pkg, workspace) }
}

/** A workspace fingerprint that changes when the agent saves something a viewer could show. */
export function fingerprint(workspace) {
  let count = 0
  let sum = 0
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (['.harness', '.claude', '.agents', 'node_modules', '.git', '.venv'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue }
      try { const s = statSync(p); count++; sum += Math.round(s.mtimeMs) + s.size } catch { /* raced */ }
    }
  }
  walk(workspace, 0)
  return `${count}:${sum}`
}

/** Lay out the workspace and start the viewer. Reuses a running viewer for the same workspace. */
export async function openProof(workspace, id, { engine, reset = false } = {}) {
  const p = paths(workspace)
  const dir = proofDir(workspace, id)
  const ws = join(dir, 'workspace')
  const build = readBuild(workspace)
  const existing = build.proofs[id]
  if (reset) {
    if (existing?.viewer?.pid) stopViewer(existing.viewer.pid)
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  const manifest = readManifest(p.package)
  const base = engine ?? manifest.engine ?? 'claude'
  const materialized = materialize(p.package, ws, { engine: base })
  writeJsonAtomic(join(dir, 'materialize.json'), materialized)

  let viewer = existing?.viewer && !reset && alive(existing.viewer.pid) ? existing.viewer : null
  if (!viewer) {
    const started = await startViewer(p.package, ws, { logFile: join(dir, 'viewer.log') })
    viewer = started.error ? { error: started.error } : started
  }
  const next = readBuild(workspace)
  next.proofs[id] = { ...(reset ? {} : next.proofs[id]), id, engine: base, workspace: relative(workspace, ws), viewer, state: next.proofs[id]?.state && !reset ? next.proofs[id].state : 'open', updatedAt: new Date().toISOString() }
  log(next, `Proof ${id}: workspace ready${viewer.error ? ` (viewer: ${viewer.error})` : ` · viewer on port ${viewer.port}`}`)
  saveBuild(workspace, next)
  return { dir, workspace: ws, viewer, materialized }
}

/** `proof run`: a fresh workspace, the viewer, and a detached runner for the agent. */
/**
 * What the harness was when a proof started. A proof is only evidence about ONE harness: editing
 * `package/` while an agent works on it proves a mixture that never existed — and a module saved
 * half-written takes the run down with it. The runner compares this at the end and calls a changed
 * run void rather than letting its result stand.
 */
export function packageFingerprint(pkg) {
  let count = 0
  let sum = 0
  const walk = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (['node_modules', '.playwright', '.venv', '.conda', 'vendor', 'upstream', '.git', '__pycache__', 'showcase'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue }
      try { const s = statSync(p); count++; sum += Math.round(s.mtimeMs) + s.size } catch { /* raced */ }
    }
  }
  walk(pkg, 0)
  return `${count}:${sum}`
}

export async function startProof(workspace, id, prompt, { engine, every = 15, timeoutMinutes = 45, builderScript }) {
  if (!prompt?.trim()) throw new Error('a proof needs --prompt "…"')
  const opened = await openProof(workspace, id, { engine, reset: true })
  const build = readBuild(workspace)
  const base = build.proofs[id].engine
  if (!ENGINE_COMMANDS[base]) throw new Error(`no proof runner for engine "${base}" yet; use claude or codex`)
  build.proofs[id] = {
    ...build.proofs[id],
    prompt: prompt.trim(),
    state: 'running',
    startedAt: new Date().toISOString(),
    every,
    timeoutMinutes,
    packageAt: packageFingerprint(paths(workspace).package),
  }
  log(build, `Proof ${id}: a fresh ${base} agent started`)
  saveBuild(workspace, build)
  const runner = spawn(process.execPath, [builderScript, 'proof', '_runner', id], {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, HARNESS_WORKSPACE: workspace },
  })
  runner.unref()
  const next = readBuild(workspace)
  next.proofs[id].runnerPid = runner.pid
  saveBuild(workspace, next)
  return { ...opened, runnerPid: runner.pid }
}

function summarizeEvent(event) {
  if (event.type === 'assistant') {
    const parts = []
    for (const c of event.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) parts.push({ kind: 'text', text: c.text.trim().slice(0, 400) })
      if (c.type === 'tool_use') {
        const input = c.input ?? {}
        const what = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? ''
        parts.push({ kind: 'tool', tool: c.name, detail: String(what).slice(0, 200) })
      }
    }
    return parts
  }
  if (event.type === 'result') return [{ kind: 'result', text: String(event.result ?? '').slice(0, 2000), isError: event.is_error, turns: event.num_turns, costUsd: event.total_cost_usd, ms: event.duration_ms }]
  // codex exec --json: items (messages, commands, file changes) and a usage line per turn.
  if (event.type === 'item.completed') {
    const item = event.item ?? {}
    if (item.type === 'agent_message' && item.text) return [{ kind: 'text', text: String(item.text).slice(0, 2000) }]
    if (item.type === 'command_execution') return [{ kind: 'tool', tool: 'shell', detail: String(item.command ?? '').slice(0, 200) }]
    if (item.type === 'file_change') return [{ kind: 'tool', tool: 'edit', detail: (item.changes ?? []).map((c) => c.path?.split('/').slice(-2).join('/')).join(', ').slice(0, 200) }]
    return []
  }
  if (event.type === 'turn.completed') return [{ kind: 'usage', usage: event.usage }]
  return []
}

/** The detached runner: the agent, the frames, the result. */
export async function runProof(workspace, id) {
  const p = paths(workspace)
  const dir = proofDir(workspace, id)
  const build = readBuild(workspace)
  const proof = build.proofs[id]
  const ws = join(workspace, proof.workspace)
  const manifest = readManifest(p.package)
  const [bin, args] = ENGINE_COMMANDS[proof.engine](proof.prompt)
  const framesDir = join(dir, 'frames')
  mkdirSync(framesDir, { recursive: true })
  const agentLog = join(dir, 'agent.log')
  writeFileSync(agentLog, '')
  const activity = []
  const frames = []
  const started = Date.now()
  let finalMessage = null
  let usage = null

  const child = spawn(bin, args, { cwd: ws, env: agentEnv(process.env, manifest, p.package, ws), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  // The agent has a process group of its own, so stopping this runner would leave it working — and
  // spending — with nobody watching. `proof stop` needs its pid, and a runner told to stop takes the
  // agent down with it.
  {
    const started = readBuild(workspace)
    if (started.proofs[id]) { started.proofs[id].agentPid = child.pid; saveBuild(workspace, started) }
  }
  const stopAgent = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { stopAgent(); process.exit(143) })
  let buffer = ''
  const onData = (chunk) => {
    const text = chunk.toString()
    appendFileSync(agentLog, text)
    buffer += text
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        for (const item of summarizeEvent(JSON.parse(line))) {
          if (item.kind === 'usage') { usage = item.usage; continue }
          activity.push({ at: Math.round((Date.now() - started) / 1000), ...item })
          // Claude Code ends with a result event; Codex's last agent message is its answer.
          if (item.kind === 'result' || (item.kind === 'text' && proof.engine === 'codex')) finalMessage = item
        }
        if (activity.length > 200) activity.splice(0, activity.length - 200)
      } catch { /* a non-JSON line */ }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', (chunk) => appendFileSync(agentLog, chunk.toString()))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

  let browser = null
  try { browser = await openBrowser() } catch (error) { appendFileSync(join(dir, 'viewer.log'), `[builder] no browser for frames: ${error.message}\n`) }
  const resolved = resolveViewer(p.package)
  const takeFrame = async (label) => {
    if (!browser || !proof.viewer?.port) return
    const artifact = currentArtifact(ws, resolved?.artifactExtensions ?? [])
    const url = viewerUrl(proof.viewer.urlTemplate ?? proof.viewer.url, proof.viewer.port, artifact)
    const n = String(frames.length + 1).padStart(3, '0')
    const out = join(framesDir, `${n}.png`)
    try {
      const shot = await snapshot(url, out, { browser, width: 1600, height: 1000, settleMs: 1500 })
      const verdict = readJson(join(ws, '.harness', 'verdict.json'), null)
      frames.push({ n: frames.length + 1, at: Math.round((Date.now() - started) / 1000), file: relative(workspace, out), label, verdict: verdict ? { ready: verdict.ready, summary: verdict.summary, phases: verdict.phases } : null, consoleErrors: shot.consoleErrors.slice(0, 5) })
    } catch (error) {
      frames.push({ n: frames.length + 1, at: Math.round((Date.now() - started) / 1000), error: String(error.message ?? error).slice(0, 300), label })
    }
  }
  const writeProgress = () => {
    writeJsonAtomic(join(dir, 'activity.json'), { running: true, seconds: Math.round((Date.now() - started) / 1000), activity: activity.slice(-40), frames })
  }

  await takeFrame('start')
  let last = fingerprint(ws)
  let done = null
  const deadline = started + proof.timeoutMinutes * 60_000
  while (!done) {
    const tick = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), (proof.every ?? 15) * 1000))])
    if (tick) { done = tick; break }
    const now = fingerprint(ws)
    if (now !== last && frames.length < 120) { last = now; await takeFrame('work') }
    writeProgress()
    if (Date.now() > deadline) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      done = { code: null, signal: 'timeout' }
    }
  }
  await new Promise((r) => setTimeout(r, 4000))
  await takeFrame('final')
  if (browser) {
    try {
      const final = frames.at(-1)
      if (final?.file) {
        const artifact = currentArtifact(ws, resolved?.artifactExtensions ?? [])
        await snapshot(viewerUrl(proof.viewer.urlTemplate ?? proof.viewer.url, proof.viewer.port, artifact), join(dir, 'viewer.png'), { browser, settleMs: 3000 })
      }
    } catch { /* the frame list still has the last picture */ }
    await browser.close().catch(() => {})
  }

  const verdict = readJson(join(ws, '.harness', 'verdict.json'), null)
  // The harness must be the same one the agent started with, or this run is not evidence about it.
  const packageNow = packageFingerprint(paths(workspace).package)
  const packageChanged = Boolean(proof.packageAt) && packageNow !== proof.packageAt
  const result = {
    id,
    prompt: proof.prompt,
    engine: proof.engine,
    packageChanged,
    exit: done.code,
    signal: done.signal,
    timedOut: done.signal === 'timeout',
    seconds: Math.round((Date.now() - started) / 1000),
    firstFrameWithContentAt: frames.find((f, i) => i > 0 && !f.error)?.at ?? null,
    verdict,
    finalMessage,
    usage,
    frames,
    skillsLinked: existsSync(join(ws, skillsDirFor(proof.engine))) ? readdirSync(join(ws, skillsDirFor(proof.engine))) : [],
  }
  writeJsonAtomic(join(dir, 'result.json'), result)
  writeJsonAtomic(join(dir, 'activity.json'), { running: false, seconds: result.seconds, activity: activity.slice(-40), frames })
  const next = readBuild(workspace)
  const state = packageChanged ? 'void' : result.timedOut || done.code !== 0 ? 'errored' : 'ran'
  next.proofs[id] = { ...next.proofs[id], state, finishedAt: new Date().toISOString(), seconds: result.seconds, verdict: verdict ? { ready: verdict.ready, summary: verdict.summary } : null, frames: frames.length, runnerPid: null }
  log(next, packageChanged
    ? `Proof ${id}: void — package/ changed while it ran, so it proves nothing; run it again on the harness as it stands`
    : `Proof ${id}: agent finished in ${Math.round(result.seconds / 60)} min${result.timedOut ? ' (timed out)' : ''} · ${frames.length} frames · verdict ${verdict ? (verdict.ready ? 'ready' : 'not ready') : 'none'}`)
  saveBuild(workspace, next)
  return result
}

export function markProof(workspace, id, state, note) {
  const build = readBuild(workspace)
  if (!build.proofs[id]) throw new Error(`no proof "${id}"; run it first`)
  // A run whose harness changed underneath it is not evidence, and a pass on it would be a claim
  // about a harness that never existed.
  if (build.proofs[id].state === 'void' && state === 'passed') {
    throw new Error(`proof "${id}" is void: package/ changed while it ran. Run it again on the harness as it stands.`)
  }
  build.proofs[id] = { ...build.proofs[id], state, note: note ?? build.proofs[id].note ?? '', reviewedAt: new Date().toISOString() }
  log(build, `Proof ${id}: ${state}${note ? ` — ${note}` : ''}`)
  saveBuild(workspace, build)
}

export function stopProof(workspace, id) {
  const build = readBuild(workspace)
  const ids = id === '--all' ? Object.keys(build.proofs) : [id]
  for (const pid of ids) {
    const proof = build.proofs[pid]
    if (!proof) continue
    if (proof.viewer?.pid) stopViewer(proof.viewer.pid)
    // The agent first (its own process group, or it outlives everything), then the runner.
    if (proof.agentPid) { try { process.kill(-proof.agentPid, 'SIGTERM') } catch { /* gone */ } }
    if (proof.runnerPid && alive(proof.runnerPid)) { try { process.kill(proof.runnerPid, 'SIGTERM') } catch { /* gone */ } }
    proof.viewer = { ...(proof.viewer ?? {}), pid: null, stopped: true }
    if (proof.state === 'running') {
      proof.state = 'stopped'
      proof.runnerPid = null
      proof.agentPid = null
      log(build, `Proof ${pid}: stopped — run it again to prove anything`)
    }
  }
  saveBuild(workspace, build)
}

export function proofStatus(workspace, id) {
  const build = readBuild(workspace)
  const proof = build.proofs[id]
  if (!proof) return null
  const activity = readJson(join(proofDir(workspace, id), 'activity.json'), null)
  const running = proof.state === 'running' && proof.runnerPid && alive(proof.runnerPid)
  return { proof, activity, running }
}
