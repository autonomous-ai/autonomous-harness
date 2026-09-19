#!/usr/bin/env node
// measure.mjs — score a firehose.json without the pane.
//
//   node toolchain/measure.mjs [path/to/firehose.json] [--n 600] [--noise 0.3]
//
// It makes N synthetic messages with the same generator the viewer uses, asks Jev the same five
// questions, and prints accuracy and escalations at a range of thresholds, plus the lowest threshold
// that meets `targetAccuracy`. Without TYPESAFE_API_KEY it runs on the offline stand-in (free).
// With a key, every message is one real call (600 messages cost about one cent).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluate } from './jev.mjs'
import { sanitize, makeMessage, buildQuestions } from '../viewer/viewer.mjs'
import { mulberry32 } from '../viewer/kit.mjs'

const args = process.argv.slice(2)
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def }
const file = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--')) || join(process.env.HARNESS_WORKSPACE || '.', 'firehose.json')

let raw
try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { console.log(`error  cannot read ${file}: ${e.message}`); process.exit(1) }
const { cfg, warnings } = sanitize(raw)
for (const w of warnings) console.log(`warn   ${w}`)

const N = Math.max(50, Math.min(5000, Math.floor(flag('n', 600))))
const noise = Math.max(0, Math.min(1, flag('noise', cfg.noise)))
const questions = buildQuestions(cfg)
const rng = mulberry32((cfg.seed | 0) + 1)
const nT = cfg.teams.length
const rows = []
const confusion = Array.from({ length: nT }, () => new Array(nT).fill(0))
let client = 'mock'
for (let i = 0; i < N; i++) {
  const m = makeMessage(cfg, rng, noise)
  const res = await evaluate({ state: m.text, questions, salt: (cfg.seed | 0) + i })
  client = res.client
  const a = res.answers
  const choice = cfg.teams.findIndex((t) => t.id === a.team?.choice)
  rows.push({ truth: m.truth, choice, conf: Number(a.team?.confidence ?? 0), spam: Number(a.spam?.noul ?? 0) >= 0.5 })
  if (!m.spam && choice >= 0) confusion[m.truth][choice]++
}

const at = (th) => {
  let routed = 0, right = 0
  for (const r of rows) { const b = r.spam ? nT : r.conf < th ? -1 : r.choice; if (b === -1) continue; routed++; if (b === r.truth) right++ }
  return { acc: routed ? right / routed : 0, esc: (rows.length - routed) / rows.length }
}
const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%'
console.log(`${cfg.title}: ${N} synthetic messages, noise ${noise}, ${nT} teams, client ${client}`)
console.log('threshold   right   escalated')
for (const th of [0, 0.3, 0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9]) { const r = at(th); console.log(`   ${th.toFixed(2)}     ${pct(r.acc)}   ${pct(r.esc)}${Math.abs(th - cfg.threshold) < 1e-9 ? '   <- threshold in the file' : ''}`) }
let best = null
for (let j = 0; j <= 100; j++) { const r = at(j / 100); if (r.acc >= cfg.targetAccuracy) { best = { th: j / 100, ...r }; break } }
console.log(best
  ? `lowest threshold with at least ${pct(cfg.targetAccuracy).trim()} right: ${best.th.toFixed(2)} (${pct(best.acc).trim()} right, ${pct(best.esc).trim()} escalated)`
  : `no threshold reaches ${pct(cfg.targetAccuracy).trim()} right at this noise`)
const pairs = []
for (let i = 0; i < nT; i++) for (let j = 0; j < nT; j++) if (i !== j && confusion[i][j]) pairs.push([confusion[i][j], `${cfg.teams[i].id} -> ${cfg.teams[j].id}`])
pairs.sort((x, y) => y[0] - x[0])
if (pairs.length) console.log('most confused (true -> Jev): ' + pairs.slice(0, 5).map(([c, name]) => `${name} ${c}`).join(', '))
