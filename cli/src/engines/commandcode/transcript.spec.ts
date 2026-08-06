import { describe, expect, it } from 'vitest'
import { commandcodeProjectSlug, commandcodeTranscriptPath } from './transcript.js'

describe('the Command Code transcript layout', () => {
  it('slugs a working directory the way the CLI does', () => {
    // Both taken off a real machine: the directory names next to their session's cwd.
    expect(commandcodeProjectSlug('/Users/example/Working/Tmux/Agent-6'))
      .toBe('users-example-working-tmux-agent-6')
    // A dotted segment collapses INTO the dash before it — "/.harness/" is one separator run, not two.
    expect(commandcodeProjectSlug('/Users/example/.harness/cli/data/summary-scratch'))
      .toBe('users-example-harness-cli-data-summary-scratch')
  })

  it('builds the transcript path from cwd and session id', () => {
    const path = commandcodeTranscriptPath('/Users/me/Work/App', 'ae93cc89-0dff-452a-a875-33b1516bbc80')
    expect(path).toMatch(/\/projects\/users-me-work-app\/ae93cc89-0dff-452a-a875-33b1516bbc80\.jsonl$/)
  })

  it('refuses a session id that could escape the projects root', () => {
    // The id becomes a filename. A malformed hook payload must not be able to point the watcher at, say,
    // a file outside COMMANDCODE_HOME.
    expect(commandcodeTranscriptPath('/Users/me/Work/App', '../../../etc/passwd')).toBeNull()
    expect(commandcodeTranscriptPath('/Users/me/Work/App', 'a/b')).toBeNull()
    expect(commandcodeTranscriptPath('/Users/me/Work/App', '..')).toBeNull()
  })

  it('returns null when there is nothing to build from', () => {
    expect(commandcodeTranscriptPath('', 'abc')).toBeNull()
    expect(commandcodeTranscriptPath(null, 'abc')).toBeNull()
    expect(commandcodeTranscriptPath('/Users/me/Work/App', '')).toBeNull()
    expect(commandcodeTranscriptPath('///', 'abc')).toBeNull()   // slug collapses to nothing
  })
})
