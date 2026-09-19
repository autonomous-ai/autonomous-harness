// mock.mjs — the offline stand-in for Jev in this harness. It reads ONLY the state text and the
// option descriptions that live Jev also gets, and answers with a full probability distribution.
// It is a careful form-filler, not Jev's judgement; the pane badges it MOCK.

export function readTask(text) {
  const m = text.match(/TASK: Book the (cheapest|earliest|latest) (nonstop )?flight from (\S+) to (\S+) on (\S+) for (.+?) \((\S+?)\), (no|\d+) checked bags?/)
  if (!m) return null
  return { pick: m[1], nonstop: !!m[2], from: m[3], to: m[4], day: m[5], name: m[6], email: m[7], bags: m[8] === 'no' ? 0 : Number(m[8]) }
}

const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

function parseRow(desc) {
  const m = desc.match(/(Sponsored · )?(.+?) · (\S+) to (\S+) · departs (\d\d:\d\d) arrives (\d\d:\d\d) · (nonstop|\d+ stops?) · \$(\d+)/)
  if (!m) return null
  return { sponsored: !!m[1], from: m[3], to: m[4], dep: toMin(m[5]), stops: m[7] === 'nonstop' ? 0 : parseInt(m[7], 10), price: Number(m[8]) }
}

/** Which element a careful person would act on next, from the text alone. */
export function nextTarget(text, options, descriptions) {
  const task = readTask(text)
  if (!task) return null
  const has = (id) => options.includes(id)
  const valueOf = (id) => (descriptions[id]?.match(/value "([^"]*)"/) ?? [])[1]
  const page = (text.match(/^PAGE: (\w+)/m) ?? [])[1]

  if (/^OVERLAY: a /m.test(text)) return ['cookie-reject', 'popup-no', 'popup-close', 'cookie-accept'].find(has) ?? null
  if (page === 'promo') return has('back-to-booking') ? 'back-to-booking' : null
  if (page === 'search') {
    for (const id of ['from', 'to', 'day']) if (has(id) && valueOf(id) === '') return id
    return has('search-flights') ? 'search-flights' : null
  }
  if (page === 'results') {
    const rows = options.filter((id) => id.startsWith('select-')).map((id) => ({ id, ...parseRow(descriptions[id] ?? '') })).filter((r) => r.to)
    const ok = rows.filter((r) => !r.sponsored && r.to === task.to && r.from === task.from && (!task.nonstop || r.stops === 0))
    if (!ok.length) return task.nonstop && has('nonstop-only') && valueOf('nonstop-only') === 'on' ? 'nonstop-only' : null
    const by = task.pick === 'cheapest' ? (r) => r.price : task.pick === 'earliest' ? (r) => r.dep : (r) => -r.dep
    return ok.sort((a, b) => by(a) - by(b))[0].id
  }
  if (page === 'details') {
    const sum = text.match(/· (\S+) to (\S+) · departs/)
    if (sum && sum[2] !== task.to && has('change-flight')) return 'change-flight'
    if (task.nonstop && /· \d+ stops? · \$/.test(text.match(/^ {2}.*departs.*$/m)?.[0] ?? '') && has('change-flight')) return 'change-flight'
    if (has('name') && valueOf('name') === '') return 'name'
    if (has('email') && valueOf('email') === '') return 'email'
    const bags = Number((text.match(/Checked bags: (\d+)/) ?? [])[1] ?? 0)
    if (bags < task.bags && has('bag-add')) return 'bag-add'
    if (bags > task.bags && has('bag-remove')) return 'bag-remove'
    if (has('insurance') && valueOf('insurance') === 'on') return 'insurance'
    return has('continue') ? 'continue' : null
  }
  if (page === 'review') {
    if (has('flex') && valueOf('flex') === 'on') return 'flex'
    const who = text.match(/· (\d+) checked bag\(s\)( · insurance)?/)
    if (who && (Number(who[1]) !== task.bags || who[2])) return 'back'
    return has('confirm') ? 'confirm' : null
  }
  return null
}

export function browserMock(text, id, q) {
  if (!/^TASK: /m.test(text)) return null // not our state text: let the generic mock answer
  if (id === 'action') {
    const options = q.options ?? []
    if (!options.length) return null
    const target = nextTarget(text, options, q.descriptions ?? {})
    const words = new Set((text.match(/^TASK: .*$/m)?.[0] ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
    // Everything that is not the target still gets a little mass, more if it shares the task's words.
    const raw = options.map((o) => {
      if (o === target) return 5.2
      const d = `${o} ${q.descriptions?.[o] ?? ''}`.toLowerCase().split(/[^a-z0-9]+/)
      return 0.6 + 0.5 * d.filter((w) => words.has(w)).length
    })
    const exps = raw.map((r) => Math.exp(r - Math.max(...raw))), sum = exps.reduce((a, b) => a + b, 0)
    const probabilities = Object.fromEntries(options.map((o, i) => [o, exps[i] / sum]))
    const choice = target ?? options[exps.indexOf(Math.max(...exps))]
    return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
  }
  if (id === 'done') return { type: 'noul', noul: /^PAGE: done/m.test(text) ? 0.97 : 0.02 }
  if (id === 'obstacle') return { type: 'noul', noul: /^OVERLAY: a /m.test(text) ? 0.95 : 0.04 }
  return null
}
