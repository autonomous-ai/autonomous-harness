// Jev Compactor viewer — a loopback server that runs a made-up coding-agent session and lets Jev
// (TypeSafe's System One model) compact its context window.
//
// A seeded generator streams events into a context window: user messages, assistant messages and
// tool results (Read, Grep, Bash, Edit, WebFetch). Every tool result secretly belongs to one task,
// or is pure junk (logs, lockfiles, test spam). That hidden label is the ground truth.
//
// When the window passes the budget (or the person presses "Compact now"), Jev judges EVERY tool
// result in as few calls as possible: state = the current task plus the last few messages, and one
// `choice` question per tool result (keep / trim / drop), 100 questions per call. The verdicts are
// applied, and the result is measured against the ground truth: needle recall, junk removed,
// tokens before and after, questions, calls, time and cost.
//
// A second lane runs a simple baseline for contrast ("summarize instead"): when over budget it
// folds the oldest half of its window into one short summary block. It is a toy baseline, not a
// measurement of any real product.
//
// Everything here is synthetic. It is a demo of the idea, not a real compaction plugin.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds session.json (watched live).

import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, toWire, hash01, stems, PRICE_PER_MTOK } from '../toolchain/jev.mjs'
import { serveViewer, writeVerdict, watchConfig, mulberry32, clean } from './kit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const KINDS = ['user', 'assistant', 'Read', 'Grep', 'Bash', 'Edit', 'WebFetch', 'summary']
const TOOLS = ['Read', 'Grep', 'Bash', 'Edit', 'WebFetch']
const VERDICTS = ['keep', 'trim', 'drop']
const CHUNK = 100          // questions per Jev call
const GIST_TOKENS = 300    // for a "gist" result, only about this many tokens at the head matter
const WEAK_PREVIEW = 0.04  // share of real results whose preview shows only boilerplate
const RECENT_MESSAGES = 6  // how many messages go into the shared state
const HOLD_MS = 2400       // after a compaction the stream waits, so the pane can show it

export const DEFAULT = {
  title: 'Jev Compactor',
  description: 'A made-up coding-agent session. Jev judges every tool result and compacts the context in one pass.',
  repo: 'harbor-pay',
  seed: 7,
  budget: 200000,
  trimTo: 400,
  distraction: 0.12,
  eventsPerSec: 4,
  noise: 0.45,
  focus: 0.5,
  target: 0.4,
  recallTarget: 0.9,
  summaryTokens: 1500,
  taskEvery: 200,
  mix: { user: 1, assistant: 2, Read: 7, Grep: 3, Bash: 6, Edit: 3, WebFetch: 2 },
  currentTask: 'refunds',
  tasks: [
    { id: 'refunds', title: 'Fix refund rounding in the ledger', vocabulary: ['refund', 'ledger', 'rounding', 'cents', 'reversal', 'chargeback', 'currency', 'decimal', 'balance', 'payout'] },
    { id: 'webhooks', title: 'Retry failed webhook deliveries', vocabulary: ['webhook', 'delivery', 'retry', 'backoff', 'signature', 'endpoint', 'queue', 'deadletter', 'idempotency', 'timeout'] },
    { id: 'sessions', title: 'Rotate login sessions safely', vocabulary: ['session', 'rotate', 'expiry', 'cookie', 'login', 'oauth', 'scope', 'revoke', 'credential', 'passkey'] },
    { id: 'search', title: 'Speed up invoice search', vocabulary: ['invoice', 'search', 'index', 'query', 'pagination', 'filter', 'cursor', 'latency', 'cache', 'ranking'] },
  ],
}

// Token size per kind: lo * (hi/lo)^(u^skew). Skew > 1 means most results are small, a few are huge.
const SIZE = {
  user: [30, 260, 1], assistant: [60, 700, 1.2],
  Read: [400, 9000, 1.6], Grep: [250, 5000, 1.4], Bash: [300, 16000, 1.7], Edit: [200, 1800, 1], WebFetch: [1500, 30000, 1.5],
  junk: [600, 40000, 1.2],
}
const NEED = { Read: 'detail', Edit: 'detail', Grep: 'gist', Bash: 'gist', WebFetch: 'gist' }

const OPTIONS = {
  keep: 'still needed for the current task, keep it word for word: source code, diffs and exact values about the current task',
  trim: 'about the current task but only the gist matters now, keep the head: long test output, search listings, docs pages',
  drop: 'irrelevant now: other tasks, install logs, lockfiles, generated files, test spam, anything not about the current task',
}

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmt = (n) => Math.round(n).toLocaleString('en-US')
const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// Config: merge over defaults, clamp every number, never throw.
// ---------------------------------------------------------------------------
export function normalize(raw = {}) {
  const problems = []
  const num = (key, lo, hi) => {
    const v = raw[key]
    if (v === undefined) return DEFAULT[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${key} must be a number`); return DEFAULT[key] }
    if (v < lo || v > hi) problems.push(`${key} ${v} is outside ${lo}..${hi}, clamped`)
    return clampN(v, lo, hi)
  }
  const cfg = {
    title: typeof raw.title === 'string' && raw.title ? clean(raw.title).slice(0, 80) : DEFAULT.title,
    description: typeof raw.description === 'string' ? clean(raw.description).slice(0, 300) : DEFAULT.description,
    repo: typeof raw.repo === 'string' && raw.repo ? clean(raw.repo).slice(0, 40) : DEFAULT.repo,
    seed: Math.round(num('seed', 0, 2 ** 31 - 1)),
    budget: Math.round(num('budget', 20000, 2000000)),
    trimTo: Math.round(num('trimTo', 50, 5000)),
    distraction: num('distraction', 0, 1),
    eventsPerSec: num('eventsPerSec', 1, 60),
    noise: num('noise', 0, 0.9),
    focus: num('focus', 0.1, 1),
    target: num('target', 0.2, 0.9),
    recallTarget: num('recallTarget', 0.5, 1),
    summaryTokens: Math.round(num('summaryTokens', 200, 20000)),
    taskEvery: Math.round(num('taskEvery', 0, 5000)),
  }
  // tasks
  let tasks = []
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) problems.push('tasks must be a list')
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    const id = typeof t?.id === 'string' ? t.id.trim().slice(0, 24) : ''
    const words = Array.isArray(t?.vocabulary) ? [...new Set(t.vocabulary.filter((w) => typeof w === 'string').map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((w) => w.length > 1))] : []
    if (!id || words.length < 3) { problems.push(`task "${id || '?'}" needs an id and at least 3 vocabulary words, skipped`); continue }
    if (tasks.some((x) => x.id === id)) { problems.push(`task id "${id}" is used twice, skipped`); continue }
    tasks.push({ id, title: typeof t.title === 'string' && t.title ? clean(t.title).slice(0, 80) : id, vocabulary: words.slice(0, 40) })
  }
  tasks = tasks.slice(0, 12)
  if (tasks.length < 2) {
    if (raw.tasks !== undefined) problems.push('need at least 2 valid tasks, using the built-in ones')
    tasks = DEFAULT.tasks.map((t) => ({ ...t, vocabulary: [...t.vocabulary] }))
  }
  cfg.tasks = tasks
  cfg.currentTask = tasks.some((t) => t.id === raw.currentTask) ? raw.currentTask : tasks[0].id
  if (raw.currentTask !== undefined && cfg.currentTask !== raw.currentTask) problems.push(`currentTask "${raw.currentTask}" is not a task id, using "${cfg.currentTask}"`)
  // event mix
  const mix = {}
  const rawMix = raw.mix && typeof raw.mix === 'object' && !Array.isArray(raw.mix) ? raw.mix : {}
  for (const k of Object.keys(DEFAULT.mix)) {
    const v = rawMix[k]
    mix[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 1000) : DEFAULT.mix[k]
    if (v !== undefined && mix[k] !== v) problems.push(`mix.${k} must be a number from 0 up`)
  }
  if (!TOOLS.some((k) => mix[k] > 0)) { problems.push('mix needs at least one tool with weight above 0'); Object.assign(mix, DEFAULT.mix) }
  cfg.mix = mix
  return { cfg, problems }
}

// ---------------------------------------------------------------------------
// The offline stand-in for Jev. It reads ONLY what live Jev gets: the shared state text and the
// question text. It counts how many words of the tool result's preview also appear in the current
// task (title + keywords, and the recent messages at a lower weight), and looks at the shape of the
// text (code-like, or bulk output) to split keep from trim. No hidden labels are read here.
// ---------------------------------------------------------------------------
const DETAIL_CUES = new Set(['function', 'const', 'return', 'export', 'throw', 'class', 'interface', 'import'])
const BULK_CUES = new Set(['match', 'matches', 'passed', 'pass', 'tests', 'test', 'lines', 'output', 'page', 'docs', 'sections', 'words', 'warn', 'debug', 'info', 'packages', 'log', 'layer'])
const KIND_PRIOR = { Read: 0.6, Edit: 1.2, Grep: -1.0, Bash: -1.0, WebFetch: -1.2 }
const sigmoid = (x) => 1 / (1 + Math.exp(-x))

let ctxCacheKey = null, ctxCache = null
function readState(text) {
  if (text === ctxCacheKey) return ctxCache
  const task = /CURRENT TASK:\s*(.*)/.exec(text)?.[1] ?? ''
  const keys = /TASK KEYWORDS:\s*(.*)/.exec(text)?.[1] ?? ''
  const recent = text.split('RECENT MESSAGES:')[1] ?? ''
  const strong = new Set(stems(`${task} ${keys}`))
  const weak = new Set(stems(recent).filter((w) => !strong.has(w)))
  ctxCacheKey = text; ctxCache = { strong, weak }
  return ctxCache
}

export function compactorMock(stateText, id, q) {
  if (q.type !== 'choice' || !q.options?.includes('keep')) return null
  const m = /^\[(\w+)\]\s+(.*?)\s+·\s+([\d,]+) tokens\. Preview: «([\s\S]*?)»/.exec(q.instructions ?? '')
  if (!m) return null
  const kind = m[1], tokens = Number(m[3].replace(/,/g, '')), body = `${m[2]} ${m[4]}`
  const { strong, weak } = readState(stateText)
  const words = new Set(stems(body))
  let hits = 0, detail = 0, bulk = 0
  for (const w of words) {
    if (strong.has(w)) hits += 1
    else if (weak.has(w)) hits += 0.15
  }
  for (const w of String(m[4]).toLowerCase().split(/[^a-z]+/)) {
    if (DETAIL_CUES.has(w)) detail++
    else if (BULK_CUES.has(w)) bulk++
  }
  const j1 = (hash01(`${id}|${m[4].slice(0, 80)}`, 11) - 0.5) * 0.5
  const j2 = (hash01(`${id}|${m[4].slice(0, 80)}`, 29) - 0.5) * 0.5
  const pRel = sigmoid(1.3 * (hits - 2.6) + j1)
  const pKeepIfRel = sigmoid(0.9 * (Math.min(detail, 5) - Math.min(bulk, 5)) + (KIND_PRIOR[kind] ?? 0) - (tokens > 12000 ? 0.5 : 0) + j2)
  let p = [pRel * pKeepIfRel, pRel * (1 - pKeepIfRel), 1 - pRel].map((v) => Math.max(0.012, v))
  const sum = p[0] + p[1] + p[2]
  p = p.map((v) => v / sum)
  const bi = p.indexOf(Math.max(...p))
  return { type: 'choice', choice: VERDICTS[bi], confidence: p[bi], probabilities: { keep: p[0], trim: p[1], drop: p[2] } }
}

// ---------------------------------------------------------------------------
// Text generation. Real results are written with the words of their task. Junk is written with
// junk words, and borrows words of the current task with probability `distraction`.
// ---------------------------------------------------------------------------
const JUNK_WORDS = ['inflight', 'rimraf', 'glob', 'chalk', 'yargs', 'minimist', 'semver', 'lodash', 'uuid', 'mkdirp', 'ansi', 'kleur', 'picocolors', 'tslib', 'wrappy', 'once', 'brace', 'concat', 'isarray', 'supports', 'escape', 'strip', 'emoji', 'polyfill', 'shim', 'legacy', 'vendor', 'bundle', 'chunk', 'runtime']

function makeTexts(kind, rng, w, n) {
  const N = (lo, hi) => Math.round(lo + rng() * (hi - lo))
  switch (kind) {
    case 'Read': { const a = w(), b = w(), c = w(), d = w()
      return { label: `src/${a}/${b}_${c}.ts`, preview: `export function apply_${a}(${b}, ${c}) { const ${d} = ${w()}.${w()}_${w()}(${b}); if (!${d}) throw new Error("bad ${w()}"); return ${d} }` } }
    case 'Edit': { const a = w(), b = w(), c = w(), d = w()
      return { label: `src/${a}/${b}.ts`, preview: `@@ -${N(20, 400)},7 +${N(20, 400)},9 @@ function ${a}_${b}(${c}) { - return ${c}.${w()} + const ${d} = ${c}.${w()}(${w()}); + return ${d} // fix ${w()}` } }
    case 'Grep': { const a = w()
      return { label: `grep "${a}" src/`, preview: `${N(8, 90)} matches for "${a}" in src/: src/${w()}/${w()}.ts:${N(3, 400)} ${w()}_${w()} · src/${w()}/${w()}.ts:${N(3, 400)} ${w()} · test/${w()}.test.ts:${N(3, 200)} … ${fmt(n / 9)} more lines` } }
    case 'Bash': { const a = w(), b = w()
      return { label: `npm test -- ${a}`, preview: `PASS test/${a}/${b}_${w()}.test.ts (${N(20, 900)} ms) ✓ ${w()} ${w()} ✓ ${w()} handles ${w()} ✓ ${w()} edge case · Tests: ${N(6, 80)} passed · output ${fmt(n / 9)} lines` } }
    default: { const a = w(), b = w()
      return { label: `https://docs.example.test/${a}/${b}`, preview: `Docs page: ${a} ${b} guide. Overview of ${w()}, ${w()} and ${w()}. Sections: ${w()}, ${w()}, ${w()}. Page text ${fmt(n * 0.7)} words` } }
  }
}

function makeWeak(kind, w) {
  if (kind === 'Read' || kind === 'Edit') return { label: `src/${w()}/index.ts`, preview: '// Copyright (c) Example Co. SPDX-License-Identifier: MIT · import { z } from "zod" · import { db } from "../db" · import type { Ctx } from "../ctx" · (the useful part is further down)' }
  if (kind === 'WebFetch') return { label: `https://docs.example.test/${w()}`, preview: 'Skip to content · Docs home · Version 4.2 · On this page · Edit this page · Was this helpful? · (the useful part is further down)' }
  return { label: kind === 'Grep' ? `grep "${w()}" .` : 'npm test', preview: '> harbor@1.0.0 pretest · tsc --noEmit · > harbor@1.0.0 test · vitest run --reporter=basic · (the useful part is further down)' }
}

function makeJunk(kind, rng, j, n) {
  const N = (lo, hi) => Math.round(lo + rng() * (hi - lo))
  const v = Math.floor(rng() * 2)
  if (kind === 'Read') {
    return v === 0
      ? { label: 'package-lock.json', preview: `"node_modules/${j()}-${j()}": { "version": "4.3.0", "resolved": "https://registry.example.test/${j()}/-/${j()}-4.3.0.tgz", "integrity": "sha512-Qm9x" }, "node_modules/${j()}-${j()}": { "version": "2.0.1", "dev": true, "requires": { "${j()}": "^1.2.0", "${j()}": "^3.0.0" } }` }
      : { label: 'dist/vendor.min.js', preview: `!function(e,t){"use strict";var ${j()}=function(${j()}){return ${j()}.default};const ${j()}=t.${j()};export function ${j()}(${j()},${j()}){return e}}(this)` }
  }
  if (kind === 'Bash') {
    return v === 0
      ? { label: 'npm install', preview: `npm WARN deprecated ${j()}@1.0.6 · npm WARN deprecated ${j()}-${j()}@2.7.1 · added ${fmt(N(400, 1900))} packages in ${N(9, 80)}s · postinstall ${j()} ${j()} ok · audited ${j()} ${j()} ${j()} · ${N(40, 300)} packages are looking for funding` }
      : { label: 'npm test -- legacy', preview: `PASS test/legacy/${j()}_${j()}.test.ts ✓ handles empty ${j()} (2 ms) ✓ handles null ${j()} ✓ snapshot ${j()} · console.log DEBUG heartbeat ${j()} ${j()} ${j()} · Tests: ${fmt(N(600, 2400))} passed · output ${fmt(n / 9)} lines` }
  }
  if (kind === 'Grep') return { label: 'grep -r "TODO" .', preview: `${fmt(N(900, 6000))} matches in node_modules/: node_modules/${j()}/lib/${j()}.js:12 · node_modules/${j()}/${j()}.js:88 · node_modules/${j()}/dist/${j()}.cjs:4 · ${j()} ${j()} … ${fmt(n / 9)} more lines` }
  if (kind === 'Edit') return { label: 'src/gen/schema.generated.ts', preview: `// AUTO-GENERATED, do not edit. export interface ${j()}_row { ${j()}: string; ${j()}: number; ${j()}: string | null } export const ${j()}_columns = ["${j()}", "${j()}", "${j()}"] as const` }
  return { label: 'https://blog.example.test/changelog', preview: `Skip to content · Accept cookies · Sign in · Pricing · Careers · Popular posts: ${j()} ${j()} · ${j()} ${j()} · ${j()} ${j()} · Newsletter ${j()} ${j()} · © Example Co` }
}

const USER_LINES = [
  (w) => `Can you look at the ${w()} ${w()}? The ${w()} is wrong when the ${w()} changes.`,
  (w) => `The ${w()} still fails for ${w()}. Please check how ${w()} reaches the ${w()}.`,
  (w) => `Good. Now cover the ${w()} path too, and keep the ${w()} ${w()} as it is.`,
]
const ASSISTANT_LINES = [
  (w) => `I will open the ${w()} ${w()} code and trace how the ${w()} reaches the ${w()}.`,
  (w) => `Found it: the ${w()} skips the ${w()} step. I will patch the ${w()} and rerun the ${w()} checks.`,
  (w) => `The ${w()} ${w()} now holds. Next I will confirm the ${w()} against the ${w()}.`,
  (w) => `Reading more of the ${w()} module to see where ${w()} and ${w()} meet.`,
]

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------
export async function startCompactorViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const file = join(workspace, 'session.json')

  // Every `let` lives here, above the first call that can touch it (TDZ guard).
  let cfg = normalize({}).cfg
  let cfgProblems = []
  let overrides = {}          // runtime changes from the pane: { budget, distraction, task }
  let rng = mulberry32(1)
  let nextId = 1
  let eventNo = 0
  let currentTask = cfg.tasks[0].id
  let taskSince = 0           // event number when the current task became current
  let window_ = []            // Jev lane, oldest first
  let base = []               // baseline lane, oldest first
  let graveyard = new Map()   // recently removed blocks, for the inspector
  let tokens = 0, baseTokens = 0
  let running = true
  let stopped = false
  let busy = false
  let phase = 'filling'
  let holdUntil = 0
  let timer = null
  let error = null            // Jev call error
  let last = null             // last compaction (Jev lane)
  let history = []
  let totals = null
  let baseStats = null
  let series = []
  let salt = 1
  let client = process.env.TYPESAFE_API_KEY ? 'typesafe' : 'mock'
  let lastBroadcast = 0, broadcastTimer = null
  let lastVerdictWrite = 0
  let rolledOff = 0
  let view = null
  let pinned = new Set()
  let gen = 0                 // bumps on every session reset, so a late Jev answer is ignored
  let retryAt = 0             // after a failed Jev call, wait a little before asking again

  const eff = (k) => (overrides[k] !== undefined ? overrides[k] : cfg[k])
  const taskOf = (id) => cfg.tasks.find((t) => t.id === id) ?? cfg.tasks[0]
  const taskIdx = (id) => cfg.tasks.findIndex((t) => t.id === id)

  function freshTotals() {
    return { compactions: 0, questions: 0, calls: 0, costUsd: 0, inputTokens: 0, ms: 0, needleBefore: 0, needleAfter: 0, junkBefore: 0, junkAfter: 0, tokensBefore: 0, tokensAfter: 0, demoted: 0 }
  }
  function freshBase() {
    return { compactions: 0, needleBefore: 0, needleAfter: 0, lastRecall: null, lastBefore: 0, lastAfter: 0, lastAt: 0, n: 0 }
  }

  function applyConfig(raw, parseErr) {
    const before = cfg
    const r = normalize(raw)
    cfg = r.cfg
    cfgProblems = parseErr ? [parseErr] : r.problems
    overrides = {}
    const structural = !before || before.seed !== cfg.seed || before.repo !== cfg.repo || JSON.stringify(before.tasks) !== JSON.stringify(cfg.tasks) || JSON.stringify(before.mix) !== JSON.stringify(cfg.mix)
    if (structural || !totals) resetSession()
    else if (cfg.currentTask !== currentTask && before.currentTask !== cfg.currentTask) switchTask(cfg.currentTask, 'config')
  }

  function resetSession() {
    gen++
    rng = mulberry32(cfg.seed || 1)
    nextId = 1; eventNo = 0
    window_ = []; base = []; graveyard = new Map(); pinned = new Set()
    tokens = 0; baseTokens = 0
    last = null; history = []; series = []
    totals = freshTotals(); baseStats = freshBase()
    error = null; phase = 'filling'; holdUntil = 0; rolledOff = 0
    currentTask = cfg.tasks.some((t) => t.id === overrides.task) ? overrides.task : cfg.currentTask
    taskSince = 0
    addEvent(makeMessage('user', `Session start in the made-up repo "${cfg.repo}". First task: ${taskOf(currentTask).title}.`))
    // Start with the tank partly full so the first compaction is only a few seconds away.
    let guard = 0
    while (tokens < eff('budget') * 0.62 && guard++ < 5000) addEvent(genEvent())
  }

  // ---- generation --------------------------------------------------------
  function sizeOf(key) {
    const [lo, hi, skew] = SIZE[key]
    return Math.round(lo * (hi / lo) ** (rng() ** skew))
  }
  function wordsOf(task) { const v = task.vocabulary; return () => v[Math.floor(rng() * v.length)] }

  function makeMessage(kind, text) {
    const task = taskOf(currentTask)
    const w = wordsOf(task)
    const lines = kind === 'user' ? USER_LINES : ASSISTANT_LINES
    const preview = text ?? lines[Math.floor(rng() * lines.length)](w)
    return { id: nextId++, kind, label: kind === 'user' ? 'user message' : 'assistant message', preview, tokens: sizeOf(kind), orig: 0, task: task.id, need: 'message', needle: 0, verdict: null, probs: null, demoted: false, born: eventNo }
  }

  function genEvent() {
    const mix = cfg.mix
    const keys = Object.keys(mix)
    const total = keys.reduce((a, k) => a + mix[k], 0)
    let r = rng() * total, kind = keys[keys.length - 1]
    for (const k of keys) { r -= mix[k]; if (r < 0) { kind = k; break } }
    if (kind === 'user' || kind === 'assistant') return makeMessage(kind)
    const cur = taskOf(currentTask)
    const isJunk = rng() < cfg.noise
    if (isJunk) {
      const n = sizeOf('junk')
      const borrow = eff('distraction')
      const cw = wordsOf(cur)
      const j = () => (rng() < borrow ? cw() : JUNK_WORDS[Math.floor(rng() * JUNK_WORDS.length)])
      const t = makeJunk(kind, rng, j, n)
      return { id: nextId++, kind, label: t.label, preview: t.preview, tokens: n, orig: n, task: null, need: 'none', needle: 0, verdict: null, probs: null, demoted: false, born: eventNo }
    }
    const others = cfg.tasks.filter((t) => t.id !== cur.id)
    const task = rng() < cfg.focus || !others.length ? cur : others[Math.floor(rng() * others.length)]
    const n = sizeOf(kind)
    const w = wordsOf(task)
    const t = rng() < WEAK_PREVIEW ? makeWeak(kind, w) : makeTexts(kind, rng, w, n)
    const need = NEED[kind]
    return { id: nextId++, kind, label: t.label, preview: t.preview, tokens: n, orig: n, task: task.id, need, needle: need === 'detail' ? n : Math.min(n, GIST_TOKENS), verdict: null, probs: null, demoted: false, born: eventNo }
  }

  function addEvent(b) {
    eventNo++
    window_.push(b); tokens += b.tokens
    base.push({ id: b.id, kind: b.kind, tokens: b.tokens, needle: b.task && b.needle ? { [b.task]: b.needle } : {} })
    baseTokens += b.tokens
    // Messages are never judged. Very old ones roll off the bottom so the demo can run forever.
    const msgCap = eff('budget') * 0.05
    let msgTokens = 0
    for (const x of window_) if (x.need === 'message') msgTokens += x.tokens
    while (msgTokens > msgCap) {
      const i = window_.findIndex((x) => x.need === 'message')
      if (i < 0) break
      const [gone] = window_.splice(i, 1)
      msgTokens -= gone.tokens; tokens -= gone.tokens; rolledOff++
      bury(gone, 'rolled off (very old message)')
    }
    if (baseTokens > eff('budget')) baselineSummarize()
    pushSeries()
  }

  function pushSeries() {
    series.push([eventNo, tokens, baseTokens])
    if (series.length > 360) series.splice(0, series.length - 360)
  }

  function bury(b, why) {
    graveyard.set(b.id, { ...b, gone: why })
    if (graveyard.size > 600) graveyard.delete(graveyard.keys().next().value)
  }

  function switchTask(id, by) {
    if (!cfg.tasks.some((t) => t.id === id) || id === currentTask) return false
    currentTask = id
    taskSince = eventNo
    const t = taskOf(id)
    const w = wordsOf(t)
    const text = by === 'auto'
      ? `That part is done. Next task: ${t.title}. Focus on the ${w()}, the ${w()} and the ${w()}.`
      : `Change of plan. Work on this now: ${t.title}. Focus on the ${w()}, the ${w()} and the ${w()}.`
    addEvent(makeMessage('user', text))
    return true
  }

  // ---- the baseline lane: "summarize instead" ------------------------------
  function baselineSummarize() {
    const cur = currentTask
    const before = baseTokens
    const needleBefore = base.reduce((a, b) => a + (b.needle[cur] ?? 0), 0)
    let span = 0, cut = 0
    while (cut < base.length - 1 && span < before / 2) { span += base[cut].tokens; cut++ }
    const folded = base.splice(0, cut)
    const size = Math.min(cfg.summaryTokens, span)
    // A summary can only hold what fits in it: each task keeps a share in proportion to its needles.
    const needle = {}
    for (const b of folded) for (const [t, n] of Object.entries(b.needle)) needle[t] = (needle[t] ?? 0) + n
    for (const t of Object.keys(needle)) needle[t] = Math.min(needle[t], (size * needle[t]) / Math.max(1, span))
    base.unshift({ id: `s${++baseStats.n}`, kind: 'summary', tokens: size, needle, folded: folded.length })
    baseTokens = base.reduce((a, b) => a + b.tokens, 0)
    const needleAfter = base.reduce((a, b) => a + (b.needle[cur] ?? 0), 0)
    baseStats.compactions++
    baseStats.needleBefore += needleBefore; baseStats.needleAfter += needleAfter
    baseStats.lastRecall = needleBefore > 0 ? needleAfter / needleBefore : null
    baseStats.lastBefore = before; baseStats.lastAfter = baseTokens; baseStats.lastAt = eventNo
    baseStats.lastFolded = folded.length
  }

  // ---- the Jev lane --------------------------------------------------------
  function stateText() {
    const t = taskOf(currentTask)
    const msgs = window_.filter((b) => b.need === 'message').slice(-RECENT_MESSAGES)
    return [
      `You are compacting the context window of a coding agent working in the made-up repo "${cfg.repo}". The window is over budget.`,
      `CURRENT TASK: ${t.title}`,
      `TASK KEYWORDS: ${t.vocabulary.join(', ')}`,
      'Judge each tool result on its own. Keep what the agent still needs for the CURRENT TASK. Drop the rest.',
      'RECENT MESSAGES:',
      ...msgs.map((m) => `${m.kind}: ${m.preview}`),
    ].join('\n')
  }

  const qid = (b) => `${b.kind}_${b.id}`   // the question key, also what the HUD shows
  function question(b) {
    return jev.choice(OPTIONS, `[${b.kind}] ${b.label} · ${fmt(b.tokens)} tokens. Preview: «${b.preview}» Is this tool result still needed for the current task? Trimming would keep only the first ${fmt(eff('trimTo'))} tokens.`)
  }

  async function compact(trigger = 'budget') {
    if (busy) return null
    busy = true; phase = 'judging'
    try {
      const myGen = gen
      const tools = window_.filter((b) => b.need !== 'message')
      const judged = new Set(tools.map((b) => b.id))
      const cur = currentTask
      const trimTo = eff('trimTo'), budget = eff('budget')
      const before = tokens
      const state = stateText()
      const nCalls = Math.max(1, Math.ceil(tools.length / CHUNK))
      const per = Math.ceil(tools.length / nCalls)
      const chunks = []
      for (let i = 0; i < tools.length; i += per) chunks.push(tools.slice(i, i + per))
      const t0 = performance.now()
      let callTokens = 0
      const results = await Promise.all(chunks.map(async (chunk) => {
        const questions = {}
        for (const b of chunk) questions[qid(b)] = question(b)
        const res = await evaluate({ state, questions, salt: salt++, mock: compactorMock, model: process.env.JEV_MODEL || 'jev-latest' })
        const real = Number(res.usage?.input_tokens)
        callTokens += real > 0 ? real : Math.ceil((JSON.stringify(state).length + JSON.stringify(toWire(questions)).length) / 4)
        client = res.client
        return res
      }))
      const ms = performance.now() - t0
      if (stopped || myGen !== gen) return null

      // Ground truth before.
      const relNeedle = (b) => (b.task === cur ? b.needle : 0)
      const needleBefore = tools.reduce((a, b) => a + relNeedle(b), 0)
      const toolBefore = tools.reduce((a, b) => a + b.tokens, 0)

      // Read the verdicts.
      const answers = Object.assign({}, ...results.map((r) => r.answers))
      for (const b of tools) {
        const a = answers[qid(b)]
        const p = a?.probabilities ?? {}
        b.probs = { keep: Number(p.keep ?? 0), trim: Number(p.trim ?? 0), drop: Number(p.drop ?? 0) }
        b.jev = VERDICTS.includes(a?.choice) ? a.choice : 'keep'   // what Jev said
        b.verdict = pinned.has(b.id) ? 'keep' : b.jev              // what gets applied
        b.demoted = false
      }

      // Pressure pass: the window must end under target * budget. If Jev's verdicts do not get
      // there, the keeps Jev was least sure about are trimmed, then the weakest trims are dropped.
      const sizeAfter = (b) => (b.verdict === 'drop' ? 0 : b.verdict === 'trim' ? Math.min(b.tokens, trimTo) : b.tokens)
      const msgTokens = window_.reduce((a, b) => a + (b.need === 'message' ? b.tokens : 0), 0)
      let projected = msgTokens + tools.reduce((a, b) => a + sizeAfter(b), 0)
      const goal = budget * cfg.target
      let demoted = 0
      if (projected > goal) {
        const keeps = tools.filter((b) => b.verdict === 'keep' && !pinned.has(b.id) && b.tokens > trimTo).sort((x, y) => x.probs.keep - y.probs.keep)
        for (const b of keeps) { if (projected <= goal) break; projected -= b.tokens - trimTo; b.verdict = 'trim'; b.demoted = true; demoted++ }
      }
      if (projected > goal) {
        const trims = tools.filter((b) => b.verdict === 'trim' && !pinned.has(b.id)).sort((x, y) => x.probs.drop - y.probs.drop).reverse()
        for (const b of trims) { if (projected <= goal) break; projected -= sizeAfter(b); b.verdict = 'drop'; b.demoted = true; demoted++ }
      }

      // Apply.
      const verdicts = {}
      const count = { keep: 0, trim: 0, drop: 0 }
      const mistakes = { needlesDropped: 0, needlesTrimmed: 0, junkKept: 0 }
      const kept = []
      for (const b of window_) {
        if (!judged.has(b.id)) { kept.push(b); continue }   // messages, and anything that arrived mid-call
        count[b.verdict]++
        const rel = b.task === cur
        const size = sizeAfter(b)
        verdicts[b.id] = [VERDICTS.indexOf(b.verdict) + 1, +b.probs.keep.toFixed(3), +b.probs.trim.toFixed(3), +b.probs.drop.toFixed(3), b.demoted ? 1 : 0, size]
        if (b.verdict === 'drop') { if (rel) mistakes.needlesDropped++; bury(b, `dropped at compaction ${totals.compactions + 1}`); continue }
        if (b.verdict === 'trim') { if (rel && b.need === 'detail' && b.tokens > trimTo) mistakes.needlesTrimmed++; b.tokens = size; b.needle = Math.min(b.needle, size) }
        if (!rel && b.verdict === 'keep') mistakes.junkKept++
        kept.push(b)
      }
      window_ = kept
      tokens = window_.reduce((a, b) => a + b.tokens, 0)

      // Ground truth after.
      const toolsAfter = window_.filter((b) => b.need !== 'message')
      const needleAfter = toolsAfter.reduce((a, b) => a + relNeedle(b), 0)
      const toolAfter = toolsAfter.reduce((a, b) => a + b.tokens, 0)
      const junkBefore = toolBefore - needleBefore, junkAfter = toolAfter - needleAfter
      const costUsd = (callTokens * PRICE_PER_MTOK) / 1e6

      totals.compactions++
      totals.questions += tools.length; totals.calls += chunks.length; totals.costUsd += costUsd; totals.inputTokens += callTokens; totals.ms += ms
      totals.needleBefore += needleBefore; totals.needleAfter += needleAfter
      totals.junkBefore += junkBefore; totals.junkAfter += junkAfter
      totals.tokensBefore += before; totals.tokensAfter += tokens; totals.demoted += demoted

      last = {
        n: totals.compactions, trigger, task: cur, at: eventNo, wallAt: Date.now(),
        before, after: tokens, reduction: before > 0 ? 1 - tokens / before : 0,
        recall: needleBefore > 0 ? needleAfter / needleBefore : null,
        junkRemoved: junkBefore > 0 ? 1 - junkAfter / junkBefore : null,
        questions: tools.length, calls: chunks.length, perCall: chunks.length ? Math.round(tools.length / chunks.length) : 0,
        ms, costUsd, inputTokens: callTokens, client,
        keep: count.keep, trim: count.trim, drop: count.drop, demoted, ...mistakes, verdicts,
      }
      history.push({ n: last.n, before, after: tokens, reduction: last.reduction, recall: last.recall, ms, questions: tools.length, calls: chunks.length, trigger, task: cur, demoted })
      if (history.length > 40) history.shift()
      pushSeries()
      error = null
      return last
    } catch (e) {
      error = clean(e?.message ?? e)
      retryAt = Date.now() + 5000
      // Safety valve: if Jev cannot be reached the window must not grow forever.
      while (tokens > eff('budget') * 3 && window_.length > 1) { const gone = window_.shift(); tokens -= gone.tokens; bury(gone, 'rolled off (Jev unreachable)') }
      return null
    } finally {
      busy = false
      phase = 'filling'
    }
  }

  /** One decision step: one new event; if that pushes the window over budget, Jev compacts it. */
  async function step({ hold = false } = {}) {
    if (stopped) return
    if (cfg.taskEvery > 0 && eventNo - taskSince >= cfg.taskEvery) {
      const i = taskIdx(currentTask)
      switchTask(cfg.tasks[(i + 1) % cfg.tasks.length].id, 'auto')
    } else addEvent(genEvent())
    if (tokens > eff('budget') && Date.now() >= retryAt) {
      const done = await compact('budget')
      if (done && hold) { holdUntil = Date.now() + HOLD_MS; phase = 'hold' }
    }
  }

  // ---- frames --------------------------------------------------------------
  function frame() {
    const cur = currentTask
    const avg = (a, b) => (b > 0 ? a / b : null)
    return {
      title: cfg.title, description: cfg.description, repo: cfg.repo, client, gen,
      running, phase, error, cfgError: cfgProblems.length ? cfgProblems.join(' · ') : null,
      cfg: { budget: eff('budget'), trimTo: eff('trimTo'), distraction: eff('distraction'), eventsPerSec: cfg.eventsPerSec, noise: cfg.noise, focus: cfg.focus, target: cfg.target, recallTarget: cfg.recallTarget, summaryTokens: cfg.summaryTokens, taskEvery: cfg.taskEvery, seed: cfg.seed },
      overrides: { budget: overrides.budget !== undefined, distraction: overrides.distraction !== undefined, task: overrides.task !== undefined },
      tasks: cfg.tasks.map((t) => ({ id: t.id, title: t.title, words: t.vocabulary.length })),
      currentTask: cur, taskSince, n: eventNo, tokens, rolledOff,
      kinds: KINDS,
      // [id, kind, tokens, original tokens, task index (-1 junk), need (0 none, 1 gist, 2 detail, 3 message), pinned, verdict (0 none, 1 keep, 2 trim, 3 drop), label]
      blocks: window_.map((b) => [b.id, KINDS.indexOf(b.kind), b.tokens, b.orig || b.tokens, b.task ? taskIdx(b.task) : -1, b.need === 'message' ? 3 : b.need === 'detail' ? 2 : b.need === 'gist' ? 1 : 0, pinned.has(b.id) ? 1 : 0, b.verdict ? VERDICTS.indexOf(b.verdict) + 1 : 0, b.need === 'message' ? '' : b.label]),
      // The per-block verdict list only rides along while a pane may still be animating it.
      last: last ? { ...last, verdicts: Date.now() - last.wallAt < 8000 ? last.verdicts : null } : null,
      history: history.slice(-24),
      totals: {
        compactions: totals.compactions, questions: totals.questions, calls: totals.calls, costUsd: totals.costUsd, ms: totals.ms, demoted: totals.demoted,
        avgRecall: avg(totals.needleAfter, totals.needleBefore), avgJunkRemoved: totals.junkBefore > 0 ? 1 - totals.junkAfter / totals.junkBefore : null,
        avgReduction: totals.tokensBefore > 0 ? 1 - totals.tokensAfter / totals.tokensBefore : null, perCall: totals.calls ? totals.questions / totals.calls : 0,
      },
      baseline: {
        tokens: baseTokens, compactions: baseStats.compactions, lastRecall: baseStats.lastRecall, avgRecall: avg(baseStats.needleAfter, baseStats.needleBefore),
        lastBefore: baseStats.lastBefore, lastAfter: baseStats.lastAfter, lastFolded: baseStats.lastFolded ?? 0,
        // [id, kind, tokens, share of tokens that are needles for the current task]
        blocks: base.map((b) => [b.id, KINDS.indexOf(b.kind), b.tokens, +(Math.min(1, (b.needle[cur] ?? 0) / Math.max(1, b.tokens))).toFixed(2)]),
      },
      series,
    }
  }

  function verdict() {
    const t = totals
    const avgRecall = t.needleBefore > 0 ? t.needleAfter / t.needleBefore : null
    const avgReduction = t.tokensBefore > 0 ? 1 - t.tokensAfter / t.tokensBefore : null
    const baseRecall = baseStats.needleBefore > 0 ? baseStats.needleAfter / baseStats.needleBefore : null
    const findings = []
    if (cfgProblems.length) findings.push({ severity: 'error', kind: 'config', message: cfgProblems.join(' · ') })
    if (error) findings.push({ severity: 'error', kind: 'jev', message: error })
    if (t.compactions) {
      const low = avgRecall != null && avgRecall < cfg.recallTarget
      findings.push({ severity: low ? 'warning' : 'info', kind: 'recall', message: `Needle recall ${pct(avgRecall)} over ${plural(t.compactions, 'compaction')} (target ${pct(cfg.recallTarget)}), average reduction ${pct(avgReduction)}, distraction ${eff('distraction').toFixed(2)}.` })
      findings.push({ severity: 'info', kind: 'speed', message: `${plural(t.questions, 'question')} in ${plural(t.calls, 'call')} (${Math.round(t.questions / Math.max(1, t.calls))} per call), ${t.ms.toFixed(0)} ms in total, about $${t.costUsd.toFixed(4)} on ${client === 'typesafe' ? 'live Jev' : 'the offline mock'}.` })
      if (baseRecall != null) findings.push({ severity: 'info', kind: 'baseline', message: `Simple "summarize the oldest half" baseline kept ${pct(baseRecall)} of needle tokens on the same synthetic session. It is a toy baseline, not a real product.` })
    }
    return {
      ready: t.compactions > 0,
      summary: cfgProblems.length || error
        ? `${cfg.title} needs a fix`
        : t.compactions
          ? `${cfg.title} · ${plural(t.compactions, 'compaction')} · recall ${pct(avgRecall)} · reduction ${pct(avgReduction)} · synthetic session`
          : `${cfg.title} · filling the context window (${fmt(tokens)} of ${fmt(eff('budget'))} tokens)`,
      findings,
      artifact: 'session.json',
      phases: [
        { id: 'fill', name: 'Filling the window', state: t.compactions ? 'done' : 'active' },
        { id: 'judge', name: 'Jev judges every tool result', state: phase === 'judging' ? 'active' : t.compactions ? 'done' : 'pending' },
        { id: 'measure', name: 'Measured against ground truth', state: t.compactions ? 'active' : 'pending' },
      ],
    }
  }

  function saveVerdict(force = false) {
    const now = Date.now()
    if (!force && now - lastVerdictWrite < 1500) return
    lastVerdictWrite = now
    try { writeVerdict(workspace, verdict()) } catch { /* a read-only workspace must not stop the demo */ }
  }

  function push(force = false) {
    if (!view) return
    const now = Date.now()
    clearTimeout(broadcastTimer)
    if (force || now - lastBroadcast >= 70) { lastBroadcast = now; view.broadcast(frame()) }
    else broadcastTimer = setTimeout(() => push(true), 70 - (now - lastBroadcast))
  }

  // ---- the loop ------------------------------------------------------------
  function schedule() {
    clearTimeout(timer)
    if (stopped || !running) return
    timer = setTimeout(run, 1000 / cfg.eventsPerSec)
  }
  async function run() {
    if (stopped || !running) return
    if (Date.now() >= holdUntil) {
      if (phase === 'hold') phase = 'filling'
      const n = totals.compactions
      await step({ hold: true })
      saveVerdict(totals.compactions !== n)
      push(totals.compactions !== n)
    }
    schedule()
  }

  async function control(cmd, body) {
    const n0 = totals.compactions
    let reply = null
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { resetSession() }
    else if (cmd === 'tick') {
      const n = clampN(Math.round(Number(body.n) || 1), 1, 5000)
      for (let i = 0; i < n; i++) await step()
      holdUntil = 0
    } else if (cmd === 'flood') {
      const n = clampN(Math.round(Number(body.n) || 40), 1, 400)
      for (let i = 0; i < n && tokens <= eff('budget'); i++) addEvent(genEvent())
      if (tokens > eff('budget')) { const done = await compact('budget'); if (done && running) { holdUntil = Date.now() + HOLD_MS; phase = 'hold' } }
    } else if (cmd === 'compact') {
      const done = await compact('manual')
      if (done && running) { holdUntil = Date.now() + HOLD_MS; phase = 'hold' }
    } else if (cmd === 'setTask') {
      if (switchTask(String(body.task ?? ''), 'person')) overrides.task = currentTask
    } else if (cmd === 'setBudget') {
      const v = Number(body.value)
      if (Number.isFinite(v)) overrides.budget = Math.round(clampN(v, 20000, 2000000))
    } else if (cmd === 'setDistraction') {
      const v = Number(body.value)
      if (Number.isFinite(v)) overrides.distraction = clampN(v, 0, 1)
    } else if (cmd === 'pin') {
      const id = Number(body.id)
      const b = window_.find((x) => x.id === id)
      if (b && b.need !== 'message') { if (body.pinned === false || (body.pinned === undefined && pinned.has(id))) pinned.delete(id); else pinned.add(id) }
      reply = { pinned: pinned.has(id) }
    } else if (cmd === 'inspect') {
      const id = Number(body.id)
      const b = window_.find((x) => x.id === id) ?? graveyard.get(id)
      reply = { block: b ? describe(b) : null }
    }
    if (cmd !== 'inspect') { saveVerdict(true); push(true) }
    if (totals.compactions !== n0) saveVerdict(true)
    return reply
  }

  function describe(b) {
    const t = b.task ? taskOf(b.task) : null
    const rel = b.task === currentTask
    const ideal = b.need === 'message' ? null : !rel ? 'drop' : b.need === 'detail' ? 'keep' : 'trim'
    const truth = b.need === 'message'
      ? 'A message. Messages are never judged or touched.'
      : !b.task
        ? 'Pure junk (logs, lockfiles, generated files, test spam). It belongs to no task.'
        : `Belongs to "${t.title}". ${b.need === 'detail' ? 'The exact text matters.' : `Only the gist matters (about the first ${GIST_TOKENS} tokens).`} ${rel ? 'That is the current task.' : 'That is NOT the current task.'}`
    return {
      id: b.id, kind: b.kind, label: b.label, preview: b.preview, tokens: b.tokens, orig: b.orig || b.tokens,
      task: b.task, taskTitle: t?.title ?? null, need: b.need, pinned: pinned.has(b.id), gone: b.gone ?? null,
      verdict: b.verdict, jev: b.jev ?? null, probs: b.probs, demoted: b.demoted, ideal, truth,
      inWindow: !b.gone,
    }
  }

  // ---- boot ----------------------------------------------------------------
  const watcher = watchConfig(file, {}, (raw, err) => { applyConfig(raw, err); saveVerdict(true); push(true); schedule() })
  applyConfig(watcher.get(), watcher.error())

  view = await serveViewer({ here: HERE, port, state: frame, control })
  saveVerdict(true)
  schedule()

  return {
    url: view.url,
    async close() { stopped = true; clearTimeout(timer); clearTimeout(broadcastTimer); watcher.close(); await view.close() },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startCompactorViewer({ workspace, port })
  console.log(`Jev Compactor listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
