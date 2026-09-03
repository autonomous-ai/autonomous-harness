import { describe, expect, it } from 'vitest'
import { assignmentMatches, classifyGridAssignment } from './gridAssignment.js'
import { parsePsEnviron } from './processEnv.js'

const RELAY = 'https://grid.autonomous.ai/grid-3378218621364f16/relay'

describe('classifyGridAssignment', () => {
  it('reads the endpoint and the pinned model off the process', () => {
    expect(classifyGridAssignment({
      ANTHROPIC_BASE_URL: RELAY,
      ANTHROPIC_MODEL: 'DeepSeek-V4-Flash-0731',
      ANTHROPIC_AUTH_TOKEN: 'gridkey-secret',
    })).toEqual({ baseUrl: RELAY, model: 'DeepSeek-V4-Flash-0731' })
  })

  it('never carries the credential out of the process', () => {
    const assignment = classifyGridAssignment({
      ANTHROPIC_BASE_URL: RELAY,
      ANTHROPIC_AUTH_TOKEN: 'gridkey-secret',
    })
    expect(JSON.stringify(assignment)).not.toContain('gridkey-secret')
    expect(assignment).toEqual({ baseUrl: RELAY, model: null })
  })

  it('leaves an agent the user pointed somewhere else alone', () => {
    // Offering to "move" these away from where they were deliberately sent would be the app
    // overruling a choice it did not make.
    expect(classifyGridAssignment({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toBeNull()
    expect(classifyGridAssignment({ ANTHROPIC_BASE_URL: 'http://localhost:8080/v1' })).toBeNull()
    expect(classifyGridAssignment({})).toBeNull()
    expect(classifyGridAssignment({ ANTHROPIC_BASE_URL: '   ' })).toBeNull()
    expect(classifyGridAssignment({ ANTHROPIC_BASE_URL: 'not a url' })).toBeNull()
  })

  it('reads a real macOS `ps eww` line, which is how this actually arrives', () => {
    const line = `/Users/u/.local/bin/claude --resume abc ANTHROPIC_BASE_URL=${RELAY}`
      + ' ANTHROPIC_AUTH_TOKEN=gridkey-secret ANTHROPIC_MODEL=GLM-4.7-Flash HOME=/Users/u'
    expect(classifyGridAssignment(parsePsEnviron(line)))
      .toEqual({ baseUrl: RELAY, model: 'GLM-4.7-Flash' })
  })
})

describe('assignmentMatches', () => {
  const assignment = { baseUrl: RELAY, model: 'GLM-4.7-Flash' }

  it('matches the grid and the model the user picked', () => {
    expect(assignmentMatches(assignment, 'grid-3378218621364f16', 'GLM-4.7-Flash')).toBe(true)
  })

  it('does not match a different grid, or the same grid on a different model', () => {
    expect(assignmentMatches(assignment, 'grid-e3b210eacc5b4cdf', 'GLM-4.7-Flash')).toBe(false)
    expect(assignmentMatches(assignment, 'grid-3378218621364f16', 'DeepSeek-V4-Flash-0731')).toBe(false)
    expect(assignmentMatches(assignment, 'grid-3378218621364f16', null)).toBe(false)
  })

  it('treats an unknown assignment as not matching, never as fine', () => {
    // The whole point: "we could not tell" must cost a needless move offer, never a silent claim that
    // an agent is already where the user asked for.
    expect(assignmentMatches(null, 'grid-3378218621364f16', null)).toBe(false)
    expect(assignmentMatches(undefined, 'grid-3378218621364f16', null)).toBe(false)
  })

  it('matches an unpinned model only against an unpinned choice', () => {
    const unpinned = { baseUrl: RELAY, model: null }
    expect(assignmentMatches(unpinned, 'grid-3378218621364f16', null)).toBe(true)
    expect(assignmentMatches(unpinned, 'grid-3378218621364f16', 'GLM-4.7-Flash')).toBe(false)
  })
})
