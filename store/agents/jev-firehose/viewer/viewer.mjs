// Jev Firehose viewer — a loopback server that runs a live map-reduce demo.
//
// A seeded generator makes synthetic support-inbox messages with a known true team. Jev (TypeSafe's
// System One model) triages every message in ONE call that asks five typed questions in parallel:
// team (choice), urgency (score), spam (noul), needs_human (noul), mood (score). A pool of
// concurrent calls keeps the stream moving. If the team confidence is under `threshold`, the
// message is escalated instead of auto-routed. Because the true team is known, accuracy is measured
// live. The honest difficulty dial is `noise`: how many phrases from a WRONG team get mixed into
// each message. All data is made up.
//
// Second mode, "your data": firehose.json may set `source` to a .csv, .tsv, .jsonl or .json file in
// the workspace. Then the generator is off, the file's messages are triaged once, there is no ground
// truth (so no accuracy), and the results are written to triage.csv in the workspace.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. The workspace holds firehose.json (watched).

import { readFileSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, toWire, PRICE_PER_MTOK } from '../toolchain/jev.mjs'
import { serveViewer, watchConfig, writeVerdict, mulberry32, clean } from './kit.mjs'
import { loadSource, csvLine, OUTPUT_FILE, SOURCE_LIMITS } from './source.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'firehose.json'

export const LIMITS = {
  teams: [2, 24], phrases: 4, noise: [0, 1], threshold: [0, 1], targetAccuracy: [0.5, 1],
  ratePerSec: [1, 400], concurrency: [1, 64], batch: [50, 100000], llmSecondsPerItem: [0.1, 120], spamRate: [0, 0.5],
}
const BURST_RATE = 400      // messages per second while a burst drains
const SUMMARY_MS = 3200     // how long the batch summary card stays up
const FRAME_MS = 100        // SSE frame cadence
const KEEP_RECORDS = 6000   // full records (text + every answer) kept for the inspector
const MAX_TRIES = 3         // your-data mode: after this many failed calls a message is escalated unanswered
const URGENCY_WORD = ['no_rush', 'this_week', 'today', 'urgent', 'emergency']
const MOOD_WORD = ['calm', 'annoyed', 'furious']
export const TRIAGE_COLUMNS = ['id', 'team', 'team_confidence', 'urgency', 'spam', 'needs_human', 'mood', 'escalated']

// A tiny built-in desk, used only if the template file cannot be read.
const FALLBACK = {
  title: 'Jev Firehose', desk: 'A made-up help desk. Every message is synthetic.',
  noise: 0.15, threshold: 0.55, targetAccuracy: 0.95, ratePerSec: 40, concurrency: 8, batch: 2000, llmSecondsPerItem: 2, spamRate: 0.07, seed: 7,
  teams: [
    { id: 'billing', description: 'Payment: a card charged twice, an invoice, a refund, a receipt.', phrases: ['my card was charged twice', 'I need a refund to my card', 'please send the invoice and receipt', 'the payment failed but my card was charged'] },
    { id: 'shipping', description: 'Delivery of a parcel: courier, tracking number, late or lost package.', phrases: ['the parcel is late and tracking is stuck', 'the courier lost my package', 'where is my delivery, the tracking number is dead', 'the package never reached me, the courier says delivered'] },
  ],
}

export function loadDefaults() {
  try {
    const t = JSON.parse(readFileSync(join(HERE, '../template', MARKER), 'utf8'))
    if (Array.isArray(t.teams) && t.teams.length >= 2) return { ...FALLBACK, ...t }
  } catch { /* fall through */ }
  return FALLBACK
}

// ---------------------------------------------------------------------------------------------
// The five questions. Levels and criteria carry plain vocabulary so both live Jev and the offline
// stand-in can read them.
// ---------------------------------------------------------------------------------------------
export const URGENCY = ['no rush, whenever you have time', 'soon, some time this week', 'today, waiting on a reply', 'urgent, blocked right now', 'emergency, losing money every hour']
export const MOOD = ['calm and polite, says thanks', 'annoyed, frustrated or disappointed', 'furious, angry, finds it unacceptable']

export function buildQuestions(cfg) {
  return {
    team: jev.choice(Object.fromEntries(cfg.teams.map((t) => [t.id, t.description])), 'Which team should own this inbox message?'),
    urgency: jev.score(URGENCY, 'How fast does the sender want an answer?'),
    spam: jev.noul('Is this spam, a scam or mass promotion?', {
      true: 'prize, lucky winner, free gift, click a link, crypto, guaranteed profit, cheap offer, seo backlinks, loans, followers',
      false: 'a genuine customer asking for help with a purchase',
    }),
    needs_human: jev.noul('Should a human agent take over this one?', {
      true: 'asks for a manager or a phone call, threatens a formal complaint, a chargeback or a lawyer',
      false: 'a routine request that a standard reply can solve',
    }),
    mood: jev.score(MOOD, 'What is the mood of the sender?'),
  }
}

const OPENERS = [
  ['Hi, thanks for the help, a calm and polite question.', 'Hello and thanks, staying calm here.', 'Hi team, thanks in advance, a polite request.'],
  ['I am frustrated and disappointed.', 'Honestly I am annoyed and disappointed.', 'Getting frustrated and annoyed with this.'],
  ['This is unacceptable, I am furious.', 'I am angry and furious about this.', 'Unacceptable. I am really angry.'],
]
const CLOSERS = [
  ['No rush at all, whenever you have time.', 'Whenever you have time is fine, no rush.'],
  ['Hoping to hear back soon, some time this week.', 'Some time this week would be good, so soon please.'],
  ['Please reply today, I am waiting on this.', 'I am waiting on a reply today.'],
  ['This is urgent, we are blocked right now.', 'Urgent please, I am blocked right now.'],
  ['This is an emergency, we are losing money every hour.', 'Emergency, we are losing money every hour this goes on.'],
]
const HUMAN = ['Please have a manager call me.', 'I want a phone call from a manager.', 'I will file a formal complaint.', 'My lawyer will hear about this.', 'Next step is a chargeback and a formal complaint.']
const CONNECT = ['Also,', 'By the way,', 'On another note,', 'Separately,', 'One more thing,', 'And while I am here,']
const SPAM_OPEN = ['Dear friend,', 'Attention!', 'Hello dear,', 'Greetings!']
const SPAM = [
  'congratulations lucky winner, claim your free gift',
  'click this link to claim your prize',
  'boost your ranking with cheap seo backlinks',
  'earn guaranteed crypto profit, invest with us',
  'cheap offer, buy followers and get a free gift',
  'lucky you, a prize worth millions, click to claim',
  'cheap loans approved fast, click the link',
  'mass promotion deal: seo backlinks and followers',
  'claim your free prize before the offer ends',
  'crypto winner alert, click the link for your gift',
]
const SPAM_CLOSE = ['Act fast.', 'Do not miss out.', 'Limited places.', 'Last chance.']

const sentence = (s) => { s = String(s).trim(); s = s.charAt(0).toUpperCase() + s.slice(1); return /[.!?]$/.test(s) ? s : s + '.' }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
function pickWeighted(rng, w) { let r = rng() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i } return w.length - 1 }
function sample(rng, arr, k) { const pool = arr.slice(), out = []; while (out.length < k && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]); return out }

/**
 * One synthetic message. `noise` (0..1) sets how many phrases from ONE wrong team are mixed in:
 * floor(noise * 3 + rand), capped at the number of true phrases (1 to 3). So 0 adds none, and 1
 * makes every message an even split between its true team and a wrong one.
 */
export function makeMessage(cfg, rng, noise) {
  const nT = cfg.teams.length
  const mood = pickWeighted(rng, [0.55, 0.3, 0.15])
  const urgency = pickWeighted(rng, [0.25, 0.25, 0.22, 0.18, 0.1])
  const human = rng() < (mood === 2 ? 0.45 : 0.12)
  const parts = []
  if (rng() < cfg.spamRate) {
    parts.push({ kind: 'open', text: pick(rng, SPAM_OPEN) })
    for (const p of sample(rng, SPAM, 2 + Math.floor(rng() * 2))) parts.push({ kind: 'spam', text: sentence(p) })
    parts.push({ kind: 'close', text: pick(rng, SPAM_CLOSE) })
    return { truth: nT, distractor: -1, nTrue: 0, nNoise: 0, urgency: 0, mood: 0, human: false, spam: true, parts, text: parts.map((p) => p.text).join(' ') }
  }
  const truth = pickWeighted(rng, cfg.teams.map((t) => t.weight))
  const nTrue = 1 + pickWeighted(rng, [0.25, 0.45, 0.3])
  // Never more wrong-team phrases than true ones: the message is always mostly about its true team.
  const want = Math.min(nTrue, Math.floor(noise * 3 + rng()))
  let distractor = -1
  if (nT > 1) { distractor = Math.floor(rng() * (nT - 1)); if (distractor >= truth) distractor++ }
  const phrasesOf = (t) => (t.phrases.length ? t.phrases : [t.description])
  const own = sample(rng, phrasesOf(cfg.teams[truth]), nTrue).map((p) => ({ kind: 'true', team: truth, text: sentence(p) }))
  const wrong = want && distractor >= 0 ? sample(rng, phrasesOf(cfg.teams[distractor]), want).map((p) => ({ kind: 'noise', team: distractor, text: `${pick(rng, CONNECT)} ${p}.` })) : []
  // The first phrase is always a true one; the rest are shuffled together.
  const rest = own.slice(1).concat(wrong)
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
  parts.push({ kind: 'open', text: pick(rng, OPENERS[mood]) }, own[0], ...rest, { kind: 'close', text: pick(rng, CLOSERS[urgency]) })
  if (human) parts.push({ kind: 'human', text: pick(rng, HUMAN) })
  return { truth, distractor: wrong.length ? distractor : -1, nTrue: own.length, nNoise: wrong.length, urgency, mood, human, spam: false, parts, text: parts.map((p) => p.text).join(' ') }
}

// ---------------------------------------------------------------------------------------------
// Config: clamp everything into range and keep going. Problems become warnings in the pane.
// ---------------------------------------------------------------------------------------------
export function sanitize(raw, defaults = loadDefaults()) {
  const warnings = []
  const src = raw && typeof raw === 'object' ? raw : {}
  const num = (key, [lo, hi], int = false) => {
    let v = src[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) { if (v !== undefined) warnings.push(`${key} should be a number, using ${defaults[key]}`); v = defaults[key] }
    if (v < lo || v > hi) { warnings.push(`${key} ${v} is outside ${lo}..${hi}, clamped`); v = Math.min(hi, Math.max(lo, v)) }
    return int ? Math.round(v) : v
  }
  const source = typeof src.source === 'string' && src.source.trim() ? src.source.trim().slice(0, 300) : null
  if (src.source != null && !source) warnings.push('source should be a file name inside the workspace, ignored')
  const textColumn = typeof src.textColumn === 'string' && src.textColumn.trim() ? src.textColumn.trim().slice(0, 80) : null
  const seen = new Set()
  let teams = []
  for (const t of Array.isArray(src.teams) ? src.teams : []) {
    const id = String(t?.id ?? '').trim().slice(0, 28)
    const phrases = (Array.isArray(t?.phrases) ? t.phrases : []).map((p) => String(p ?? '').trim()).filter(Boolean).slice(0, 60)
    if (!id || seen.has(id)) { warnings.push(`a team has a missing or repeated id (${id || 'empty'}), skipped`); continue }
    if (!phrases.length && !source) { warnings.push(`team ${id} has no phrases, skipped`); continue }
    if (!source && phrases.length < LIMITS.phrases) warnings.push(`team ${id} has ${phrases.length} phrases, give it at least ${LIMITS.phrases}`)
    const description = String(t.description ?? '').trim().slice(0, 300)
    if (!description) warnings.push(`team ${id} has no description, Jev will guess from the name`)
    const weight = typeof t.weight === 'number' && t.weight > 0 ? Math.min(10, Math.max(0.1, t.weight)) : 1
    seen.add(id)
    teams.push({ id, description: description || id, phrases, weight })
  }
  if (teams.length > LIMITS.teams[1]) { warnings.push(`${teams.length} teams is over ${LIMITS.teams[1]}, extra teams dropped`); teams = teams.slice(0, LIMITS.teams[1]) }
  if (teams.length < LIMITS.teams[0]) { warnings.push(`need at least ${LIMITS.teams[0]} usable teams, showing the starter desk`); teams = sanitize({ teams: defaults.teams }, FALLBACK).cfg.teams }
  const cfg = {
    title: String(src.title ?? defaults.title).slice(0, 80),
    desk: String(src.desk ?? defaults.desk).slice(0, 200),
    noise: num('noise', LIMITS.noise), threshold: num('threshold', LIMITS.threshold), targetAccuracy: num('targetAccuracy', LIMITS.targetAccuracy),
    ratePerSec: num('ratePerSec', LIMITS.ratePerSec), concurrency: num('concurrency', LIMITS.concurrency, true), batch: num('batch', LIMITS.batch, true),
    llmSecondsPerItem: num('llmSecondsPerItem', LIMITS.llmSecondsPerItem), spamRate: num('spamRate', LIMITS.spamRate),
    seed: Number.isFinite(src.seed) ? Math.floor(src.seed) : defaults.seed, source, textColumn, teams,
  }
  return { cfg, warnings }
}

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d
/** The most likely level of a score answer (falls back to the rounded score). */
export function levelOf(a, max) {
  const e = Object.entries(a?.probabilities ?? {})
  const lv = e.length ? Number(e.reduce((m, x) => (x[1] > m[1] ? x : m))[0]) : Math.round(Number(a?.score ?? 0))
  return Math.max(0, Math.min(max, Number.isFinite(lv) ? lv : 0))
}
function slimAnswer(a) {
  if (!a || typeof a !== 'object') return a
  const out = { type: a.type }
  if (a.type === 'noul') out.noul = round(Number(a.noul ?? 0.5))
  else {
    if (a.type === 'choice') out.choice = a.choice; else { out.score = round(Number(a.score ?? 0)); out.legend = a.legend }
    out.confidence = round(Number(a.confidence ?? 0))
    out.probabilities = Object.fromEntries(Object.entries(a.probabilities ?? {}).map(([k, v]) => [k, round(Number(v))]))
  }
  return out
}

export async function startFirehoseViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const file = join(workspace, MARKER)
  const DEFAULTS = loadDefaults()

  // Every piece of mutable state is declared here, BEFORE the first function call that can touch
  // it (no temporal-dead-zone surprises inside a try/catch).
  let cfg = sanitize(DEFAULTS, DEFAULTS).cfg
  let warnings = []
  let cfgError = null
  let cfgRev = 0
  let lastText = null
  let override = { noise: null, threshold: null }
  let questions = buildQuestions(cfg)
  let wireLen = JSON.stringify(toWire(questions)).length
  let running = true, stopped = false
  let phase = 'run', summary = null, summaryTimer = null
  let batchNo = 0, batchRev = 0, rng = mulberry32(1)
  let N = 0, launched = 0, inflight = 0, credit = 0, burstLeft = 0, pumping = false
  let cap = 0, T = null, C = null, Q = null, S = null, D = null, M = null, U = null
  let records = new Map()
  let counts = [], rights = [], confusion = []
  let urgent = 0, humans = 0, angry = 0
  let tokens = 0, costUsd = 0, elapsedMs = 0, lastPumpAt = performance.now()
  let doneTimes = []
  let sentN = 0, lastSampleAt = 0, lastVerdictAt = 0, verdictDirty = true
  let jevError = null, jevErrors = 0, backoffUntil = 0
  let client = 'mock', lastLatencyMs = 0
  let totals = { messages: 0, costUsd: 0, batches: 0, elapsedMs: 0 }
  let lastBatch = null
  // "your data" mode
  let own = false, src = null, srcError = null, srcStamp = null, lastRaw = null
  let itemOfRow = new Int32Array(0), rowOfItem = new Int32Array(0), tails = [], tries = new Uint8Array(0)
  let nextRow = 0, retry = [], qSum = 0
  let csvDirty = false, lastCsvAt = 0, csvWrites = 0, csvError = null
  let server = null
  let pumpTimer = null, frameTimer = null, pollTimer = null
  const waiters = []

  const nT = () => cfg.teams.length
  const thr = () => override.threshold ?? cfg.threshold
  const noise = () => override.noise ?? cfg.noise
  const batchSize = () => (own ? src.rows.length : cfg.batch)
  const SPAMB = () => nT()        // bucket index of the spam bin (also the truth index of spam)
  const ESCB = () => nT() + 1     // bucket index of the escalate lane

  function bucketOf(i, threshold = thr()) {
    if (S[i] >= 128) return nT()
    return Q[i] < Math.round(threshold * 1000) ? nT() + 1 : C[i]
  }

  function alloc() {
    cap = batchSize() + 8
    T = new Uint8Array(cap); C = new Uint8Array(cap); Q = new Uint16Array(cap); S = new Uint8Array(cap)
    D = new Uint8Array(cap); M = new Uint8Array(cap); U = new Uint8Array(cap)
  }

  function clearStats() {
    const n = nT()
    counts = new Array(n + 2).fill(0); rights = new Array(n + 2).fill(0)
    confusion = Array.from({ length: n + 1 }, () => new Array(n + 2).fill(0))
  }
  function addStat(i, sign) {
    const b = bucketOf(i)
    counts[b] += sign
    if (b === T[i]) rights[b] += sign
    confusion[T[i]][b] += sign
  }
  function recount() { clearStats(); for (let i = 0; i < N; i++) addStat(i, 1) }

  function stats() {
    const esc = counts[ESCB()] ?? 0
    const routed = N - esc
    let right = 0
    for (let b = 0; b <= nT(); b++) right += rights[b] ?? 0
    let rN = 0, rRight = 0, rEsc = 0
    for (let i = Math.max(0, N - 300); i < N; i++) { const b = bucketOf(i); rN++; if (b === ESCB()) rEsc++; else if (b === T[i]) rRight++ }
    const base = {
      done: N, batch: batchSize(), routed, escalated: esc, spamBin: counts[SPAMB()] ?? 0, escalatedPct: N ? esc / N : 0,
      recentEscalatedPct: rN ? rEsc / rN : 0, bins: counts.slice(), answers: N * 5, urgent, humans, angry,
    }
    // Your data has no ground truth, so there is nothing to call right or wrong.
    if (own) return { ...base, routedPct: N ? routed / N : 0, meanConfidence: N ? qSum / N / 1000 : null }
    return { ...base, right, accuracy: routed ? right / routed : null, recentAccuracy: rN - rEsc ? rRight / (rN - rEsc) : null, binRight: rights.slice() }
  }

  /** Accuracy and escalation share at every threshold 0.00..1.00, from the batch so far. */
  function sweep() {
    const cnt = new Array(101).fill(0), ok = new Array(101).fill(0)
    let spamRouted = 0, spamRight = 0
    for (let i = 0; i < N; i++) {
      if (S[i] >= 128) { spamRouted++; if (T[i] === nT()) spamRight++; continue }
      const b = Math.min(100, Math.floor(Q[i] / 10)); cnt[b]++; if (C[i] === T[i]) ok[b]++
    }
    const out = new Array(101)
    let routed = spamRouted, right = spamRight
    for (let j = 100; j >= 0; j--) {
      routed += cnt[j]; right += ok[j]
      out[j] = own ? { threshold: j / 100, escalatedPct: N ? (N - routed) / N : 0 } : { threshold: j / 100, accuracy: routed ? right / routed : null, escalatedPct: N ? (N - routed) / N : 0 }
    }
    return out
  }
  function suggestThreshold() {
    if (own || N < 50) return null
    return sweep().find((p) => p.accuracy != null && p.accuracy >= cfg.targetAccuracy) ?? null
  }

  function startBatch(first = false) {
    clearTimeout(summaryTimer)
    if (!first) batchNo++
    batchRev++
    rng = mulberry32((cfg.seed | 0) + batchNo * 7919 + 1)
    N = 0; launched = 0; credit = 0; burstLeft = 0; sentN = 0
    urgent = 0; humans = 0; angry = 0
    tokens = 0; costUsd = 0; elapsedMs = 0; doneTimes = []
    records = new Map()
    phase = 'run'; summary = null
    nextRow = 0; retry = []; qSum = 0
    if (own) { itemOfRow = new Int32Array(src.rows.length).fill(-1); rowOfItem = new Int32Array(src.rows.length + 8); tries = new Uint8Array(src.rows.length); csvDirty = true }
    alloc(); clearStats()
    lastPumpAt = performance.now()
    verdictDirty = true
  }

  const sourceStampNow = () => {
    if (!cfg.source) return null
    const f = resolve(workspace, cfg.source)
    if (!f.startsWith(workspace + sep)) return null
    try { const st = statSync(f); return `${st.mtimeMs}:${st.size}` } catch { return null }
  }
  function loadOwn() {
    own = false; src = null; srcError = null; tails = []; srcStamp = sourceStampNow()
    if (!cfg.source) return
    const r = loadSource(workspace, cfg.source, { textColumn: cfg.textColumn ?? undefined })
    if (r.error) {
      srcError = clean(`${r.error}. Showing the synthetic starter desk until it is fixed.`)
      // Teams written for a source may have no phrases, and the generator needs phrases.
      if (cfg.teams.some((t) => !t.phrases.length)) cfg = { ...cfg, teams: sanitize({ teams: DEFAULTS.teams }, DEFAULTS).cfg.teams }
      return
    }
    src = r; own = true
    const clash = new Set(TRIAGE_COLUMNS)
    src.header = TRIAGE_COLUMNS.concat(r.info.columns.map((c) => (clash.has(c.toLowerCase()) ? `source_${c}` : c)))
    if (r.info.truncated && !warnings.some((w) => w.includes('only the first'))) warnings.push(`${cfg.source} has more than ${SOURCE_LIMITS.messages} messages, only the first ${r.rows.length} are triaged`)
  }
  /** Run again: read the person's file afresh (it may have changed, or gone). */
  function reloadOwn() {
    if (lastRaw) cfg = sanitize(lastRaw, DEFAULTS).cfg
    loadOwn()
    questions = buildQuestions(cfg)
    wireLen = JSON.stringify(toWire(questions)).length
  }
  function applyConfig(raw) {
    lastRaw = raw
    const s = sanitize(raw, DEFAULTS)
    cfg = s.cfg; warnings = s.warnings; cfgError = null; cfgRev++
    loadOwn()
    // (questions are built below, after the mode and its teams are known)
    override = { noise: null, threshold: null }   // a file edit always wins over the pane sliders
    questions = buildQuestions(cfg)
    wireLen = JSON.stringify(toWire(questions)).length
    batchNo = 0
    totals = { messages: 0, costUsd: 0, batches: 0, elapsedMs: 0 }
    lastBatch = null
    startBatch(true)
  }

  function reload() {
    if (stopped) return
    let text
    try { text = readFileSync(file, 'utf8') } catch { return }   // missing file: the last good config stands
    if (text === lastText) {
      // the config did not change, but the person may have replaced their messages file
      if (!cfgError && lastRaw && cfg.source && sourceStampNow() !== srcStamp) { applyConfig(lastRaw); pushFull() }
      return
    }
    lastText = text
    let raw
    try { raw = JSON.parse(text) } catch (e) { cfgError = clean(`${MARKER}: ${e.message}`); verdictDirty = true; pushFull(); return }
    applyConfig({ ...DEFAULTS, ...raw })
    pushFull()
  }

  function record(msg, res, rev) {
    if (rev !== batchRev || N >= cap) return            // the config changed while this call was in flight
    const a = res.answers
    const i = N
    const ci = cfg.teams.findIndex((t) => t.id === a.team?.choice)
    C[i] = ci < 0 ? 0 : ci
    // Synthetic: T is the true team. Your data: there is no truth, T is only the display class.
    T[i] = msg.own ? (Number(a.spam?.noul ?? 0) * 255 >= 127.5 ? nT() : C[i]) : msg.truth
    Q[i] = Math.max(0, Math.min(1000, Math.round(Number(a.team?.confidence ?? 0) * 1000)))
    S[i] = Math.max(0, Math.min(255, Math.round(Number(a.spam?.noul ?? 0) * 255)))
    D[i] = msg.own || msg.distractor < 0 ? 255 : msg.distractor
    M[i] = msg.own ? (msg.failed ? 255 : 0) : msg.nTrue | (msg.nNoise << 2)
    if (msg.own) { S[i] = T[i] === nT() ? Math.max(128, S[i]) : Math.min(127, S[i]); itemOfRow[msg.rowIndex] = i; rowOfItem[i] = msg.rowIndex; qSum += Q[i]; csvDirty = true }
    const urg = levelOf(a.urgency, 4)
    const hum = Number(a.needs_human?.noul ?? 0) >= 0.5 ? 1 : 0
    const md = levelOf(a.mood, 2)
    U[i] = urg | (hum << 3) | (md << 4)
    if (urg >= 3) urgent++
    if (hum) humans++
    if (md >= 2) angry++
    N++
    addStat(i, 1)
    const tok = msg.failed ? 0 : Number(res.usage?.input_tokens) > 0 ? Number(res.usage.input_tokens) : Math.ceil((JSON.stringify(msg.text).length + wireLen) / 4)
    tokens += tok
    costUsd = (tokens * PRICE_PER_MTOK) / 1e6
    client = res.client; lastLatencyMs = res.latencyMs
    if (msg.own) {
      const row = src.rows[msg.rowIndex]
      records.set(i, {
        id: i, own: true, row: row.row, sourceId: row.id, text: msg.text, failed: !!msg.failed, latencyMs: round(res.latencyMs, 2), tokens: tok,
        fields: src.info.columns.map((c, k) => [c, String(row.cells[k]).slice(0, 80)]).filter(([c, v]) => c !== src.info.textColumn && v !== '').slice(0, 6),
        answers: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, slimAnswer(v)])),
      })
    } else records.set(i, {
      id: i, batchNo, text: msg.text, parts: msg.parts, truth: msg.truth, distractor: msg.distractor, nTrue: msg.nTrue, nNoise: msg.nNoise,
      truthUrgency: msg.urgency, truthMood: msg.mood, truthHuman: msg.human, latencyMs: round(res.latencyMs, 2), tokens: tok,
      answers: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, slimAnswer(v)])),
    })
    if (!own && records.size > KEEP_RECORDS) records.delete(i - KEEP_RECORDS)
    const now = performance.now()
    doneTimes.push(now)
    while (doneTimes.length && now - doneTimes[0] > 2000) doneTimes.shift()
    verdictDirty = true
    if (N >= batchSize()) finishBatch()
  }

  function viewRecord(i) {
    const r = records.get(i)
    if (!r || i >= N) return null
    const b = bucketOf(i)
    if (own) return { ...r, choice: C[i], confidence: Q[i] / 1000, bucket: b, threshold: thr() }
    return { ...r, choice: C[i], confidence: Q[i] / 1000, bucket: b, right: b === ESCB() ? null : b === T[i], threshold: thr() }
  }

  function finishBatch() {
    const s = stats()
    if (own) {
      // Your data is triaged once. The summary stays until the person runs it again.
      summary = {
        own: true, batchNo: batchNo + 1, messages: N, elapsedMs: Math.round(elapsedMs), costUsd, tokens, routed: s.routed, escalated: s.escalated, escalatedPct: s.escalatedPct,
        spamBin: s.spamBin, meanConfidence: s.meanConfidence, threshold: thr(), answers: N * 5, output: OUTPUT_FILE, source: src.info.name,
        llmWouldBeOn: Math.min(N, Math.floor(elapsedMs / 1000 / cfg.llmSecondsPerItem) + 1),
      }
      lastBatch = summary
      totals = { messages: totals.messages + N, costUsd: totals.costUsd + costUsd, batches: totals.batches + 1, elapsedMs: totals.elapsedMs + elapsedMs }
      phase = 'done'; verdictDirty = true; burstLeft = 0
      flushCsv(true)
      return
    }
    summary = {
      batchNo: batchNo + 1, messages: N, elapsedMs: Math.round(elapsedMs), costUsd, tokens, accuracy: s.accuracy, escalatedPct: s.escalatedPct,
      routed: s.routed, right: s.right, escalated: s.escalated, noise: noise(), threshold: thr(), answers: N * 5,
      llmWouldBeOn: Math.min(N, Math.floor(elapsedMs / 1000 / cfg.llmSecondsPerItem) + 1), suggested: suggestThreshold(),
    }
    lastBatch = summary
    totals = { messages: totals.messages + N, costUsd: totals.costUsd + costUsd, batches: totals.batches + 1, elapsedMs: totals.elapsedMs + elapsedMs }
    phase = 'summary'
    verdictDirty = true
    clearTimeout(summaryTimer)
    if (running) summaryTimer = setTimeout(nextBatch, SUMMARY_MS)
  }
  /** The threshold moved after the file was done: the kept summary card must show the new split. */
  function refreshOwnSummary() {
    if (!own || phase !== 'done' || !summary) return
    const st = stats()
    Object.assign(summary, { routed: st.routed, escalated: st.escalated, escalatedPct: st.escalatedPct, spamBin: st.spamBin, threshold: thr() })
  }
  function nextBatch() {
    if (stopped || phase !== 'summary') return
    startBatch()
    pushFull()
  }

  /**
   * triage.csv: one line per finished message, in the order of the person's file. Written atomically
   * (temp file, then rename), at most about once a second, and once more at the end.
   */
  function writeCsv() {
    if (!own || !src) return
    const teams = cfg.teams, esc = ESCB()
    if (tails.length !== src.rows.length) tails = src.rows.map((r) => (r.cells.length ? ',' + csvLine(r.cells) : ''))
    const lines = [csvLine(src.header)]
    for (let r = 0; r < src.rows.length; r++) {
      const i = itemOfRow[r]
      if (i < 0 || i >= N) continue
      const failed = M[i] === 255
      lines.push(csvLine([
        src.rows[r].id, failed ? '' : teams[C[i]]?.id ?? '', failed ? '' : (Q[i] / 1000).toFixed(3), failed ? '' : URGENCY_WORD[U[i] & 7] ?? '',
        failed ? '' : S[i] >= 128 ? 'yes' : 'no', failed ? '' : (U[i] >> 3) & 1 ? 'yes' : 'no', failed ? '' : MOOD_WORD[(U[i] >> 4) & 3] ?? '', bucketOf(i) === esc ? 'yes' : 'no',
      ]) + tails[r])
    }
    const out = join(workspace, OUTPUT_FILE)
    try { writeFileSync(out + '.tmp', lines.join('\n') + '\n'); renameSync(out + '.tmp', out); csvWrites++; csvError = null } catch (e) { csvError = clean(`cannot write ${OUTPUT_FILE}: ${e.code ?? e.message}`) }
  }
  function flushCsv(force = false) {
    if (!own || !csvDirty) return
    const now = performance.now()
    if (!force && now - lastCsvAt < 1000) return
    lastCsvAt = now; csvDirty = false
    writeCsv()
    verdictDirty = true
  }

  async function decideOne() {
    if (stopped) return false
    if (phase === 'done') return false
    if (phase === 'summary') { startBatch(); pushFull() }
    if (launched >= batchSize()) return false
    const rev = batchRev
    const idx = launched++
    let msg
    if (own) { const rowIndex = retry.length ? retry.shift() : nextRow++; msg = { own: true, rowIndex, text: src.rows[rowIndex].text } } else msg = makeMessage(cfg, rng, noise())
    inflight++
    try {
      const res = await evaluate({ state: msg.text, questions, salt: (cfg.seed | 0) + batchNo * 7919 + idx, model: process.env.JEV_MODEL || 'jev-latest' })
      jevError = null
      record(msg, res, rev)
      return true
    } catch (e) {
      jevError = clean(e?.message ?? e); jevErrors++
      if (rev === batchRev && msg.own) {
        // Try this message again later. After a few failures it is escalated unanswered, so one bad
        // message can never stall the whole file.
        if (++tries[msg.rowIndex] >= MAX_TRIES) { record({ ...msg, failed: true }, { answers: {}, usage: { input_tokens: 0 }, client, latencyMs: 0 }, rev); return false }
        retry.push(msg.rowIndex)
      }
      if (rev === batchRev) launched--          // this message was never triaged; the batch still completes
      backoffUntil = performance.now() + 1000
      verdictDirty = true
      return false
    } finally {
      inflight--
      const w = waiters.shift(); if (w) w()
    }
  }

  async function pump() {
    if (stopped || pumping) return
    pumping = true
    try {
      const now = performance.now()
      const dt = Math.min(250, now - lastPumpAt)
      lastPumpAt = now
      if (!running || phase !== 'run' || now < backoffUntil) return
      elapsedMs += dt
      credit = Math.min(credit + (dt / 1000) * (burstLeft > 0 ? Math.max(BURST_RATE, cfg.ratePerSec) : cfg.ratePerSec), BURST_RATE / 2)
      while (credit >= 1 && running && phase === 'run' && launched < batchSize() && !stopped && performance.now() >= backoffUntil) {
        if (inflight >= cfg.concurrency) await new Promise((r) => waiters.push(r))
        else { credit--; if (burstLeft > 0) burstLeft--; decideOne() }
      }
      if (launched >= batchSize()) burstLeft = 0
    } finally { pumping = false }
  }

  // ------------------------------------------------------------------------------------------
  // What the pane gets. `full` on connect and on any reset; small `frame`s ten times a second.
  // ------------------------------------------------------------------------------------------
  const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, N * arr.BYTES_PER_ELEMENT).toString('base64')
  function live() {
    const now = performance.now()
    while (doneTimes.length && now - doneTimes[0] > 2000) doneTimes.shift()
    return {
      batchNo: batchNo + 1, rev: batchRev, n: N, batch: batchSize(), elapsedMs: Math.round(elapsedMs), costUsd, tokens,
      mps: doneTimes.length > 1 ? doneTimes.length / Math.max(0.25, (now - doneTimes[0]) / 1000) : 0,
      inflight, running, phase, burstLeft, threshold: thr(), noise: noise(), overrides: { noise: override.noise != null, threshold: override.threshold != null },
      client, lastLatencyMs: round(lastLatencyMs, 2), jevError, jevErrors, own,
    }
  }
  function full() {
    return {
      kind: 'full', ...live(), title: cfg.title, desk: cfg.desk, error: cfgError ?? srcError ?? csvError, warnings,
      source: own ? { name: src.info.name, textColumn: src.info.textColumn, idColumn: src.info.idColumn, columns: src.info.columns, total: src.info.total, used: src.info.used, skipped: src.info.skipped } : null,
      output: own ? { file: OUTPUT_FILE, columns: src.header, writes: csvWrites } : null,
      config: { noise: cfg.noise, threshold: cfg.threshold, targetAccuracy: cfg.targetAccuracy, ratePerSec: cfg.ratePerSec, concurrency: cfg.concurrency, batch: cfg.batch, llmSecondsPerItem: cfg.llmSecondsPerItem, spamRate: cfg.spamRate, seed: cfg.seed },
      teams: cfg.teams.map((t) => ({ id: t.id, description: t.description, phrases: t.phrases.length })),
      questions: Object.keys(questions), urgencyLegend: URGENCY, moodLegend: MOOD,
      stats: stats(), suggested: suggestThreshold(), summary, lastBatch, totals, pricePerMTok: PRICE_PER_MTOK,
      last: N ? viewRecord(N - 1) : null,
      hist: N ? { t: b64(T), c: b64(C), q: b64(Q), s: b64(S), d: b64(D), m: b64(M), u: b64(U) } : null,
    }
  }
  function pushFull() { sentN = N; server?.broadcast(full(), 'state') }
  function pushFrame(force = false) {
    if (!server || (!force && !server.clients.size)) { sentN = N; return }
    const items = []
    for (let i = sentN; i < N; i++) items.push([T[i], C[i], Q[i], S[i], D[i], M[i], U[i]])
    const f = { kind: 'frame', ...live(), from: sentN, items, error: cfgError ?? srcError ?? csvError }
    sentN = N
    const now = performance.now()
    if (N && now - lastSampleAt > 650) { lastSampleAt = now; f.sample = viewRecord(N - 1) }
    if (phase === 'summary' || phase === 'done') f.summary = summary
    server.broadcast(f, 'frame')
  }

  function verdict() {
    const s = stats()
    const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%')
    const sug = suggestThreshold()
    const findings = []
    if (cfgError) findings.push({ severity: 'error', kind: 'config', message: cfgError })
    if (srcError) findings.push({ severity: 'error', kind: 'source', message: srcError })
    if (csvError) findings.push({ severity: 'error', kind: 'output', message: csvError })
    if (own) {
      // Your data: counts and the path of the results file, so the chat agent can pick it up.
      for (const w of warnings) findings.push({ severity: 'warning', kind: 'config', message: w })
      if (jevError) findings.push({ severity: 'error', kind: 'jev', message: jevError })
      const teamCounts = Object.fromEntries(cfg.teams.map((t, i) => [t.id, counts[i] ?? 0]))
      const done = phase === 'done'
      findings.push({ severity: 'info', kind: 'triage', message: `${done ? 'Finished' : 'Working'}: ${N} of ${src.rows.length} messages from ${src.info.name} (text column "${src.info.textColumn}"). ${s.routed - s.spamBin} auto-routed to a team, ${s.spamBin} spam, ${s.escalated} escalated (${pct(s.escalatedPct)}) at threshold ${round(thr(), 2)}. $${costUsd.toFixed(4)}${client === 'mock' ? ' if this were live Jev (offline stand-in now, its answers are word matching, not Jev)' : ''}.` })
      findings.push({ severity: 'info', kind: 'output', message: `Results are in ${OUTPUT_FILE} in the workspace (${csvWrites ? 'written' : 'not written yet'}). Columns: ${src.header.slice(0, 8).join(', ')}, then the file's own columns.` })
      return {
        ready: !cfgError && !csvError && N > 0,
        summary: cfgError ? `${cfg.title} needs a fix in ${MARKER}` : `${cfg.title} · your data · ${N} of ${src.rows.length} messages triaged · ${pct(s.escalatedPct)} escalated · $${costUsd.toFixed(4)} · results in ${OUTPUT_FILE}`,
        findings, artifact: MARKER,
        triage: {
          path: OUTPUT_FILE, file: join(workspace, OUTPUT_FILE), written: csvWrites > 0, complete: done, source: src.info.name, textColumn: src.info.textColumn, idColumn: src.info.idColumn,
          messages: src.rows.length, done: N, autoRouted: s.routed - s.spamBin, spam: s.spamBin, escalated: s.escalated, escalatedPct: round(s.escalatedPct, 4), threshold: thr(),
          meanConfidence: s.meanConfidence == null ? null : round(s.meanConfidence, 3), teams: teamCounts, columns: src.header, client, costUsd: round(costUsd, 6),
        },
        phases: [
          { id: 'stream', name: 'Reading', state: N === 0 ? 'active' : 'done' },
          { id: 'route', name: 'Triage', state: N === 0 ? 'pending' : done ? 'done' : 'active' },
          { id: 'summary', name: 'Results file', state: done ? 'done' : csvWrites ? 'active' : 'pending' },
        ],
      }
    }
    for (const w of warnings) findings.push({ severity: 'warning', kind: 'config', message: w })
    if (jevError) findings.push({ severity: 'error', kind: 'jev', message: jevError })
    if (lastBatch) findings.push({ severity: 'info', kind: 'batch', message: `Batch ${lastBatch.batchNo}: ${lastBatch.messages} synthetic messages in ${(lastBatch.elapsedMs / 1000).toFixed(1)}s for $${lastBatch.costUsd.toFixed(4)}. ${pct(lastBatch.accuracy)} of auto-routed were right, ${pct(lastBatch.escalatedPct)} escalated (noise ${lastBatch.noise}, threshold ${lastBatch.threshold}).` })
    if (N >= 50) {
      findings.push({ severity: s.accuracy != null && s.accuracy < cfg.targetAccuracy ? 'warning' : 'info', kind: 'routing', message: `Now: ${pct(s.accuracy)} right on ${s.routed} auto-routed, ${pct(s.escalatedPct)} escalated, at noise ${round(noise(), 2)} and threshold ${round(thr(), 2)}. Target is ${pct(cfg.targetAccuracy)}.` })
      findings.push(sug
        ? { severity: 'info', kind: 'threshold', message: `Lowest threshold that meets the target on this batch: ${sug.threshold.toFixed(2)} (${pct(sug.accuracy)} right, ${pct(sug.escalatedPct)} escalated).` }
        : { severity: 'warning', kind: 'threshold', message: `No threshold reaches the ${pct(cfg.targetAccuracy)} target on this batch. The noise is too high or the team descriptions overlap.` })
    }
    return {
      ready: !cfgError && !srcError && (N > 0 || totals.messages > 0),
      summary: cfgError ? `${cfg.title} needs a fix in ${MARKER}` : `${cfg.title} · batch ${batchNo + 1} · ${N} of ${cfg.batch} synthetic messages · ${pct(s.accuracy)} right · ${pct(s.escalatedPct)} escalated · $${costUsd.toFixed(4)}`,
      findings, artifact: MARKER,
      phases: [
        { id: 'stream', name: 'Streaming', state: N === 0 ? 'active' : 'done' },
        { id: 'route', name: 'Routing', state: N === 0 ? 'pending' : phase === 'run' ? 'active' : 'done' },
        { id: 'summary', name: 'Batch summary', state: phase === 'summary' ? 'active' : totals.batches ? 'done' : 'pending' },
      ],
    }
  }
  function flushVerdict(force = false) {
    const now = performance.now()
    if (!force && (!verdictDirty || now - lastVerdictAt < 1000)) return
    lastVerdictAt = now; verdictDirty = false
    try { writeVerdict(workspace, verdict()) } catch { /* a read-only workspace must not stop the demo */ }
  }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(summaryTimer) }
    else if (cmd === 'start') { if (!running) { running = true; lastPumpAt = performance.now(); if (phase === 'summary') summaryTimer = setTimeout(nextBatch, 900) } }
    else if (cmd === 'again') { if (cfg.source) reloadOwn(); batchNo = 0; totals = { messages: 0, costUsd: 0, batches: 0, elapsedMs: 0 }; lastBatch = null; running = true; startBatch(true); pushFull(); flushVerdict(true); return { stats: stats() } }
    else if (cmd === 'reset') { if (cfg.source) reloadOwn(); batchNo = 0; totals = { messages: 0, costUsd: 0, batches: 0, elapsedMs: 0 }; lastBatch = null; startBatch(true); pushFull(); flushVerdict(true); return { stats: stats() } }
    else if (cmd === 'tick') {
      const n = Math.max(1, Math.min(5000, Math.floor(Number(body.n) || 1)))
      let did = 0
      for (let k = 0; k < n; k++) if (await decideOne()) did++
      pushFrame(); flushCsv(true); flushVerdict(true)
      return { did, stats: stats(), last: N ? viewRecord(N - 1) : null }
    } else if (cmd === 'threshold' || cmd === 'noise') {
      const v = Number(body.value)
      if (Number.isFinite(v)) { override[cmd] = Math.min(1, Math.max(0, v)); if (cmd === 'threshold') { recount(); csvDirty = true; refreshOwnSummary() } verdictDirty = true }
      pushFrame(true)
      return { threshold: thr(), noise: noise(), stats: stats() }
    } else if (cmd === 'clearOverrides') { override = { noise: null, threshold: null }; recount(); csvDirty = true; refreshOwnSummary(); pushFrame(true); return { threshold: thr(), noise: noise(), stats: stats() } }
    else if (cmd === 'burst') { if (phase === 'done') return { burstLeft: 0 }; burstLeft = Math.min(5000, burstLeft + Math.max(1, Math.min(2000, Math.floor(Number(body.n) || 500)))); if (phase === 'summary' && running) nextBatch(); return { burstLeft } }
    else if (cmd === 'inspect') { return { record: viewRecord(Math.floor(Number(body.id))) } }
    else if (cmd === 'bin') {
      const b = Math.floor(Number(body.bucket)), list = []
      if (own) {
        // No truth to score against: show the most and the least confident message in this bucket.
        let hi = -1, lo = -1
        const m = (i) => (b === SPAMB() ? S[i] * 4 : Q[i])
        for (let i = 0; i < N; i++) if (bucketOf(i) === b) { if (hi < 0 || m(i) > m(hi)) hi = i; if (lo < 0 || m(i) < m(lo)) lo = i }
        const brief = (i) => (i < 0 ? null : { id: i, text: (records.get(i)?.text ?? '').slice(0, 220), confidence: Q[i] / 1000, spam: round(S[i] / 255, 2) })
        for (let i = N - 1; i >= 0 && list.length < 5; i--) if (bucketOf(i) === b) list.push({ id: i, text: (records.get(i)?.text ?? '').slice(0, 120), confidence: Q[i] / 1000 })
        return { bucket: b, own: true, count: counts[b] ?? 0, most: brief(hi), least: hi === lo ? null : brief(lo), list }
      }
      for (let i = N - 1; i >= 0 && i >= N - KEEP_RECORDS && list.length < 6; i--) if (bucketOf(i) === b) { const r = records.get(i); if (r) list.push({ id: i, text: r.parts.filter((x) => x.kind !== 'open').map((x) => x.text).join(' ').slice(0, 120), truth: T[i], confidence: Q[i] / 1000, right: b === ESCB() ? null : b === T[i] }) }
      return { bucket: b, list }
    } else if (cmd === 'sweep') return { sweep: sweep(), suggested: suggestThreshold() }
    else return { unknown: true }
    pushFrame(true); flushVerdict(true)
    return { running, phase }
  }

  // Boot. The kit watcher gives a fast trigger; the one-second poll also catches an editor that
  // replaces the file (write + rename), which a plain file watch can miss.
  const watcher = watchConfig(file, DEFAULTS, () => reload())
  try { lastText = readFileSync(file, 'utf8') } catch { lastText = null }
  cfgError = watcher.error()
  applyConfig(cfgError ? DEFAULTS : watcher.get())
  if (watcher.error()) cfgError = watcher.error()

  server = await serveViewer({ here: HERE, port, state: full, control })
  pumpTimer = setInterval(pump, 25)
  frameTimer = setInterval(() => { if (N !== sentN || running) pushFrame(); flushCsv(); flushVerdict() }, FRAME_MS)
  pollTimer = setInterval(reload, 1000)
  flushVerdict(true)

  return {
    url: server.url,
    async close() {
      stopped = true
      clearInterval(pumpTimer); clearInterval(frameTimer); clearInterval(pollTimer); clearTimeout(summaryTimer)
      for (const w of waiters.splice(0)) w()
      watcher.close()
      await server.close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startFirehoseViewer({ workspace, port })
  console.log(`Jev Firehose listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
