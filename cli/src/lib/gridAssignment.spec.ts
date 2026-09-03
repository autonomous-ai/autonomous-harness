import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignmentMatches, classifyGridAssignment, readPiGridAssignment } from './gridAssignment.js'
import { buildGridEngineLaunch, gridCapableEngines, type GridLaunchOverride } from './gridLaunch.js'
import { clearProcessEnvCache, parsePsEnviron } from './processEnv.js'

const NETWORK_ID = 'grid-3378218621364f16'
const RELAY = `https://grid.autonomous.ai/${NETWORK_ID}/relay`
const RELAY_V1 = `${RELAY}/v1`

const OVERRIDE: GridLaunchOverride = {
  networkId: NETWORK_ID,
  networkName: 'autonomous.ai',
  baseUrl: RELAY_V1,
  apiKey: 'gridkey-secret',
  model: 'GLM-4.7-Flash',
}

describe('classifyGridAssignment', () => {
  it('reads back what every supported engine was actually launched with', () => {
    // The point of the round trip: the probe and the launcher must use the SAME knob per engine, or
    // an agent that IS on a grid reports as being on none and gets pointlessly restarted.
    for (const engine of gridCapableEngines()) {
      // Pi's endpoint is in a file rather than the process, so it round-trips through the probe
      // below instead — this one only covers what a process carries.
      if (engine === 'pi') continue
      const built = buildGridEngineLaunch(engine, OVERRIDE)
      expect(built.ok).toBe(true)
      if (!built.ok) continue
      const assignment = classifyGridAssignment(engine, built.launch.env, built.launch.args.join(' '))
      expect(assignment, engine).not.toBeNull()
      expect(assignment?.baseUrl, engine).toContain(NETWORK_ID)
      // opencode is the one engine with no verified model knob, so its model stays the app's own.
      expect(assignment?.model, engine).toBe(engine === 'opencode' ? null : 'GLM-4.7-Flash')
    }
  })

  it('never carries the credential out of the process', () => {
    for (const engine of gridCapableEngines()) {
      if (engine === 'pi') continue
      const built = buildGridEngineLaunch(engine, OVERRIDE)
      if (!built.ok) continue
      const assignment = classifyGridAssignment(engine, built.launch.env, built.launch.args.join(' '))
      expect(JSON.stringify(assignment), engine).not.toContain('gridkey-secret')
    }
  })

  it('leaves an agent the user pointed somewhere else alone', () => {
    // Offering to "move" these away from where they were deliberately sent would be the app
    // overruling a choice it did not make.
    expect(classifyGridAssignment('claude', { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toBeNull()
    expect(classifyGridAssignment('opencode', { OPENAI_BASE_URL: 'http://localhost:8080/v1' })).toBeNull()
    expect(classifyGridAssignment('claude', {})).toBeNull()
    expect(classifyGridAssignment('claude', { ANTHROPIC_BASE_URL: '   ' })).toBeNull()
    expect(classifyGridAssignment('claude', { ANTHROPIC_BASE_URL: 'not a url' })).toBeNull()
  })

  it('reads Codex off its argv, where its endpoint actually lives', () => {
    const args = `codex -c model_provider="grid" -c model_providers.grid.base_url="${RELAY_V1}" -m GLM-4.7-Flash`
    expect(classifyGridAssignment('codex', { GRID_API_KEY: 'gridkey-secret' }, args))
      .toEqual({ baseUrl: RELAY_V1, model: 'GLM-4.7-Flash' })
    // Its environment alone says nothing — reading only env would report every codex agent as free.
    expect(classifyGridAssignment('codex', { GRID_API_KEY: 'gridkey-secret' })).toBeNull()
  })

  it('does not confuse one engine\'s knob for another\'s', () => {
    // A grok agent whose OPENAI_BASE_URL happens to be set by the user's shell is not on a grid.
    expect(classifyGridAssignment('grok', { OPENAI_BASE_URL: RELAY_V1 })).toBeNull()
    expect(classifyGridAssignment('copilot', { ANTHROPIC_BASE_URL: RELAY })).toBeNull()
  })

  it('reads a real macOS `ps eww` line, which is how this actually arrives', () => {
    const line = `/Users/u/.local/bin/claude --resume abc ANTHROPIC_BASE_URL=${RELAY}`
      + ' ANTHROPIC_AUTH_TOKEN=gridkey-secret ANTHROPIC_MODEL=GLM-4.7-Flash HOME=/Users/u'
    expect(classifyGridAssignment('claude', parsePsEnviron(line)))
      .toEqual({ baseUrl: RELAY, model: 'GLM-4.7-Flash' })
  })

  it('has no answer for an engine that cannot be on a grid at all', () => {
    expect(classifyGridAssignment('cursor', { ANTHROPIC_BASE_URL: RELAY })).toBeNull()
  })
})

describe('Pi, whose endpoint lives in a file', () => {
  const dirs: string[] = []
  afterEach(() => {
    clearProcessEnvCache()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Writes the launch's own config files where the probe will look for them. */
  function materialize(): { dir: string; args: string } {
    const built = buildGridEngineLaunch('pi', OVERRIDE)
    if (!built.ok) throw new Error(built.detail)
    const dir = mkdtempSync(join(tmpdir(), 'pi-grid-'))
    dirs.push(dir)
    for (const file of built.launch.configDir!.files) writeFileSync(join(dir, file.name), file.content)
    return { dir, args: `pi ${built.launch.args.join(' ')}` }
  }

  it('round-trips: what the launcher wrote is what the probe reads back', async () => {
    const { dir, args } = materialize()
    // Parsed from a real macOS `ps eww` line — argv first, then the environment — so the shape the
    // probe is handed at runtime is the shape under test.
    const env = parsePsEnviron(`${args} PI_CODING_AGENT_DIR=${dir} GRID_API_KEY=gridkey-secret`)
    await expect(readPiGridAssignment(env, args)).resolves.toEqual({
      baseUrl: RELAY_V1,
      model: 'GLM-4.7-Flash',
    })
    await expect(readPiGridAssignment(env, args)).resolves.toSatisfy(
      (a: { baseUrl: string; model: string | null }) => assignmentMatches(a, NETWORK_ID, 'GLM-4.7-Flash'),
    )
  })

  it('a config directory that is gone reads as unknown, not as fine', async () => {
    const { dir, args } = materialize()
    const env = parsePsEnviron(`${args} PI_CODING_AGENT_DIR=${dir}`)
    rmSync(dir, { recursive: true, force: true })
    // Nothing to read → null → the app offers a move rather than claiming the agent is in place.
    await expect(readPiGridAssignment(env, args)).resolves.toBeNull()
  })

  it('reads nothing when the pane was never given a config directory', async () => {
    const { args } = materialize()
    await expect(readPiGridAssignment({}, args)).resolves.toBeNull()
  })

  it('will not call a provider pointed somewhere else a grid', async () => {
    const { dir, args } = materialize()
    writeFileSync(join(dir, 'models.json'), JSON.stringify({
      providers: { grid: { baseUrl: 'https://api.openai.com/v1' } },
    }))
    const env = parsePsEnviron(`${args} PI_CODING_AGENT_DIR=${dir}`)
    await expect(readPiGridAssignment(env, args)).resolves.toBeNull()
  })
})

describe('assignmentMatches', () => {
  const assignment = { baseUrl: RELAY, model: 'GLM-4.7-Flash' }

  it('matches the grid and the model the user picked', () => {
    expect(assignmentMatches(assignment, NETWORK_ID, 'GLM-4.7-Flash')).toBe(true)
  })

  it('does not match a different grid, or the same grid on a different model', () => {
    expect(assignmentMatches(assignment, 'grid-e3b210eacc5b4cdf', 'GLM-4.7-Flash')).toBe(false)
    expect(assignmentMatches(assignment, NETWORK_ID, 'DeepSeek-V4-Flash-0731')).toBe(false)
    expect(assignmentMatches(assignment, NETWORK_ID, null)).toBe(false)
  })

  it('treats an unknown assignment as not matching, never as fine', () => {
    // The whole point: "we could not tell" must cost a needless move offer, never a silent claim that
    // an agent is already where the user asked for.
    expect(assignmentMatches(null, NETWORK_ID, null)).toBe(false)
    expect(assignmentMatches(undefined, NETWORK_ID, null)).toBe(false)
  })

  it('matches an unpinned model only against an unpinned choice', () => {
    const unpinned = { baseUrl: RELAY, model: null }
    expect(assignmentMatches(unpinned, NETWORK_ID, null)).toBe(true)
    expect(assignmentMatches(unpinned, NETWORK_ID, 'GLM-4.7-Flash')).toBe(false)
  })
})
