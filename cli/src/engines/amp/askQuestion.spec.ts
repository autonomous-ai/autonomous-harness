import { describe, expect, it } from 'vitest'
import { ampSelectionKeys, parseAmpQuestionPane } from './askQuestion.js'
import type { QuestionView } from '../../lib/askQuestion.js'

/**
 * Captured from a live pane (amp 0.0.1786064749) with `amp permissions add ask shell_command` in effect,
 * trimmed only in width. The scrollbar column (`█`), the wrapped `workdir` value and the unnumbered rows
 * are all exactly as Amp drew them.
 */
const PANE = `
                    ╭─ Approval Required ──────────────────────────────────────────────────────────╮
                    │                                                                              │
                    │ shell_command:                                                             █ │
                    │   {                                                                        █ │
                    │     "command": "echo probe123",                                            █ │
                    │     "workdir":                                                             █ │
                    │ "/private/tmp/claude-502/-Users-nqhieu84-go-src-github-com-autonomous-ai-au█ │
                    │ tonomous-code/4e2858a3/scratchpad/amp-probe"                               █ │
                    │   }                                                                        █ │
                    │                                                                            █ │
                    │                                                                              │
                    │ ‣ Allow Once                                                                 │
                    │   Reject with feedback                                                       │
                    │   Allow All for This Session                                                 │
                    │   Allow All for Every Session                                                │
                    │                                                                              │
                    ╰──────────── ↑/↓/j/k move · Enter select · Ctrl+E/Ctrl+Y scroll · Esc cancel ─╯
 ┃ run the shell command: echo probe123
`

describe('amp approval dialog', () => {
  it('reads all four options in the order Amp draws them', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    expect(view?.kind).toBe('question')
    expect(view.rows.map((r) => r.label)).toEqual([
      'Allow Once', 'Reject with feedback', 'Allow All for This Session', 'Allow All for Every Session',
    ])
    expect(view.multi).toBe(false)
  })

  /**
   * "Reject with feedback" opens a free-text editor, which the device cannot type into — the same shape as
   * muse's "None of the above", which IS dropped. It is kept here because it is the only way to say no:
   * dropping it would leave a device user with four ways to approve and none to refuse.
   */
  it('keeps the refusal option even though it opens an editor', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    expect(view.rows.map((r) => r.label)).toContain('Reject with feedback')
  })

  it('names what is being approved, with the argument that fits on one line', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    // The wrapped `workdir` is deliberately not reassembled — only a whole pair on one line is used.
    expect(view.question).toBe('Approve shell_command: echo probe123')
  })

  it('walks to a row instead of pressing a digit', () => {
    const view = parseAmpQuestionPane(PANE) as QuestionView
    // Amp's list has no numbers: the first row is already highlighted, the rest are N presses away.
    expect(ampSelectionKeys(view.rows[0])).toEqual(['Enter'])
    expect(ampSelectionKeys(view.rows[1])).toEqual(['Down', 'Enter'])
    expect(ampSelectionKeys(view.rows[3])).toEqual(['Down', 'Down', 'Down', 'Enter'])
  })

  it('ignores a pane with no dialog on it', () => {
    expect(parseAmpQuestionPane('just some output\n$ ')).toBeNull()
    // A box that explains its own keys but is NOT an approval must not be scraped into a question —
    // the title is what proves it, and this is why the footer alone is not enough.
    expect(parseAmpQuestionPane('╭─ Something Else ─╮\n│ ‣ Yes │\n│   No │\n╰─ Enter select ─╯')).toBeNull()
  })

  it('anchors on the LAST dialog, so an answered one in the scrollback is not re-read', () => {
    const twice = `${PANE}\n${PANE.replace('echo probe123', 'echo second')}`
    const view = parseAmpQuestionPane(twice) as QuestionView
    expect(view.question).toBe('Approve shell_command: echo second')
  })
})
