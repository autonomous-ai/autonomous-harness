// Jev Browser viewer — a loopback server where Jev operates a web browser, live.
// The site is a small made-up travel shop. At every step the page is written out as text (the task,
// the page, every element that can be acted on) and Jev (TypeSafe's System One model) picks ONE
// element out of the list, a new action space every step, plus two yes/no reads, all in one call.
// A booking takes a few seconds. The honest dial is `distraction`: cookie walls, pop-ups, decoys and
// layout shifts that land between reading the page and clicking it.
//
// The chat agent edits site.json (the tasks, the distraction, the pace). The pane lets a person
// click the page themselves, throw a pop-up at Jev, and move the dials.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds site.json (watched live).

import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, clean } from './kit.mjs'
import { DEFAULT, createWorld, observe, act, elements, pageUrl, cleanTask } from './sim.mjs'
import { browserMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

/** Keep a wild config from breaking the demo. check.mjs reports the same ranges to the agent. */
export function sanitize(raw) {
  return {
    ...DEFAULT, ...raw,
    title: String(raw.title ?? DEFAULT.title).slice(0, 80),
    description: String(raw.description ?? DEFAULT.description).slice(0, 300),
    site: String(raw.site ?? DEFAULT.site).replace(/[^\w .-]/g, '').slice(0, 24) || DEFAULT.site,
    style: String(raw.style ?? DEFAULT.style).slice(0, 600),
    stepMs: clampN(raw.stepMs, 40, 2000, DEFAULT.stepMs),
    distraction: clampN(raw.distraction, 0, 1, DEFAULT.distraction),
    flights: Math.round(clampN(raw.flights, 4, 9, DEFAULT.flights)),
    maxSteps: Math.round(clampN(raw.maxSteps, 12, 200, DEFAULT.maxSteps)),
    seed: Math.round(clampN(raw.seed, 0, 1e9, DEFAULT.seed)),
    tasks: (Array.isArray(raw.tasks) && raw.tasks.length ? raw.tasks : DEFAULT.tasks).slice(0, 40).map(cleanTask),
  }
}

export async function startBrowserViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)

  // Every binding is declared before anything can call into the closures below.
  let world = null
  let stopped = false, running = false, busy = false
  let timer = null, salt = 1, taskIndex = 0, round = 0, lastVerdictAt = 0, taskWallStart = 0, doneAt = 0
  let overrides = {}
  let last = { probs: {}, choice: null, confidence: 0, pDone: 0, pObstacle: 0 }
  let stateText = ''
  let error = null
  let server = null
  const session = { tasks: 0, ok: 0, steps: 0, wasted: 0, misclicks: 0, wallMs: 0, results: [] }

  const cfgWatch = watchConfig(join(workspace, 'site.json'), DEFAULT, () => { overrides = {}; taskIndex = 0; round = 0; newTask(); push(true) })
  const cfg = () => sanitize({ ...cfgWatch.get(), ...overrides })

  function newTask() {
    world = createWorld(cfg(), taskIndex, round)
    taskWallStart = 0; doneAt = 0
    stateText = observe(world, cfg()).text
    last = { probs: {}, choice: null, confidence: 0, pDone: 0, pObstacle: 0 }
  }

  function frame() {
    const c = cfg()
    return {
      t: world.steps, stepMs: c.stepMs, title: c.title, site: c.site, description: c.description,
      task: { goal: world.goal, index: world.taskIndex % world.taskCount, count: world.taskCount, round },
      page: world.page, url: pageUrl(world, c), els: elements(world, c), overlay: world.overlay?.kind ?? null, shake: world.shake,
      lastAction: world.lastAction, last,
      status: world.status, result: world.result, steps: world.steps, wasted: world.wasted, misclicks: world.misclicks,
      wallMs: taskWallStart ? (doneAt || Date.now()) - taskWallStart : 0,
      session: { ...session, results: session.results.slice(-12) },
      distraction: c.distraction, maxSteps: c.maxSteps, stateText,
      running, error, cfgError: cfgWatch.error(), overrides,
    }
  }

  function verdict() {
    const c = cfg()
    const problem = cfgWatch.error() || error
    const rate = session.tasks ? Math.round((session.ok / session.tasks) * 100) : 0
    const avgSteps = session.tasks ? (session.steps / session.tasks).toFixed(1) : '—'
    writeVerdict(workspace, {
      ready: session.tasks > 0 || world.steps > 0,
      summary: problem
        ? `Jev Browser needs a fix: ${problem}`
        : `${c.title} · ${session.tasks} bookings · ${rate}% exactly right · ${avgSteps} steps each · ${session.misclicks} clicks lost to layout shifts`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'site', message: problem }] : []),
        ...session.results.filter((r) => !r.ok).slice(-5).map((r) => ({ severity: 'warning', kind: 'booking', message: `${r.goal} → ${r.why}` })),
        { severity: 'info', kind: 'run', message: `distraction ${c.distraction.toFixed(2)}, ${c.stepMs} ms per step, ${session.wasted} wasted steps in ${session.steps}` },
      ],
      artifact: 'site.json',
      phases: [
        { id: 'site', name: 'Site up', state: 'done' },
        { id: 'book', name: 'Booking', state: world.steps > 0 || session.tasks > 0 ? 'active' : 'pending' },
        { id: 'score', name: 'Bookings checked', state: session.tasks > 0 ? 'done' : 'pending' },
      ],
    })
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    server?.broadcast(frame())
  }

  function settle() {
    if (world.status !== 'done' || doneAt) return
    doneAt = Date.now()
    session.tasks++; if (world.result?.ok) session.ok++
    session.steps += world.steps; session.wasted += world.wasted; session.misclicks += world.misclicks
    session.wallMs += taskWallStart ? doneAt - taskWallStart : 0
    session.results.push({ goal: world.goal, ok: !!world.result?.ok, why: world.result?.why ?? '', steps: world.steps, wallMs: taskWallStart ? doneAt - taskWallStart : 0 })
    if (session.results.length > 60) session.results.shift()
  }

  async function decide(humanId = null) {
    if (busy || stopped) return
    busy = true
    try {
      const c = cfg()
      if (world.status === 'done') {
        // Show the result for about 2.6 seconds of steps, then take the next task.
        world.rest = (world.rest ?? 0) + 1
        if (world.rest * c.stepMs >= 2600) { taskIndex++; if (taskIndex % world.taskCount === 0) round++; newTask() }
        return
      }
      if (!taskWallStart) taskWallStart = Date.now()
      const o = observe(world, c)
      stateText = o.text
      let choice = humanId
      if (!humanId) {
        const res = await evaluate({
          state: o.text,
          questions: {
            action: jev.choice(o.options, 'Which ONE element do you act on next to finish the task?'),
            done: jev.noul('Is the task already complete?'),
            obstacle: jev.noul('Is something covering the page that must be closed first?'),
          },
          salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: browserMock,
        })
        const a = res.answers.action ?? {}
        choice = a.choice && o.options[a.choice] !== undefined ? a.choice : Object.keys(o.options)[0]
        last = { probs: a.probabilities ?? {}, choice, confidence: Number(a.confidence ?? 0), pDone: Number(res.answers.done?.noul ?? 0), pObstacle: Number(res.answers.obstacle?.noul ?? 0) }
      } else last = { ...last, choice: humanId, human: true }
      const rec = act(world, c, choice)
      if (rec && humanId) rec.note = rec.note ? `you clicked · ${rec.note}` : 'you clicked'
      stateText = observe(world, c).text
      settle()
      error = null
    } catch (e) {
      error = clean(e?.message ?? String(e))
    } finally {
      busy = false
    }
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().stepMs) }
  async function run() { const t0 = Date.now(); await decide(); push(); if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().stepMs - (Date.now() - t0))) }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { Object.assign(session, { tasks: 0, ok: 0, steps: 0, wasted: 0, misclicks: 0, wallMs: 0, results: [] }); overrides = {}; taskIndex = 0; round = 0; salt = 1; newTask() }
    else if (cmd === 'tick') { const n = Math.round(clampN(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'click') { if (typeof body.id === 'string' && body.id.length < 40) await decide(body.id) }
    else if (cmd === 'popup') { if (!world.overlay && world.status === 'running') world.overlay = { kind: 'popup', at: [260, 150] }; stateText = observe(world, cfg()).text }
    else if (cmd === 'task') { taskIndex = Math.round(clampN(body.index, 0, 1000, 0)); newTask() }
    else if (cmd === 'set') {
      const allowed = { distraction: [0, 1], stepMs: [40, 2000] }
      if (allowed[body.key]) overrides = { ...overrides, [body.key]: clampN(body.value, allowed[body.key][0], allowed[body.key][1], cfg()[body.key]) }
    }
    push(true)
    return { steps: world.steps }
  }

  newTask()
  server = await serveViewer({ here: HERE, port, state: frame, control })
  push(true)
  running = true
  schedule()

  return {
    url: server.url,
    async close() { stopped = true; running = false; clearTimeout(timer); cfgWatch.close(); await server.close() },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startBrowserViewer({ workspace, port })
  console.log(`Jev Browser listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
