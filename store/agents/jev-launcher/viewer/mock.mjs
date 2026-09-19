// mock.mjs — the launcher's offline stand-in reader. It is passed to evaluate() as `mock`, so it is
// only used when there is no TYPESAFE_API_KEY. It reads ONLY the state text that live Jev also
// gets: the numbered palette lines and the `Current query: "..."` line. It knows nothing about who
// is typing or which target they want. It is a stand-in for plumbing, not for Jev's judgement.
//
// It is here because the generic reader in toolchain/jev.mjs adds weight for every word of an
// option's name that appears anywhere in the state. Every name is printed in the palette, so
// three-word names always led: the query "music" ranked "Deploy to prod" above "Music".

const LINE = /^\s*\d+\.\s+(.+?)\s+\[([^\]]*)\](\s+\(featured\))?\s+aliases:\s*(.*?)\s+—\s+launch\s*$/i

/** The palette and the query, read back out of the state text. */
export function parseState(text) {
  const query = (String(text).match(/Current query:\s*"([^"]*)"/i) || [null, ''])[1]
  const targets = []
  for (const line of String(text).split('\n')) {
    const m = line.match(LINE)
    if (m) targets.push({ name: m[1].trim(), category: m[2].trim(), featured: !!m[3], aliases: m[4].split(',').map((s) => s.trim()).filter(Boolean) })
  }
  return { query, targets }
}

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || []

/** Edit distance with swaps of neighbours counted as one slip, capped at `max + 1`. */
function slips(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      row.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev2 = prev; prev = row
  }
  return prev[b.length]
}

/** How well one typed word matches one word of a target. 0 = not at all. */
function wordScore(q, tok) {
  if (!q || !tok) return 0
  const cover = Math.min(1, q.length / tok.length)
  if (q === tok) return 3.2
  if (tok.startsWith(q)) return 2.0 + cover
  if (q.length >= 2 && tok.includes(q)) return 1.1 + 0.4 * cover
  if (q.length >= 3) {
    // A slip of the finger: one wrong, missing, extra or swapped letter against the start of the word.
    const allow = q.length >= 7 ? 2 : 1
    let d = allow + 1
    for (const len of [q.length - 1, q.length, q.length + 1]) if (len >= 2 && len <= tok.length) d = Math.min(d, slips(q, tok.slice(0, len), allow))
    if (d <= allow) return (d === 1 ? 1.6 : 1.0) + 0.5 * cover
  }
  if (q.length >= 2 && q[0] === tok[0]) { let k = 0; for (const c of tok) if (c === q[k]) k++; if (k === q.length) return 0.7 }
  return 0
}

/** One score per target: the sum, over the typed words, of the best matching word of the target. */
export function scoreTargets(query, targets) {
  const qs = words(query)
  return targets.map((t) => {
    if (!qs.length) return t.featured ? 1.2 : 0
    const nameWords = words(t.name)
    const aliasWords = t.aliases.flatMap(words)
    const joined = [nameWords.join(''), ...t.aliases.map((a) => words(a).join(''))]
    let s = 0
    for (const q of qs) {
      let best = 0
      for (const w of nameWords) { const v = wordScore(q, w); if (v) best = Math.max(best, v + 0.4) } // the name itself counts a bit more
      for (const w of aliasWords) best = Math.max(best, wordScore(q, w))
      for (const w of joined) best = Math.max(best, wordScore(q, w) * 0.9)
      s += best
    }
    return s / Math.sqrt(qs.length) + (t.featured ? 0.15 : 0)
  })
}

function softmax(raw, k) {
  const m = Math.max(...raw)
  const e = raw.map((r) => Math.exp((r - m) * k))
  const sum = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / sum)
}

/** evaluate()'s `mock` hook: (stateText, questionId, canonicalQuestion, salt) => answer | null */
export function launcherMock(stateText, id, q) {
  const { query, targets } = parseState(stateText)
  if (!targets.length) return null
  const scores = scoreTargets(query, targets)
  const probs = softmax(scores, 1.6)
  const byName = new Map(targets.map((t, i) => [t.name, i]))

  if (q.type === 'choice' && id === 'pick') {
    const probabilities = {}
    let best = null, bestP = -1
    for (const opt of q.options) {
      const i = byName.get(opt)
      const p = i === undefined ? 0 : probs[i]
      probabilities[opt] = p
      if (p > bestP) { bestP = p; best = opt }
    }
    return { type: 'choice', choice: best, confidence: Math.max(0, bestP), probabilities }
  }
  if (q.type === 'choice' && id === 'category') {
    const probabilities = Object.fromEntries(q.options.map((o) => [o, 0]))
    targets.forEach((t, i) => { if (t.category in probabilities) probabilities[t.category] += probs[i] })
    const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1
    let best = q.options[0], bestP = -1
    for (const o of q.options) { probabilities[o] /= total; if (probabilities[o] > bestP) { bestP = probabilities[o]; best = o } }
    return { type: 'choice', choice: best, confidence: bestP, probabilities }
  }
  if (q.type === 'noul' && id === 'ready') {
    // Ready to launch = something matched, and it is clear of the runner-up.
    const sorted = [...probs].sort((a, b) => b - a)
    const margin = sorted[0] - (sorted[1] ?? 0)
    const matched = Math.max(...scores) >= 1 && words(query).length > 0
    return { type: 'noul', noul: matched ? 1 / (1 + Math.exp(-(margin * 7 - 2))) : 0.04 }
  }
  return null
}
