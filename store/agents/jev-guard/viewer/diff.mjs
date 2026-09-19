// diff.mjs — a small line diff for the real edits in project/, and the text form Jev reads.
// No dependencies. Lines are { t: '+' | '-' | ' ' | '@', s: text }.

const MAX_LINES = 600      // per side, before we stop trying to be clever
const MAX_OUT = 160        // lines kept per file in a frame

/** Line diff with `ctx` lines of context around each change. */
export function lineDiff(before, after, ctx = 2) {
  const a = before == null ? [] : String(before).split('\n')
  const b = after == null ? [] : String(after).split('\n')
  if (a.length && a[a.length - 1] === '') a.pop()
  if (b.length && b[b.length - 1] === '') b.pop()
  // Trim the common head and tail first: most edits are local.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail)
  let mid = []
  if (am.length > MAX_LINES || bm.length > MAX_LINES) {
    mid = [...am.map((s) => ({ t: '-', s })), ...bm.map((s) => ({ t: '+', s }))]
  } else {
    // Classic LCS table, walked back to front.
    const n = am.length, m = bm.length, w = m + 1
    const L = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    let i = 0, j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push({ t: ' ', s: am[i] }); i++; j++ }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push({ t: '-', s: am[i++] })
      else mid.push({ t: '+', s: bm[j++] })
    }
    while (i < n) mid.push({ t: '-', s: am[i++] })
    while (j < m) mid.push({ t: '+', s: bm[j++] })
  }
  const all = [...a.slice(Math.max(0, head - ctx), head).map((s) => ({ t: ' ', s })), ...mid, ...a.slice(a.length - tail, a.length - tail + ctx).map((s) => ({ t: ' ', s }))]
  // Keep only context near a change.
  const keep = new Uint8Array(all.length)
  all.forEach((l, k) => { if (l.t !== ' ') for (let d = -ctx; d <= ctx; d++) if (all[k + d]) keep[k + d] = 1 })
  const out = []
  let gap = false
  all.forEach((l, k) => { if (keep[k]) { if (gap && out.length) out.push({ t: '@', s: '' }); gap = false; out.push({ t: l.t, s: l.s.slice(0, 240) }) } else gap = true })
  return out.slice(0, MAX_OUT)
}

/**
 * The diff as Jev reads it, cut at `budget` characters. Marks every line past the cut `unread`
 * (for the pane) and returns how much was read.
 */
export function diffText(files, budget) {
  let text = '', cut = false, total = 0
  for (const f of files) {
    const added = f.lines.filter((l) => l.t === '+').length, removed = f.lines.filter((l) => l.t === '-').length
    f.added = added; f.removed = removed
    const head = `=== file: ${f.name} (${f.status}) +${added} -${removed}\n`
    total += head.length
    if (!cut && text.length + head.length <= budget) text += head; else { cut = true; f.unread = true }
    for (const l of f.lines) {
      const row = (l.t === '@' ? '...' : l.t + l.s) + '\n'
      total += row.length
      if (!cut && text.length + row.length <= budget) text += row
      else { cut = true; l.unread = true }
    }
  }
  const read = text.length
  if (cut) text += `[cut: Jev reads the first ${budget} characters of a diff. ${total - read} more characters were not read.]\n`
  return { text, readChars: read, totalChars: total, cut }
}
