// The dial's recap, without a model.
//
// The interesting cases are all the same shape: an engine's last message is MARKDOWN, and the naive
// `slice(0, 60)` of markdown is a heading and a severed word. What is asserted here is that the cut
// lands on words a person can read.
import { describe, expect, it } from 'vitest'
import { BODY_MAX_CHARS, RECAP_MAX_CHARS, deriveTurnSummary } from './summarize.js'

const parts = (text: string) => {
  const out = deriveTurnSummary(text)
  if (!out) return null
  const nl = out.indexOf('\n\n')
  return { recap: out.slice(0, nl), body: out.slice(nl + 2) }
}

describe('deriveTurnSummary', () => {
  it('takes the first real sentence, not the markdown around it', () => {
    const p = parts('## Kết quả\n\n- **SJC**: 149,1 triệu đồng/lượng (bán ra, TP.HCM)\n- PNJ: 148 triệu')!
    // Not "## Kết quả", which is what a heading collapses to and says nothing.
    expect(p.recap).not.toContain('#')
    expect(p.recap).toContain('SJC')
    expect(p.recap).not.toContain('**')
  })

  it('skips a bare label that names the shape of the answer', () => {
    const p = parts('Kết quả:\n\nĐã cập nhật đường retry và chạy lại test.')!
    expect(p.recap.startsWith('Đã cập nhật')).toBe(true)
  })

  it('marks a cut with an ellipsis and keeps to the budget', () => {
    const long = 'Đã cập nhật đường retry trong src/api/client.ts, chạy lại toàn bộ test và mọi thứ đều xanh.'
    const p = parts(long)!
    expect(p.recap.length).toBeLessThanOrEqual(RECAP_MAX_CHARS)
    expect(p.recap.endsWith('…')).toBe(true)
    // The cut lands between words, not through one.
    expect(p.recap.slice(0, -1)).toBe(p.recap.slice(0, -1).trimEnd())
    expect(long.startsWith(p.recap.slice(0, -1))).toBe(true)
  })

  it('leaves something that already fits completely alone', () => {
    const p = parts('SJC hôm nay bán ra 149,1 triệu đồng/lượng.')!
    expect(p.recap).toBe('SJC hôm nay bán ra 149,1 triệu đồng/lượng.')
    expect(p.recap.endsWith('…')).toBe(false)
  })

  it('caps the body too, since the window is where anyone reads the whole thing', () => {
    const p = parts('a'.repeat(40) + ' ' + 'b'.repeat(400))!
    expect(p.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
    expect(p.body.endsWith('…')).toBe(true)
  })

  it('throws away fenced code and tables rather than drawing half a shell command', () => {
    const p = parts('Chạy lệnh sau để kiểm tra.\n\n```sh\nnpm run build && npm test -- --watch\n```')!
    expect(p.body).not.toContain('npm run build')
    expect(p.recap).toContain('Chạy lệnh')
  })

  it('does not let one unbroken token collapse the line to nothing', () => {
    // A word-boundary cut would leave almost nothing here, so the budget wins over the boundary.
    const p = parts('/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/cli/src/lib/x.ts')!
    expect(p.recap.length).toBeGreaterThan(RECAP_MAX_CHARS - 5)
  })

  it('answers null when there is nothing a person could read', () => {
    expect(deriveTurnSummary('')).toBeNull()
    expect(deriveTurnSummary('```\ncode only\n```')).toBeNull()
  })
})
