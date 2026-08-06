import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parseDevinQuestionPane } from './askQuestion.js'
import type { QuestionView } from '../../lib/askQuestion.js'

/**
 * Both fixtures are real `tmux capture-pane -e -J` output from devin 3000.3.22, taken while the dialog was
 * open — including the scrollback of ALREADY ANSWERED questions above it, which is the thing most likely to
 * fool a parser on this engine (devin keeps every `⏺ Asked user …` summary on screen).
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../lib/__fixtures__/${name}`, import.meta.url)), 'utf-8')
}

const single = (): QuestionView => parseDevinQuestionPane(fixture('question-devin.txt')) as QuestionView
const multi = (): QuestionView => parseDevinQuestionPane(fixture('question-devin-multi.txt')) as QuestionView

describe('devin question dialog', () => {
  it('reads the question and its options', () => {
    const view = single()
    expect(view.kind).toBe('question')
    expect(view.question).toBe('Bạn thích màu gì?')
    expect(view.rows.map((r) => [r.number, r.label])).toEqual([['1', 'Xanh'], ['2', 'Đỏ']])
    expect(view.multi).toBe(false)
  })

  it('drops the description line under each option', () => {
    // "Màu xanh dương hoặc xanh lá" sits directly below its row and has no marker; treating it as an
    // option would offer the device an answer no keystroke can reach.
    const labels = single().rows.map((r) => r.label)
    expect(labels).not.toContain('Màu xanh dương hoặc xanh lá')
    expect(labels).toHaveLength(2)
  })

  it('never offers "Other (type your own)" as an option', () => {
    // It opens a text editor rather than selecting anything, and the device's question screen has no
    // input — so an answer of "Other" could never be keyed in.
    for (const view of [single(), multi()]) {
      expect(view.rows.map((r) => r.label)).not.toContain('Other (type your own)')
    }
  })

  it('recognises a multi-select dialog and which boxes are already ticked', () => {
    const view = multi()
    expect(view.multi).toBe(true)
    expect(view.question).toBe('Bạn thích màu nào? (có thể chọn nhiều màu)') // the `(multi-select)` tag is UI, not question
    expect(view.rows.map((r) => [r.number, r.label, r.checked])).toEqual([
      ['1', 'Xanh', false], ['2', 'Đỏ', false], ['3', 'Vàng', false],
    ])
  })

  it('reads the live dialog, not an answered one left in the scrollback', () => {
    // Both fixtures carry earlier `⏺ Asked user …` summaries with their chosen answers above the live
    // dialog; anchoring on the LAST footer is what keeps those out.
    expect(fixture('question-devin.txt')).toContain('Asked user')
    expect(single().question).toBe('Bạn thích màu gì?')
  })

  it('says nothing when no dialog is open', () => {
    expect(parseDevinQuestionPane('')).toBeNull()
    expect(parseDevinQuestionPane('⏺ Asked user Bạn thích màu gì?\n  └ Đỏ\n❭ Ask Devin to build features')).toBeNull()
  })

  it('ignores a footer with no dialog above it', () => {
    expect(parseDevinQuestionPane('some prose\n↑↓ navigate · ↵ select · esc cancel')).toBeNull()
  })
})
