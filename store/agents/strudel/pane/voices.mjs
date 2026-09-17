// The voices of a track, read off its source: the arguments of the top-level `stack(...)`, or the
// `$:` / `name:` blocks of a labelled track, each with the character range it covers and a name taken
// from the comment written above it. The pane uses the ranges to tell which voice a sound came from
// (every hap carries the source locations of the mini-notation that made it), which is what lets it
// draw one lane per voice and mute or solo a voice without touching the file.
//
// Plain ES module with no dependencies: the pane imports it, and `node --test pane/` tests it (voices.test.mjs).

const OPEN = { '(': ')', '[': ']', '{': '}' }
const CLOSE = new Set([')', ']', '}'])

/** One pass over the source: comments (with their text), and the top-level structure we need. */
function scan(code) {
  const comments = [] // { from, to, text, line }
  const stacks = [] // { open, close, commas: [] } for stack( calls whose paren sits at depth 0
  const labels = [] // { from, name, colon } for `name:` / `$:` at depth 0, first thing on a line
  const depthStack = []
  let open = null // the stack( being collected, while inside it
  let i = 0
  let lineStart = true // only whitespace since the last newline
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '\n') { lineStart = true; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const to = end === -1 ? n : end
      comments.push({ from: i, to, text: code.slice(i + 2, to).trim(), block: false })
      i = to
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const to = end === -1 ? n : end + 2
      comments.push({ from: i, to, text: code.slice(i + 2, end === -1 ? n : end).replace(/^\s*\*+/gm, '').trim(), block: true })
      i = to
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n && code[j] !== c) { if (code[j] === '\\') j++; j++ }
      i = j + 1
      lineStart = false
      continue
    }
    const depth = depthStack.length
    if (depth === 0 && lineStart) {
      const m = /^(_?\$|[A-Za-z_][\w]*)\s*:(?!:)/.exec(code.slice(i, i + 80))
      if (m && !/^(https?|default|case)$/.test(m[1])) {
        labels.push({ from: i, name: m[1], colon: i + m[0].length })
        i += m[0].length
        lineStart = false
        continue
      }
    }
    lineStart = false
    if (OPEN[c]) {
      if (c === '(' && depth === 0 && /(?:^|[^\w$.])stack\s*$/.test(code.slice(Math.max(0, i - 40), i))) {
        open = { open: i, close: -1, commas: [] }
      }
      depthStack.push(c)
      i++
      continue
    }
    if (CLOSE.has(c)) {
      depthStack.pop()
      if (open && depthStack.length === 0 && c === ')') {
        open.close = i
        stacks.push(open)
        open = null
      }
      i++
      continue
    }
    if (c === ',' && open && depthStack.length === 1) open.commas.push(i)
    i++
  }
  if (open) { open.close = n; stacks.push(open) } // an unclosed stack( while the agent is typing
  return { comments, stacks, labels }
}

/** The first line of a comment, cut down to a name: "Kick — lazy and syncopated" → "Kick". */
export function nameFromComment(text) {
  const first = String(text).split('\n')[0].trim().replace(/^[-*#=\s]+/, '')
  if (!first) return null
  const cut = first.split(/\s+[—–-]{1,2}\s+|:\s|;\s|\.\s|,\s|\s\(/)[0].replace(/[.:;,]+$/, '').trim()
  if (!cut) return null
  if (cut.length <= 26) return cut
  return cut.split(/\s+/).slice(0, 3).join(' ').slice(0, 26)
}

/** Without a comment, name a voice by what it plays: its first sound, or "Notes". */
export function nameFromCode(src) {
  const sound = /(?:^|[^\w$])(?:s|sound)\(\s*["'`]([^"'`]*)/.exec(src) || /\.(?:s|sound)\(\s*["'`]([^"'`]*)/.exec(src)
  if (sound) {
    const word = /[A-Za-z_][\w]*/.exec(sound[1].replace(/<|\[|\{/g, ' '))
    if (word) return word[0]
  }
  if (/(?:^|[^\w$])(?:note|n|freq)\(/.test(src)) return 'Notes'
  return null
}

function trimRange(code, comments, from, to) {
  // the first and last characters of real code in [from, to): no whitespace, no comments
  const inComment = (k) => comments.find((cm) => k >= cm.from && k < cm.to)
  let a = from
  while (a < to) {
    const cm = inComment(a)
    if (cm) { a = cm.to; continue }
    if (/\s/.test(code[a])) { a++; continue }
    break
  }
  let b = to
  while (b > a) {
    const cm = inComment(b - 1)
    if (cm) { b = cm.from; continue }
    if (/\s/.test(code[b - 1])) { b--; continue }
    break
  }
  return [a, b]
}

const lineEnd = (code, at) => { const k = code.indexOf('\n', at); return k === -1 ? code.length : k }

function describe(code, comments, segFrom, from, to, index) {
  // The comment group directly above the voice: consecutive comments with only whitespace (or the
  // separating comma) between. A comment on the same line as the previous voice's end is that
  // voice's trailing remark, not this one's title.
  const prevLineEnd = segFrom > 0 ? lineEnd(code, segFrom) : -1
  const above = comments.filter((cm) => cm.from >= segFrom && cm.to <= from && cm.from > prevLineEnd)
  const group = []
  let cursor = from
  for (let k = above.length - 1; k >= 0; k--) {
    const cm = above[k]
    if (code.slice(cm.to, cursor).replace(/,/g, '').trim() !== '') break
    group.unshift(cm)
    cursor = cm.from
  }
  if (!group.length) {
    // no title above: a remark trailing the voice's last line, `s("bd*4"), // kick`
    const eol = lineEnd(code, to)
    const trailing = comments.find((cm) => cm.from >= to && cm.from < eol && code.slice(to, cm.from).replace(/[,)]/g, '').trim() === '')
    if (trailing) group.push(trailing)
  }
  const text = group.map((cm) => cm.text).join('\n').trim()
  const src = code.slice(from, to)
  const name = nameFromComment(text) || nameFromCode(src) || `Voice ${index + 1}`
  let detail = ''
  if (text) {
    const firstLine = text.split('\n')[0]
    const named = nameFromComment(text)
    detail = named && firstLine.startsWith(named) ? firstLine.slice(named.length).replace(/^\s*[—–:;,.-]+\s*/, '') : firstLine
    const rest = text.split('\n').slice(1).join(' ').trim()
    if (rest) detail = (detail ? detail + ' ' : '') + rest
  }
  return { index, from, to, name, detail: detail.trim(), line: code.slice(0, from).split('\n').length }
}

/**
 * Parse a track into voices.
 * @returns {{ kind: 'labels'|'stack'|'single'|'none', voices: Array<{index, from, to, name, detail, line, muted?}> }}
 */
export function parseVoices(code) {
  code = String(code ?? '')
  const { comments, stacks, labels } = scan(code)
  if (labels.length) {
    const voices = labels.map((label, k) => {
      const next = labels[k + 1]
      const segEnd = next ? next.from : code.length
      const prevEnd = k === 0 ? 0 : labels[k - 1].colon
      const [from, to] = trimRange(code, comments, label.colon, segEnd)
      const v = describe(code, comments, prevEnd, label.from, to, k)
      v.from = from
      const plain = label.name.replace(/^_/, '')
      if (plain !== '$') v.name = plain
      if (label.name.startsWith('_')) v.muted = true
      return v
    }).filter((v) => v.to > v.from)
    voices.forEach((v, k) => { v.index = k })
    return { kind: 'labels', voices }
  }
  if (stacks.length) {
    const best = stacks.reduce((a, b) => (b.commas.length > a.commas.length ? b : a))
    const bounds = [best.open, ...best.commas, best.close]
    const voices = []
    for (let k = 0; k < bounds.length - 1; k++) {
      const [from, to] = trimRange(code, comments, bounds[k] + 1, bounds[k + 1])
      if (to <= from) continue
      // titles may sit before the separating comma: look back to the end of the previous voice
      const lookFrom = voices.length ? voices[voices.length - 1].to : best.open + 1
      voices.push(describe(code, comments, lookFrom, from, to, voices.length))
    }
    if (voices.length) return { kind: 'stack', voices }
  }
  const [from, to] = trimRange(code, comments, 0, code.length)
  if (to <= from) return { kind: 'none', voices: [] }
  const v = describe(code, comments, 0, from, to, 0)
  if (/^Voice 1$/.test(v.name)) v.name = 'Track'
  return { kind: 'single', voices: [v] }
}

/** The voice a source offset belongs to, or -1. Voices are sorted and do not overlap. */
export function voiceAt(voices, offset) {
  for (const v of voices) if (offset >= v.from && offset < v.to) return v.index
  return -1
}
