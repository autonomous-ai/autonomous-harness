import { describe, expect, it } from 'vitest'
import { deviceErrorText } from './deviceErrors.js'

describe('deviceErrorText', () => {
  it('makes Claude submit-verification failures device-friendly', () => {
    expect(deviceErrorText('The agent did not accept the message. Please try again.', 'claude'))
      .toBe("Claude didn't start. Check the terminal, then try again.")
  })

  it('keeps the generic text for non-Claude engines and unrelated errors', () => {
    expect(deviceErrorText('The agent did not accept the message. Please try again.', 'codex'))
      .toBe('The agent did not accept the message. Please try again.')
    expect(deviceErrorText('This agent process is no longer running.', 'claude'))
      .toBe('This agent process is no longer running.')
  })

  it('reduces the Codex usage limit to what the device can act on', () => {
    // Verbatim from a real rollout: a purchase link the device cannot follow, and a reset time that is
    // the only thing the reader can do something about.
    expect(deviceErrorText(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more"
      + ' credits or try again at Aug 5th, 2026 11:09 AM.',
      'codex',
    )).toBe('Codex usage limit reached — try again Aug 5th, 2026 11:09 AM.')

    // Same limit, no reset time offered.
    expect(deviceErrorText("You've hit your usage limit.", 'codex')).toBe('Codex usage limit reached.')
  })

  it('drops links and trace ids from any other engine error', () => {
    expect(deviceErrorText(
      'Error: 500 [object Object] Type "continue" to try again. If the issue persists, contact support:'
      + ' https://commandcode.ai/discord',
      'commandcode',
    )).toBe('Error: 500 [object Object] Type "continue" to try again. If the issue persists, contact support:')

    expect(deviceErrorText(
      'Permission denied: high demand for this model. (trace ID: acb60788b786ddfb16a00ddb3d83b053)',
      'devin',
    )).toBe('Permission denied: high demand for this model.')

    // A message with nothing to strip is passed through untouched.
    expect(deviceErrorText('This agent process is no longer running.', 'pi'))
      .toBe('This agent process is no longer running.')
  })
})
