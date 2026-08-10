import type { PaneView, QuestionRow, QuestionView } from '../../lib/askQuestion.js'

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

/**
 * Parse Grok 1.0.0's live questionnaire.
 *
 * Measured shape:
 *   |  Which color should I report?
 *   |  1 (o) Red   Report the color Red
 *   |  2 (o) Blue  Report the color Blue
 *   |  z (o) Type your answer here
 *   |  up/down navigate ... Enter:submit
 *
 * Descriptions share the row with labels, separated by 2+ spaces. The `z` row opens free text and must
 * not be offered as an option. Digits select and submit directly (verified by pressing `2`).
 */
export function parseGrokQuestionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  const footer = lines.findLastIndex((line) => /enter\s*:\s*submit/i.test(line))
  if (footer < 0) return null

  const rows: QuestionRow[] = []
  let start = -1
  for (let i = footer - 1; i >= 0 && footer - i <= 20; i--) {
    const match = /^\s*[┃|]?\s*([0-9a-z])\s+\([^)]*\)\s+(.+?)\s*$/i.exec(lines[i])
    if (!match) continue
    const label = match[2].split(/\s{2,}/)[0].trim()
    rows.unshift({ number: match[1], label, checked: /\([●x*]\)/i.test(lines[i]) })
    start = i
  }
  if (!rows.length || start < 0) return null

  let question = ''
  for (let i = start - 1; i >= 0 && start - i <= 8; i--) {
    const line = lines[i].replace(/^\s*[┃|]\s?/, '').trim()
    if (!line) continue
    question = line
    break
  }
  if (!question) return null

  const typeRow = rows.find((row) => /^type your answer here$/i.test(row.label)) ?? null
  const view: QuestionView = {
    kind: 'question',
    question,
    rows: rows.filter((row) => row !== typeRow),
    // The measured 1.0.0 dialog is single-select; do not infer checkbox semantics from its `(○)` marker.
    multi: false,
    typeRow,
  }
  return view
}
