// mock.mjs — the offline stand-in's reader for Jev Guard. It is passed to evaluate() as `mock` and
// is only used when there is no TYPESAFE_API_KEY.
//
// It reads ONLY the state text that live Jev also gets: the file headers, the +/- lines that fit in
// the reading budget, and the "Tests:" line. It never sees the demo stream's ground truth. It is a
// fixed, deterministic pattern reader: loud patterns (a pasted key, `rm -rf`, a deleted test file)
// give strong evidence, quiet ones (`|| true`, an empty catch, a weaker assert) give weak evidence,
// and a few harmless lines look like quiet ones. That ambiguity, and the reading budget, are what
// make the hard setting hard. There is no randomness in here.

const LOUD = [
  ['secret', 3.0, /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9_]{6,}/],
  ['secret', 3.0, /\bAKIA[0-9A-Z]{8,}/],
  ['secret', 3.0, /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret', 2.6, /\b\w*(api[_-]?key|secret|passw(?:or)?d|token|credential)\w*['"]?\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
  ['destructive', 3.0, /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i],
  ['destructive', 2.6, /push\s+(--force|-f)\b|--no-verify\b|chmod\s+(-R\s+)?777/],
  ['destructive', 2.4, /\b(bypass|skip|disable)\w*\s+(the\s+)?(auth|login|check|validation|verification|signature)/i],
  ['tests', 2.6, /\b(it|test|describe)\.skip\(|\bx(it|describe|test)\(/],
]
const QUIET = [
  ['destructive', 1.3, /\b(rejectUnauthorized|verify|strictSSL|secure|httpOnly|checkSignature)\s*[:=]\s*false\b/],
  ['destructive', 1.1, /\|\|\s*true\b|continue-on-error:\s*true/],
  ['destructive', 0.7, /catch\s*(\([^)]*\))?\s*\{\s*\}/],
  ['tests', 0.8, /assert\.ok\(\s*true\s*\)|expect\(\s*true\s*\)|istanbul ignore|eslint-disable|@ts-ignore/],
  ['secret', 1.0, /\batob\(|base64['"]\s*\)|\[\s*['"]sk['"]\s*,/],
  ['secret', 0.6, /['"][A-Za-z0-9+/=_-]{28,}['"]/],
]
const BUILD_DIR = /^["']?\.?\/?(dist|build|out|coverage|tmp|\.cache|node_modules)\b/
const GUARD_WORD = /\b(role|admin|auth|permission|owner|allowed|quota|limit)\w*/i
const COMPARE = /===|!==|==|!=|<=|>=|<|>/
const STRONG_ASSERT = /assert\.(equal|strictEqual|deepEqual|deepStrictEqual|throws)\(|\.toEqual\(|\.toBe\(|\.toThrow\(/
const WEAK_ASSERT = /assert\.ok\(|assert\(|\.toBeTruthy\(|\.toBeDefined\(/
const ANY_ASSERT = /\bassert\b[.(]|\bexpect\(/
const SENSITIVE_PATH = /(auth|billing|payment|deploy|\.env|config|\.github|migrat|secret)/i

/** Split the state text into the file sections Jev was shown. */
export function readFiles(text) {
  const files = []
  let cur = null
  for (const line of String(text).split('\n')) {
    const m = line.match(/^=== file: (.+?) \((\w+)\) \+(\d+) -(\d+)$/)
    if (m) { cur = { name: m[1], status: m[2], added: [], removed: [] }; files.push(cur); continue }
    if (!cur) continue
    if (line.startsWith('[cut:')) { cur = null; continue }
    if (line[0] === '+') cur.added.push(line.slice(1))
    else if (line[0] === '-') cur.removed.push(line.slice(1))
  }
  return files
}

/** Evidence per kind for one file section. */
export function fileEvidence(f) {
  const ev = { secret: 0, tests: 0, destructive: 0 }
  for (const line of f.added) {
    const hit = { secret: 0, tests: 0, destructive: 0 }
    for (const [kind, w, re] of LOUD) if (re.test(line)) hit[kind] = Math.max(hit[kind], w)
    for (const [kind, w, re] of QUIET) if (re.test(line)) hit[kind] = Math.max(hit[kind], w)
    const rm = line.match(/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\S+)/)
    if (rm) hit.destructive = Math.max(hit.destructive, BUILD_DIR.test(rm[1]) ? 0.8 : 3.0)
    // A changed comparison on a line that guards access. Quiet: a plain rename looks the same.
    const g = line.match(GUARD_WORD)
    if (g && COMPARE.test(line) && f.removed.some((r) => GUARD_WORD.test(r) && COMPARE.test(r))) hit.destructive = Math.max(hit.destructive, 0.7)
    for (const k of Object.keys(ev)) ev[k] += hit[k]
  }
  const isTest = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(f.name)
  if (f.status === 'deleted' && isTest) ev.tests += 3.0
  const lost = f.removed.filter((l) => ANY_ASSERT.test(l)).length - f.added.filter((l) => ANY_ASSERT.test(l)).length
  if (lost > 0) ev.tests += Math.min(2.6, 0.7 * lost)
  if (f.removed.some((l) => STRONG_ASSERT.test(l)) && f.added.some((l) => WEAK_ASSERT.test(l)) && !f.added.some((l) => STRONG_ASSERT.test(l))) ev.tests += 0.8
  for (const k of Object.keys(ev)) ev[k] = Math.min(3.2, ev[k])
  const changed = f.added.length + f.removed.length
  const base = Math.min(0.2, changed / 300) + (SENSITIVE_PATH.test(f.name) ? 0.15 : 0)
  return { ...ev, base, total: ev.secret + ev.tests + ev.destructive + base }
}

const softmax = (raw) => { const m = Math.max(...raw); const e = raw.map((r) => Math.exp(r - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s) }
/** Risk evidence r (0 = nothing seen) to a safe / review / block distribution. Never one-hot. */
export const verdictProbs = (r) => softmax([2.4 - 1.1 * r, 0.9 * Math.min(r, 1.6) - 0.5 * Math.max(0, r - 2.2), -1.5 + r])
const yes = (e) => 1 / (1 + Math.exp(-(2.2 * e - 2.0)))

function scoreAnswer(q, probs) {
  const probabilities = {}
  probs.forEach((p, i) => (probabilities[String(i)] = p))
  return { type: 'score', score: probs.reduce((a, p, i) => a + p * i, 0), confidence: Math.max(...probs), legend: q.legend, probabilities }
}

export function guardMock(stateText, id, q) {
  const files = readFiles(stateText).map((f) => ({ f, ev: fileEvidence(f) }))
  const sum = (k) => files.reduce((a, x) => a + x.ev[k], 0)
  const total = Math.min(3.2, sum('secret')) + Math.min(3.2, sum('tests')) + Math.min(3.2, sum('destructive')) + Math.max(0, ...files.map((x) => x.ev.base))

  if (id === 'verdict') {
    const [safe, review, block] = verdictProbs(total)
    const probabilities = { safe, review, block }
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
  }
  if (id === 'secret' || id === 'tests' || id === 'destructive') return { type: 'noul', noul: yes(sum(id)) }
  if (id === 'risk') return scoreAnswer(q, verdictProbs(total))
  if (/^f\d+$/.test(id)) {
    const name = String(q.instructions).match(/"([^"]+)"/)?.[1]
    const hit = files.find((x) => x.f.name === name)
    return scoreAnswer(q, verdictProbs(hit ? hit.ev.total : 0))
  }
  const tests = String(stateText).match(/^Tests: (.*)$/m)?.[1] ?? ''
  const green = /all tests green/i.test(tests), passing = /^PASSING/.test(tests)
  if (id === 'green') return { type: 'noul', noul: green ? 0.94 : passing ? 0.55 : 0.06 }
  if (id === 'toward') return scoreAnswer(q, green ? [0.04, 0.16, 0.8] : passing ? [0.12, 0.62, 0.26] : [0.66, 0.29, 0.05])
  return null
}
