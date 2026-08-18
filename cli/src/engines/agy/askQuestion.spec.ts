import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseQuestionPane } from '../../lib/askQuestion.js'
import { parseAgyQuestionPane } from './askQuestion.js'

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../lib/__fixtures__/${name}`, import.meta.url)), 'utf8')

describe('agy ask-the-user dialog', () => {
  it('reads the question and its options off a real pane', () => {
    const view = parseAgyQuestionPane(read('question-agy.txt'))
    expect(view).not.toBeNull()
    expect(view!.kind).toBe('question')
    const question = view as Extract<typeof view, { kind: 'question' }>
    expect(question.question).toBe('Which colour do you prefer?')
    expect(question.rows.map((r) => r.label)).toEqual(['Red', 'Green', 'Blue'])
    // "Write-in..." opens a free-text editor the device cannot drive, so it must never be offered.
    expect(question.rows.some((r) => /write/i.test(r.label))).toBe(false)
    expect(question.rows.map((r) => r.number)).toEqual(['1', '2', '3'])
  })

  it('does not fire on the permission prompt — the shared parser owns that one', () => {
    expect(parseAgyQuestionPane(read('permission-agy.txt'))).toBeNull()
    expect(parseQuestionPane(read('permission-agy.txt'))).not.toBeNull()
  })

  it('ignores an idle pane', () => {
    expect(parseAgyQuestionPane('> \n? for shortcuts        Gemini 3.7 Flash · high')).toBeNull()
  })
})
