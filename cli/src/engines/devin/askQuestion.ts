/**
 * Devin's AskUserQuestion dialog, as it paints in the tmux pane.
 *
 * Same job as the shared parser in `lib/askQuestion.ts`, different shape — devin draws its own dialog and
 * none of Claude's anchors exist in it:
 *
 *     ── Màu yêu thích ──────────────────────────────    ← titled rule (tabs when multi-step)
 *       Bạn thích màu nào? (có thể chọn nhiều màu) (multi-select)
 *       ■ 1 Xanh                                        ← marker, number, label
 *           Màu xanh dương hoặc xanh lá                 ← description of the row above, NOT an option
 *       □ 2 Đỏ
 *       □ 3 Other (type your own)
 *     ───────────────────────────────────────────────    ← plain rule
 *     ↑↓ navigate · ␣ toggle · ↵ select · e select+type · ? help me out · esc cancel
 *
 * Differences that matter: rows have NO dot after the number (Claude writes `1. Label`), every row carries
 * a description line beneath it, and single-select rows use `·` / `❭` where multi-select uses `□` / `■`.
 *
 * Key mechanics, measured against devin 3000.3.22 on a live pane rather than read off the footer (which
 * advertises only arrows):
 *   - single-select : typing the row's DIGIT selects and submits in one keystroke, like Claude.
 *   - multi-select  : the digit TOGGLES the box; `Enter` submits (Claude uses Tab here).
 *   - "Other (type your own)" opens a text editor, so it is never offered as an answerable option.
 */

import type { PaneView, QuestionRow } from '../../lib/askQuestion.js'

/** `↑↓ navigate · ␣ toggle · ↵ select · …` — the line that marks a dialog as open. */
const FOOTER_RE = /navigate\s*·.*\bselect\b/i
/** A rule with a title in it: `── Màu yêu thích ──` or the multi-step `── Size ✓ · Màu sắc ──`.
 *  The title may not be made of dashes: `\S` alone also matched a rule of PURE dashes, so the plain
 *  closing rule under the options looked like the opening one and the dialog read as empty. */
const TITLED_RULE_RE = /^\s*─{2,}\s*[^─\s][^─]*─{2,}\s*$/
const PLAIN_RULE_RE = /^\s*─{2,}\s*$/
/** Marker, optional number, label. The description lines below a row carry neither, so they never match. */
const ROW_RE = /^\s*([❭❯›>·□■☑✔])\s+(?:(\d+)\s+)?(\S.*?)\s*$/
const OTHER_RE = /^other\s*\(type your own\)$/i
const CHECKED = new Set(['■', '☑', '✔'])

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

/**
 * The open devin dialog in `capture`, or null when there is none.
 *
 * Anchored on the LAST footer in the capture and read upward, because a devin pane keeps every answered
 * question in its scrollback (`⏺ Asked user …`) and an earlier dialog must never be mistaken for the live
 * one.
 */
export function parseDevinQuestionPane(capture: string): PaneView {
  const lines = stripAnsi(capture).replace(/\u00a0/g, ' ').split('\n')
  const footer = lines.findLastIndex((line) => FOOTER_RE.test(line))
  if (footer < 0) return null

  // Above the footer: the plain closing rule, the rows, then the titled rule that opens the dialog.
  let top = -1
  for (let i = footer - 1; i >= 0 && footer - i < 40; i--) {
    if (TITLED_RULE_RE.test(lines[i])) { top = i; break }
  }
  if (top < 0) return null

  const rows: QuestionRow[] = []
  let question = ''
  let multi = false
  for (let i = top + 1; i < footer; i++) {
    const line = lines[i]
    if (PLAIN_RULE_RE.test(line)) break
    const row = ROW_RE.exec(line)
    if (!row) {
      // The first non-row line under the title is the question itself; anything later is a description.
      if (!rows.length && !question && line.trim()) question = line.trim()
      continue
    }
    const [, marker, number, label] = row
    if (CHECKED.has(marker) || marker === '□') multi = true
    // Unnumbered rows cannot be answered by keystroke, and "Other" opens a text editor either way.
    if (!number || OTHER_RE.test(label)) continue
    rows.push({ number, label, checked: CHECKED.has(marker) })
  }

  if (!rows.length) return null
  // Devin also states it outright, which covers a dialog whose boxes are off-screen.
  if (/\(multi-select\)/i.test(question)) multi = true
  return { kind: 'question', question: question.replace(/\s*\(multi-select\)\s*$/i, '').trim(), rows, multi, typeRow: null }
}
