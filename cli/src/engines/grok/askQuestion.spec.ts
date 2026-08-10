import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parseGrokQuestionPane } from './askQuestion.js'

function fixture(): string {
  return readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/question-grok.txt', import.meta.url)), 'utf-8')
}

describe('Grok question dialog', () => {
  it('reads the question and strips same-line descriptions', () => {
    expect(parseGrokQuestionPane(fixture())).toMatchObject({
      kind: 'question',
      question: 'Which color should I report?',
      rows: [
        { number: '1', label: 'Red' },
        { number: '2', label: 'Blue' },
      ],
      multi: false,
    })
  })

  it('keeps the free-text editor out of device options', () => {
    const view = parseGrokQuestionPane(fixture())
    expect(view).toMatchObject({ typeRow: { number: 'z', label: 'Type your answer here' } })
    if (view?.kind !== 'question') throw new Error('fixture did not parse as a question')
    expect(view.rows.some((row) => /type your answer/i.test(row.label))).toBe(false)
  })

  it('does not read old numbered prose without the live footer', () => {
    expect(parseGrokQuestionPane('1 (o) Red\n2 (o) Blue')).toBeNull()
  })
})
