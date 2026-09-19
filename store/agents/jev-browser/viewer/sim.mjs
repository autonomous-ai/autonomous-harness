// sim.mjs — a tiny made-up travel site ("SkyHop") and the booking tasks Jev runs on it.
// The site is a five-page funnel (search, results, details, review, done) rendered to a flat list of
// elements with rectangles on a 1000x620 page, so the same data drives what Jev reads, where the
// cursor goes and what a late click lands on. Pure functions over a plain `world` object.
import { mulberry32 } from './kit.mjs'

export const PAGE_W = 1000, PAGE_H = 620
export const DEFAULT = {
  title: 'Jev Browser',
  description: 'Jev books flights on a made-up travel site, one click at a time.',
  site: 'SkyHop',
  stepMs: 170,          // one Jev decision (one click or one field) per step
  distraction: 0.25,    // 0..1 — cookie walls, pop-ups, decoy buttons and layout shifts. THE DIAL.
  flights: 7,           // result rows per search (4..9)
  maxSteps: 45,         // a task fails if it takes more steps than this
  seed: 11,
  style: 'Finish the task in as few actions as you can. Fill every field the task gives you, choose exactly the flight it asks for, refuse every extra, and close anything that gets in the way.',
  tasks: [
    { from: 'SFO', to: 'JFK', day: 'Friday', pick: 'cheapest', nonstop: true, name: 'Ada Park', email: 'ada@example.com', bags: 1 },
    { from: 'SEA', to: 'AUS', day: 'Monday', pick: 'earliest', nonstop: false, name: 'Omar Reyes', email: 'omar@example.com', bags: 0 },
    { from: 'BOS', to: 'LAX', day: 'Sunday', pick: 'cheapest', nonstop: false, name: 'Mei Tanaka', email: 'mei@example.com', bags: 2 },
    { from: 'DEN', to: 'MIA', day: 'Wednesday', pick: 'latest', nonstop: true, name: 'Lena Okafor', email: 'lena@example.com', bags: 1 },
  ],
}

const AIRLINES = ['Nimbus', 'Kestrel', 'Blue Heron', 'Polar', 'Sundial', 'Alto']
const NEAR = { JFK: 'EWR', LAX: 'BUR', MIA: 'FLL', AUS: 'SAT', SFO: 'OAK', SEA: 'PDX', BOS: 'PVD', DEN: 'COS' }
const pad = (n) => String(n).padStart(2, '0')
const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`

export function goalText(t) {
  const bags = t.bags === 0 ? 'no checked bags' : t.bags === 1 ? '1 checked bag' : `${t.bags} checked bags`
  return `Book the ${t.pick} ${t.nonstop ? 'nonstop ' : ''}flight from ${t.from} to ${t.to} on ${t.day} for ${t.name} (${t.email}), ${bags}. No extras.`
}

export function cleanTask(t, i = 0) {
  const s = (v, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : d)
  const pick = ['cheapest', 'earliest', 'latest'].includes(t?.pick) ? t.pick : 'cheapest'
  return { from: s(t?.from, 'SFO').toUpperCase().slice(0, 4), to: s(t?.to, 'JFK').toUpperCase().slice(0, 4), day: s(t?.day, 'Friday'), pick, nonstop: !!t?.nonstop, name: s(t?.name, `Guest ${i + 1}`).replace(/[()]/g, ''), email: s(t?.email, `guest${i + 1}@example.com`).replace(/[\s()]/g, ''), bags: Math.max(0, Math.min(3, Math.round(Number(t?.bags) || 0))) }
}

function makeFlights(task, n, rng) {
  const rows = []
  for (let i = 0; i < n; i++) {
    const dep = 5 * 60 + Math.floor(rng() * 16 * 12) * 5, stops = rng() < 0.45 ? 0 : rng() < 0.75 ? 1 : 2
    rows.push({ id: `f${i + 1}`, airline: AIRLINES[(rng() * AIRLINES.length) | 0], dep, arr: dep + 170 + stops * 95 + Math.floor(rng() * 12) * 5, stops, price: 120 + Math.floor(rng() * 56) * 5 + (stops === 0 ? 60 : 0), to: task.to, sponsored: false })
  }
  if (task.nonstop && !rows.some((r) => r.stops === 0)) rows[(rng() * rows.length) | 0].stops = 0
  // No ties on the thing the task sorts by, so there is exactly one right answer.
  const key = task.pick === 'cheapest' ? 'price' : 'dep'
  const seen = new Set()
  for (const r of rows) { while (seen.has(r[key])) r[key] += 5; seen.add(r[key]) }
  rows.sort((a, b) => a.dep - b.dep)
  return rows
}

export function bestFlight(task, flights) {
  const ok = flights.filter((f) => !f.sponsored && f.to === task.to && (!task.nonstop || f.stops === 0))
  const by = task.pick === 'cheapest' ? (f) => f.price : task.pick === 'earliest' ? (f) => f.dep : (f) => -f.dep
  return ok.sort((a, b) => by(a) - by(b))[0] ?? null
}

export function createWorld(cfg, taskIndex = 0, round = 0) {
  const tasks = (Array.isArray(cfg.tasks) && cfg.tasks.length ? cfg.tasks : DEFAULT.tasks).map(cleanTask)
  const task = tasks[taskIndex % tasks.length]
  const rng = mulberry32((Number(cfg.seed) || 11) + taskIndex * 131 + round * 7919)
  const flights = makeFlights(task, Math.max(4, Math.min(9, Math.round(cfg.flights) || 7)), rng)
  const d = cfg.distraction
  return {
    rng, task, taskIndex, taskCount: tasks.length, goal: goalText(task),
    page: 'search', flights, best: bestFlight(task, flights),
    form: { from: '', to: '', day: '', promo: '' }, nonstopOnly: false, sort: 'dep', sponsoredShown: false,
    chosen: null, details: { name: '', email: '', bags: 0, insurance: false, newsletter: false }, flex: false,
    overlay: rng() < d * 0.9 ? { kind: 'cookie' } : null,
    steps: 0, wasted: 0, misclicks: 0, startedAt: null, finishedAt: null,
    status: 'running', result: null, history: [], lastAction: null, shake: null,
  }
}

// ---------------------------------------------------------------- layout: page -> elements
const el = (id, role, label, rect, extra = {}) => ({ id, role, label, rect, act: role !== 'text' && role !== 'card', ...extra })

function rowText(f, task) {
  const stops = f.stops === 0 ? 'nonstop' : f.stops === 1 ? '1 stop' : `${f.stops} stops`
  return `${f.sponsored ? 'Sponsored · ' : ''}${f.airline} · ${task.from} to ${f.to} · departs ${hhmm(f.dep)} arrives ${hhmm(f.arr)} · ${stops} · $${f.price}`
}

export function visibleFlights(world) {
  let rows = world.flights.filter((f) => !world.nonstopOnly || f.stops === 0)
  rows = [...rows].sort((a, b) => (world.sort === 'price' ? a.price - b.price : world.sort === 'late' ? b.dep - a.dep : a.dep - b.dep))
  if (world.sponsoredShown) rows = [world.sponsoredRow, ...rows]
  return rows.slice(0, 8)
}

export function elements(world, cfg) {
  const d = cfg.distraction, t = world.task, out = []
  out.push(el('logo', 'text', cfg.site, [28, 14, 160, 30], { tone: 'logo' }))
  if (d > 0.15) for (const [i, name] of ['Hotels', 'Cars', 'Deals'].entries()) out.push(el(`nav-${name.toLowerCase()}`, 'link', name, [760 + i * 78, 14, 70, 30], { tone: 'decoy' }))

  if (world.page === 'search') {
    out.push(el('h', 'text', 'Where to?', [60, 84, 400, 44], { tone: 'h1' }))
    out.push(el('card', 'card', '', [40, 140, 920, d > 0.3 ? 300 : 230]))
    out.push(el('from', 'input', 'From', [70, 180, 250, 56], { value: world.form.from }))
    out.push(el('to', 'input', 'To', [340, 180, 250, 56], { value: world.form.to }))
    out.push(el('day', 'input', 'Day', [610, 180, 200, 56], { value: world.form.day }))
    const ready = world.form.from && world.form.to && world.form.day
    out.push(el('search-flights', 'button', 'Search flights', [70, 270, 220, 54], { tone: 'primary', disabled: !ready, note: ready ? '' : 'disabled until From, To and Day are filled' }))
    if (d > 0.1) out.push(el('search-hotels', 'button', 'Search hotels', [310, 270, 190, 54], { tone: 'decoy' }))
    if (d > 0.45) out.push(el('search-cars', 'button', 'Search flights + cars', [520, 270, 230, 54], { tone: 'decoy' }))
    if (d > 0.3) out.push(el('promo', 'input', 'Promo code (optional)', [70, 356, 300, 50], { value: world.form.promo, tone: 'decoy' }))
  } else if (world.page === 'results') {
    out.push(el('h', 'text', `${t.from} to ${t.to} · ${t.day}`, [60, 74, 500, 40], { tone: 'h1' }))
    out.push(el('nonstop-only', 'toggle', 'Nonstop only', [60, 122, 170, 38], { value: world.nonstopOnly ? 'on' : 'off' }))
    out.push(el('sort-price', 'button', 'Cheapest first', [250, 122, 160, 38], { tone: world.sort === 'price' ? 'on' : 'quiet' }))
    out.push(el('sort-early', 'button', 'Earliest first', [420, 122, 160, 38], { tone: world.sort === 'dep' ? 'on' : 'quiet' }))
    out.push(el('sort-late', 'button', 'Latest first', [590, 122, 150, 38], { tone: world.sort === 'late' ? 'on' : 'quiet' }))
    visibleFlights(world).forEach((f, i) => {
      const y = 176 + i * 54
      out.push(el(`row-${f.id}`, 'text', rowText(f, t), [60, y, 730, 46], { tone: f.sponsored ? 'sponsored' : 'row' }))
      out.push(el(`select-${f.id}`, 'button', 'Select', [806, y + 3, 134, 40], { tone: f.sponsored ? 'decoy' : 'primary', context: rowText(f, t) }))
    })
  } else if (world.page === 'details') {
    const f = world.chosen
    out.push(el('h', 'text', 'Passenger details', [60, 74, 500, 40], { tone: 'h1' }))
    out.push(el('sum', 'text', f ? rowText(f, t) : '', [60, 118, 880, 34], { tone: 'row' }))
    out.push(el('name', 'input', 'Full name', [60, 176, 400, 56], { value: world.details.name }))
    out.push(el('email', 'input', 'Email', [480, 176, 400, 56], { value: world.details.email }))
    out.push(el('bags', 'text', `Checked bags: ${world.details.bags}`, [60, 262, 220, 44], { tone: 'label' }))
    out.push(el('bag-remove', 'button', 'Remove a bag', [290, 262, 160, 44], { tone: 'quiet', disabled: world.details.bags === 0 }))
    out.push(el('bag-add', 'button', 'Add a bag', [462, 262, 140, 44], { tone: 'quiet', disabled: world.details.bags >= 3 }))
    if (d > 0.1) out.push(el('insurance', 'toggle', 'Add travel insurance +$49', [60, 334, 310, 44], { value: world.details.insurance ? 'on' : 'off', tone: 'decoy' }))
    if (d > 0.35) out.push(el('newsletter', 'toggle', 'Email me deals', [390, 334, 200, 44], { value: world.details.newsletter ? 'on' : 'off', tone: 'decoy' }))
    const ready = world.details.name && world.details.email
    out.push(el('continue', 'button', 'Continue', [60, 414, 200, 54], { tone: 'primary', disabled: !ready, note: ready ? '' : 'disabled until name and email are filled' }))
    out.push(el('change-flight', 'button', 'Change flight', [280, 414, 180, 54], { tone: 'quiet' }))
  } else if (world.page === 'review') {
    const f = world.chosen
    out.push(el('h', 'text', 'Review your booking', [60, 74, 500, 40], { tone: 'h1' }))
    out.push(el('sum', 'text', f ? rowText(f, t) : '', [60, 124, 880, 34], { tone: 'row' }))
    out.push(el('who', 'text', `${world.details.name} · ${world.details.email} · ${world.details.bags} checked bag(s)${world.details.insurance ? ' · insurance +$49' : ''}${world.flex ? ' · Flex +$80' : ''}`, [60, 166, 880, 34], { tone: 'row' }))
    out.push(el('total', 'text', `Total $${(f?.price ?? 0) + world.details.bags * 35 + (world.details.insurance ? 49 : 0) + (world.flex ? 80 : 0)}`, [60, 224, 400, 44], { tone: 'h1' }))
    out.push(el('confirm', 'button', 'Confirm booking', [60, 330, 240, 56], { tone: 'primary' }))
    if (d > 0.2) out.push(el('flex', 'toggle', 'Upgrade to Flex +$80', [320, 330, 270, 56], { value: world.flex ? 'on' : 'off', tone: 'decoy' }))
    out.push(el('back', 'button', 'Back', [610, 330, 120, 56], { tone: 'quiet' }))
  } else if (world.page === 'promo') {
    out.push(el('h', 'text', 'Hotel deals near you', [60, 84, 600, 44], { tone: 'h1' }))
    out.push(el('p', 'text', 'You left your booking. Nothing here helps with the task.', [60, 140, 800, 34], { tone: 'row' }))
    out.push(el('back-to-booking', 'button', 'Back to my booking', [60, 210, 260, 54], { tone: 'primary' }))
  } else if (world.page === 'done') {
    out.push(el('h', 'text', world.result?.ok ? 'Booked. Exactly as asked.' : 'Booked, but not what was asked.', [60, 110, 880, 50], { tone: world.result?.ok ? 'ok' : 'bad' }))
    out.push(el('p', 'text', world.result?.why ?? '', [60, 176, 880, 34], { tone: 'row' }))
  }

  if (world.overlay?.kind === 'cookie') {
    out.push(el('cookie', 'card', '', [0, 486, 1000, 134], { tone: 'overlay' }))
    out.push(el('cookie-text', 'text', 'We value your privacy. This made-up site uses made-up cookies.', [40, 512, 600, 40], { tone: 'overlaytext' }))
    out.push(el('cookie-accept', 'button', 'Accept all', [690, 524, 130, 46], { tone: 'primary', overlay: true }))
    out.push(el('cookie-reject', 'button', 'Reject', [836, 524, 120, 46], { tone: 'quiet', overlay: true }))
  } else if (world.overlay?.kind === 'popup') {
    const [x, y] = world.overlay.at
    out.push(el('popup', 'card', '', [x, y, 480, 300], { tone: 'overlay' }))
    out.push(el('popup-text', 'text', 'Wait! 20% off hotels if you book in the next 10 minutes.', [x + 30, y + 60, 420, 80], { tone: 'overlaytext' }))
    out.push(el('popup-claim', 'button', 'Claim my offer', [x + 40, y + 210, 190, 50], { tone: 'decoy', overlay: true }))
    out.push(el('popup-no', 'button', 'No thanks', [x + 250, y + 210, 170, 50], { tone: 'quiet', overlay: true }))
    out.push(el('popup-close', 'button', '×', [x + 430, y + 12, 36, 36], { tone: 'quiet', overlay: true }))
  }
  // While an overlay is up, the page under it cannot be used.
  if (world.overlay) for (const e of out) if (e.act && !e.overlay) { e.blocked = true }
  return out
}

const URLS = { search: '/', results: '/flights', details: '/passenger', review: '/review', promo: '/deals/hotels', done: '/confirmed' }
export const pageUrl = (world, cfg) => `https://${String(cfg.site).toLowerCase().replace(/[^a-z0-9]+/g, '')}.example${URLS[world.page] ?? '/'}`

/** The text Jev reads: the task, the page, and every element it may act on. Nothing hidden. */
export function observe(world, cfg) {
  const els = elements(world, cfg)
  const can = els.filter((e) => e.act && !e.blocked && !e.disabled)
  const line = (e) => `  ${e.id}  ${e.role} "${e.label}"${e.value !== undefined ? ` value "${e.value}"` : ''}${e.context ? ` — ${e.context}` : ''}${e.note ? ` (${e.note})` : ''}`
  const facts = els.filter((e) => e.role === 'text' && !['logo'].includes(e.tone)).map((e) => `  ${e.label}`)
  const text = [
    `You operate a web browser on a travel site. ${cfg.style}`,
    `TASK: ${world.goal}`,
    `PAGE: ${world.page}  url ${pageUrl(world, cfg)}`,
    world.overlay ? `OVERLAY: a ${world.overlay.kind === 'cookie' ? 'cookie banner' : 'pop-up'} covers the page. Only its buttons work until it is closed.` : 'OVERLAY: none',
    'PAGE TEXT:', ...facts,
    'ELEMENTS you can act on (clicking an input fills it with the right value from the task):', ...can.map(line),
    `RECENT: ${world.history.slice(-4).map((h) => h.id + (h.note ? ` (${h.note})` : '')).join(', ') || 'nothing yet'}`,
  ].join('\n')
  const options = Object.fromEntries(can.map((e) => [e.id, `${e.role} "${e.label}"${e.value !== undefined ? ` value "${e.value}"` : ''}${e.context ? ` — ${e.context}` : ''}`]))
  return { text, options, els }
}

// ---------------------------------------------------------------- acting
const inside = (r, x, y) => x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]

/**
 * One step. Jev chose `id` from the page it READ. Then the page may shift before the click lands
 * (a pop-up opens, a sponsored row pushes the list down). The click goes to the chosen element's
 * old position and hits whatever is there now. That gap between reading and clicking is the dial.
 */
export function act(world, cfg, id) {
  if (world.status !== 'running') return null
  world.startedAt ??= world.steps
  const before = elements(world, cfg)
  const target = before.find((e) => e.id === id && e.act)
  world.steps++
  world.shake = null
  const rec = { step: world.steps, id, note: '', x: 500, y: 310, landed: id, shift: null }
  if (!target) { rec.note = 'no such element'; world.wasted++; world.history.push(rec); world.lastAction = rec; return rec }
  rec.x = target.rect[0] + target.rect[2] / 2; rec.y = target.rect[1] + target.rect[3] / 2

  // The layout shift, decided before the click lands.
  const d = cfg.distraction
  if (!world.overlay && world.page !== 'done' && world.rng() < d * 0.22) {
    world.overlay = { kind: 'popup', at: [120 + Math.floor(world.rng() * 400), 90 + Math.floor(world.rng() * 200)] }
    rec.shift = 'pop-up'
  } else if (world.page === 'results' && !world.sponsoredShown && world.rng() < d * 0.5) {
    const t = world.task
    world.sponsoredRow = { id: 'ad', airline: 'FlyCheap', dep: 6 * 60 + 10, arr: 6 * 60 + 10 + 300, stops: 0, price: 89, to: NEAR[t.to] ?? 'XXX', sponsored: true }
    world.sponsoredShown = true
    rec.shift = 'sponsored row'
  }
  let hit = target
  if (rec.shift) {
    const now = elements(world, cfg)
    hit = now.filter((e) => e.act && !e.blocked && inside(e.rect, rec.x, rec.y)).pop() ?? null
    if (!hit || hit.id !== id) { world.misclicks++; rec.note = hit ? `layout shifted: landed on ${hit.id}` : 'layout shifted: the click hit nothing' }
    rec.landed = hit?.id ?? null
  }
  if (!hit) { world.wasted++; world.history.push(rec); world.lastAction = rec; return finishIfOver(world, cfg, rec) }
  if (hit.blocked || hit.disabled) { rec.note ||= hit.disabled ? 'disabled' : 'blocked by the overlay'; world.wasted++; world.shake = hit.id; world.history.push(rec); world.lastAction = rec; return finishIfOver(world, cfg, rec) }
  apply(world, hit.id, rec)
  world.history.push(rec); if (world.history.length > 80) world.history.shift()
  world.lastAction = rec
  return finishIfOver(world, cfg, rec)
}

function apply(world, id, rec) {
  const t = world.task
  const useful = (ok) => { if (!ok) world.wasted++ }
  if (id === 'cookie-accept' || id === 'cookie-reject' || id === 'popup-no' || id === 'popup-close') { world.overlay = null; return }
  if (id === 'popup-claim') { world.overlay = null; world.returnTo = world.page; world.page = 'promo'; rec.note ||= 'left the booking'; world.wasted++; return }
  if (id === 'back-to-booking') { world.page = world.returnTo ?? 'search'; return }
  if (id.startsWith('nav-') || id === 'search-hotels' || id === 'search-cars') { world.returnTo = world.page; world.page = 'promo'; rec.note ||= 'left the booking'; world.wasted++; return }
  if (world.page === 'search') {
    if (id === 'from') { useful(!world.form.from); world.form.from = t.from; rec.typed = t.from }
    else if (id === 'to') { useful(!world.form.to); world.form.to = t.to; rec.typed = t.to }
    else if (id === 'day') { useful(!world.form.day); world.form.day = t.day; rec.typed = t.day }
    else if (id === 'promo') { world.form.promo = 'SAVE10'; rec.typed = 'SAVE10'; world.wasted++ }
    else if (id === 'search-flights') world.page = 'results'
  } else if (world.page === 'results') {
    if (id === 'nonstop-only') world.nonstopOnly = !world.nonstopOnly
    else if (id === 'sort-price') world.sort = 'price'
    else if (id === 'sort-early') world.sort = 'dep'
    else if (id === 'sort-late') world.sort = 'late'
    else if (id.startsWith('select-')) { const fid = id.slice(7); world.chosen = fid === 'ad' ? world.sponsoredRow : world.flights.find((f) => f.id === fid) ?? null; if (world.chosen) world.page = 'details' }
  } else if (world.page === 'details') {
    if (id === 'name') { useful(!world.details.name); world.details.name = t.name; rec.typed = t.name }
    else if (id === 'email') { useful(!world.details.email); world.details.email = t.email; rec.typed = t.email }
    else if (id === 'bag-add') world.details.bags = Math.min(3, world.details.bags + 1)
    else if (id === 'bag-remove') world.details.bags = Math.max(0, world.details.bags - 1)
    else if (id === 'insurance') world.details.insurance = !world.details.insurance
    else if (id === 'newsletter') world.details.newsletter = !world.details.newsletter
    else if (id === 'continue') world.page = 'review'
    else if (id === 'change-flight') { world.page = 'results'; world.chosen = null }
  } else if (world.page === 'review') {
    if (id === 'flex') world.flex = !world.flex
    else if (id === 'back') world.page = 'details'
    else if (id === 'confirm') {
      const f = world.chosen, b = world.best
      const problems = []
      if (!f || !b || f.id !== b.id) problems.push(f?.sponsored ? `booked a sponsored flight to ${f.to}, not ${t.to}` : `booked ${f ? '$' + f.price + ' departing ' + hhmm(f.dep) : 'nothing'}, the ${t.pick}${t.nonstop ? ' nonstop' : ''} was $${b?.price} departing ${b ? hhmm(b.dep) : '?'}`)
      if (world.details.bags !== t.bags) problems.push(`${world.details.bags} bags instead of ${t.bags}`)
      if (world.details.insurance) problems.push('bought insurance')
      if (world.flex) problems.push('bought the Flex upgrade')
      world.result = { ok: problems.length === 0, why: problems.length ? problems.join('; ') : `${t.pick}${t.nonstop ? ' nonstop' : ''} flight, right passenger, ${t.bags} bag(s), no extras` }
      world.page = 'done'; world.status = 'done'; world.finishedAt = world.steps
    }
  }
}

function finishIfOver(world, cfg, rec) {
  if (world.status === 'running' && world.steps >= cfg.maxSteps) {
    world.status = 'done'; world.finishedAt = world.steps
    world.result = { ok: false, why: `gave up after ${cfg.maxSteps} steps on the ${world.page} page` }
  }
  return rec
}
