import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { kiloSelectionKeys, parseKiloQuestionPane } from './askQuestion.js'
import type { QuestionView } from '../../lib/askQuestion.js'

/**
 * A REAL kilo 7.4.20 permission prompt, captured with `tmux capture-pane -p` from a live pane and scrubbed
 * of the home directory. It was triggered the way a web-driven agent triggers it by accident: asking kilo
 * to read a path outside the project, which its default `external_directory: ask` rule blocks.
 */
function pane(): string {
  return readFileSync(fileURLToPath(new URL('../../lib/__fixtures__/question-kilo.txt', import.meta.url)), 'utf-8')
}

describe('kilo permission dialog', () => {
  it('reads the prompt as a question, not as a tool card', () => {
    const view = parseKiloQuestionPane(pane()) as QuestionView
    expect(view?.kind).toBe('question')
    // The question is the request itself — not the box heading above it, and not the `Patterns` list below.
    expect(view.question).toBe('Access external directory /private/etc')
  })

  it('reads the options off the line they SHARE with the key hints', () => {
    const view = parseKiloQuestionPane(pane()) as QuestionView
    expect(view.rows.map((r) => r.label)).toEqual(['Allow once', 'Allow always', 'Reject'])
    // `ctrl+f fullscreen`, `⇆ select` and `enter confirm` sit on the same line; offering any of them as an
    // answer would put a keybinding on the device's question screen.
    expect(view.rows.some((r) => /ctrl|select|confirm|fullscreen/i.test(r.label))).toBe(false)
  })

  it('keeps a way to say no', () => {
    const view = parseKiloQuestionPane(pane()) as QuestionView
    expect(view.rows.map((r) => r.label)).toContain('Reject')
    // Single-select, and no free-text row: every option is chosen, none is typed into.
    expect(view.multi).toBe(false)
    expect(view.typeRow).toBeNull()
  })

  /**
   * The walk is HORIZONTAL. Verified against the live pane: pressing `Right` twice moved kilo's amber
   * highlight from `Allow once` onto `Reject`, and `Enter` then dismissed the dialog and let the turn
   * finish. `Down` does nothing here — the rows are side by side, not stacked.
   */
  it('turns a row into the keystrokes that reach it', () => {
    const view = parseKiloQuestionPane(pane()) as QuestionView
    expect(kiloSelectionKeys(view.rows[0])).toEqual(['Enter'])
    expect(kiloSelectionKeys(view.rows[1])).toEqual(['Right', 'Enter'])
    expect(kiloSelectionKeys(view.rows[2])).toEqual(['Right', 'Right', 'Enter'])
  })

  it('reports no dialog when there is none', () => {
    expect(parseKiloQuestionPane('just some output\n$ ')).toBeNull()
    // A box that explains its own keys but is not a permission prompt must not be answered blindly.
    expect(parseKiloQuestionPane('┃ △ Something Else\n┃  Yes   No      enter confirm')).toBeNull()
    // The title alone is not enough either — without options there is nothing to answer with.
    expect(parseKiloQuestionPane('┃ △ Permission required\n┃  Access external directory /tmp')).toBeNull()
  })
})

/**
 * kilo 7.4.22 added a right-hand status column, and it shares the PHYSICAL LINE with the dialog text.
 * The fixture above is 7.4.20, which had no such column — so the first capture of this dialog looked
 * clean and the pollution only showed up after the engine was upgraded. Lines below are the measured
 * 7.4.22 shape.
 */
describe('kilo 7.4.22 status column', () => {
  const pane = [
    '  ┃  △ Permission required',
    '  ┃    ← Access external directory /private/etc                          • Personal credits          $0.00',
    '  ┃',
    '  ┃  Patterns                                                            /private/tmp/example/work-kilo2',
    '  ┃',
    '  ┃  - /private/etc/*',
    '  ┃',
    '  ┃   Allow once   Allow always   Reject                    ctrl+f fullscreen  ⇆ select  enter confirm',
  ].join('\n')

  it('keeps the credit balance out of what the user is asked to approve', () => {
    const view = parseKiloQuestionPane(pane) as QuestionView
    expect(view.question).toBe('Access external directory /private/etc')
  })

  it('still reads the options, which never shared a line with the column', () => {
    const view = parseKiloQuestionPane(pane) as QuestionView
    expect(view.rows.map((r) => r.label)).toEqual(['Allow once', 'Allow always', 'Reject'])
  })
})
