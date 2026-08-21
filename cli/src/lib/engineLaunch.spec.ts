import { describe, expect, it } from 'vitest'
import { BYPASS_PERMISSION_FLAGS, buildEngineLaunchArgv } from './engineLaunch.js'
import { ENGINES } from '../engines/types.js'
import { engineBin } from './engineBin.js'

describe('buildEngineLaunchArgv', () => {
  it('starts with the resolved binary and adds nothing when bypass is not requested', () => {
    expect(buildEngineLaunchArgv('claude')).toEqual([engineBin('claude')])
    expect(buildEngineLaunchArgv('claude', { bypassPermission: false })).toEqual([engineBin('claude')])
  })

  it('appends the confirmed flag for engines with a known bypass flag', () => {
    expect(buildEngineLaunchArgv('claude', { bypassPermission: true }))
      .toEqual([engineBin('claude'), '--dangerously-skip-permissions'])
    expect(buildEngineLaunchArgv('codex', { bypassPermission: true }))
      .toEqual([engineBin('codex'), '--dangerously-bypass-approvals-and-sandbox'])
    expect(buildEngineLaunchArgv('cursor', { bypassPermission: true }))
      .toEqual([engineBin('cursor'), '--force'])
    expect(buildEngineLaunchArgv('opencode', { bypassPermission: true }))
      .toEqual([engineBin('opencode'), '--auto'])
  })

  it('is a no-op for engines with no confirmed flag, even when bypass is requested', () => {
    expect(buildEngineLaunchArgv('pi', { bypassPermission: true })).toEqual([engineBin('pi')])
    expect(buildEngineLaunchArgv('hermes', { bypassPermission: true })).toEqual([engineBin('hermes')])
  })

  it('has an entry (possibly null) for every known engine — no engine silently falls through', () => {
    for (const engine of ENGINES) {
      expect(Object.prototype.hasOwnProperty.call(BYPASS_PERMISSION_FLAGS, engine)).toBe(true)
    }
  })
})
