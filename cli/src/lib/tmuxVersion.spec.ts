import { describe, expect, it } from 'vitest'
import { TMUX_SESSION_ENV_MIN, parseTmuxVersion, supportsSessionEnv } from './tmuxVersion.js'

describe('parseTmuxVersion', () => {
  it('reads the shapes tmux -V actually prints', () => {
    expect(parseTmuxVersion('tmux 3.5a\n')).toEqual({ major: 3, minor: 5 })
    expect(parseTmuxVersion('tmux 3.2\n')).toEqual({ major: 3, minor: 2 })
    expect(parseTmuxVersion('tmux next-3.6\n')).toEqual({ major: 3, minor: 6 })
    expect(parseTmuxVersion('tmux openbsd-7.4\n')).toEqual({ major: 7, minor: 4 })
  })

  it('has no answer for a build that prints no number', () => {
    expect(parseTmuxVersion('tmux master\n')).toBeNull()
    expect(parseTmuxVersion('')).toBeNull()
  })
})

describe('supportsSessionEnv', () => {
  it('draws the line at the release that added new-session -e', () => {
    expect(TMUX_SESSION_ENV_MIN).toEqual({ major: 3, minor: 2 })
    expect(supportsSessionEnv({ major: 3, minor: 1 })).toBe(false)
    expect(supportsSessionEnv({ major: 2, minor: 9 })).toBe(false)
    expect(supportsSessionEnv({ major: 3, minor: 2 })).toBe(true)
    expect(supportsSessionEnv({ major: 3, minor: 10 })).toBe(true)
    expect(supportsSessionEnv({ major: 4, minor: 0 })).toBe(true)
  })

  it('treats an unreadable version as capable, so a working tmux is never refused on a guess', () => {
    expect(supportsSessionEnv(null)).toBe(true)
  })
})
