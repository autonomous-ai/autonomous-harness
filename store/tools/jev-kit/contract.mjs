// contract.mjs — node store/tools/jev-kit/contract.mjs
// Contract test: run every harness's jev.mjs against a local fake of POST /v1/systemone that is
// STRICT about the documented wire shape (choice: criteria map, score: criteria array, no
// `options`/`legend` keys) and answers 422 otherwise. Also checks retry-on-529 and telemetry.
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'agents')
let hits = 0, overloadFirst = false

const server = createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  hits++
  if (overloadFirst) { overloadFirst = false; res.writeHead(529); return res.end('overloaded') }
  const fail = (msg) => { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: msg })) }
  if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401); return res.end('bad key') }
  let j
  try { j = JSON.parse(body) } catch { return fail('not json') }
  if (j.model !== 'jev-latest') return fail('model')
  if (j.state == null) return fail('state required')
  const answers = {}
  for (const [id, q] of Object.entries(j.questions || {})) {
    if ('options' in q || 'legend' in q || 'choices' in q || 'descriptions' in q || 'hints' in q || 'levels' in q) return fail(`${id}: unknown field`)
    if (typeof q.instructions !== 'string' || !q.instructions) return fail(`${id}: instructions`)
    if (q.type === 'choice') {
      if (!q.criteria || Array.isArray(q.criteria) || typeof q.criteria !== 'object') return fail(`${id}: choice.criteria must be a map`)
      const keys = Object.keys(q.criteria)
      if (keys.length < 2 || keys.length > 255) return fail(`${id}: 2..255 options`)
      if (!Object.values(q.criteria).every((v) => typeof v === 'string')) return fail(`${id}: descriptions must be strings`)
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / (keys.length - 1)]))
      answers[id] = { type: 'choice', choice: keys[0], probabilities, confidence: 0.6 }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) return fail(`${id}: score.criteria must be an array of 2+`)
      answers[id] = { type: 'score', score: 1.035, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), confidence: 0.84 }
    } else if (q.type === 'noul') {
      if ('criteria' in q && (Array.isArray(q.criteria) || typeof q.criteria !== 'object')) return fail(`${id}: noul.criteria must be {true,false}`)
      answers[id] = { type: 'noul', noul: 0.999 }
    } else return fail(`${id}: type`)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ model: 'jev-1.13', answers, usage: { input_tokens: 321, output_tokens: 12 } }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.TYPESAFE_API_URL = `http://127.0.0.1:${server.address().port}/v1/systemone`

let bad = 0
for (const name of readdirSync(ROOT).filter((n) => n.startsWith('jev-')).sort()) {
  const m = await import(join(ROOT, name, 'toolchain/jev.mjs'))
  const { evaluate, jev, snapshot } = m
  try {
    overloadFirst = true // first call must survive one 529
    const before = hits
    const r = await evaluate({
      key: 'test-key', state: 'The deploy failed twice and the customer is angry.',
      questions: {
        a: jev.choice(['billing', 'technical', 'sales'], 'Which team?'),
        b: { type: 'choice', instructions: 'Which way?', options: ['LEFT', 'RIGHT'], criteria: ['be decisive'] },
        c: jev.score({ 0: 'calm', 1: 'frustrated', 2: 'angry' }, 'How frustrated?'),
        d: jev.noul('Is it urgent?', ['time pressure']),
        e: jev.choice({ keep: 'still needed', drop: 'irrelevant now' }, 'Keep this tool result?'),
      },
    })
    const s = snapshot()
    const ok = r.client === 'typesafe' && r.answers.a.choice === 'billing' && r.answers.b.probabilities.LEFT === 0.7 &&
      r.answers.c.score === 1.035 && r.answers.d.noul === 0.999 && r.answers.e.choice === 'keep' &&
      hits - before === 2 && s.inputTokens === 321 && s.tokensEstimated === false && s.last.questions.length === 5 && r.latencyMs > 0
    // and a bad key must fail fast with no retry
    const h2 = hits
    let threw = false
    try { await evaluate({ key: 'nope', state: 'x', questions: { a: jev.noul('x?') } }) } catch { threw = true }
    const fastFail = threw && hits - h2 === 1
    // mock path still works and is metered
    const mk = await evaluate({ key: '', state: 'aim x 3.0 target x 9.0', questions: { a: jev.choice(['LEFT', 'RIGHT'], 'go') } })
    const mockOk = mk.client === 'mock' && typeof mk.answers.a.choice === 'string'
    if (!(ok && fastFail && mockOk)) bad++
    console.log(`${ok && fastFail && mockOk ? 'OK  ' : 'BAD '} ${name.padEnd(14)} live=${ok} fastFail401=${fastFail} mock=${mockOk}`)
  } catch (e) {
    bad++
    console.log(`BAD  ${name.padEnd(14)} ${e.message}`)
  }
}
server.close()
console.log(bad ? `CONTRACT FAIL (${bad})` : 'CONTRACT OK')
process.exit(bad ? 1 : 0)
