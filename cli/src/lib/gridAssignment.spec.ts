import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignmentMatches, classifyGridAssignment, readOpencodeGridAssignment, readPiGridAssignment } from './gridAssignment.js'
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
      // Pi and OpenCode keep their endpoint in a file rather than in the process, so they
      // round-trip through their own probes below — this one only covers what a process carries.
      if (engine === 'pi' || engine === 'opencode') continue
      const built = buildGridEngineLaunch(engine, OVERRIDE)
      expect(built.ok).toBe(true)
      if (!built.ok) continue
      const assignment = classifyGridAssignment(engine, built.launch.env, built.launch.args.join(' '))
      expect(assignment, engine).not.toBeNull()
      expect(assignment?.baseUrl, engine).toContain(NETWORK_ID)
      expect(assignment?.model, engine).toBe('GLM-4.7-Flash')
    }
  })

  it('never carries the credential out of the process', () => {
    for (const engine of gridCapableEngines()) {
      if (engine === 'pi' || engine === 'opencode') continue
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

describe('readOpencodeGridAssignment', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // OpenCode's endpoint lives in the config file this daemon wrote, not in a variable — so the probe
  // reads that file. The regression this guards: while opencode was still listed under
  // BASE_URL_VAR, moving it to a config file made every opencode agent report "own login" in the
  // app, with the grid answering correctly underneath.
  const RELAY = 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1'
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-opencode-cfg-'))
    dirs.push(dir)
    const path = join(dir, 'opencode.json')
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  const config = (baseURL: string, provider = 'autonomous-ai') => ({
    provider: { [provider]: { npm: '@ai-sdk/openai-compatible', options: { baseURL } } },
  })

  it('round-trips the config the LAUNCHER writes, not one written by hand', async () => {
    // The strongest form of this test, and the one that would have caught the regression: build the
    // real launch, write its real files where the probe will look, and read them back. A spec that
    // hand-writes the config proves only that two hand-written shapes agree.
    const built = buildGridEngineLaunch('opencode', OVERRIDE)
    if (!built.ok) throw new Error(built.detail)
    const dir = mkdtempSync(join(tmpdir(), 'opencode-grid-'))
    dirs.push(dir)
    for (const file of built.launch.configDir!.files) {
      writeFileSync(join(dir, file.name), file.content)
    }
    const path = join(dir, built.launch.configDir!.pointAt!)
    const assignment = await readOpencodeGridAssignment(
      { [built.launch.configDir!.envVar]: path },
      `opencode ${built.launch.args.join(' ')}`,
    )
    expect(assignment).not.toBeNull()
    expect(assignment!.baseUrl).toContain(NETWORK_ID)
    expect(assignment!.model).toBe(OVERRIDE.model)
    // And the credential never leaves the process, exactly as for every other engine.
    expect(JSON.stringify(assignment)).not.toContain('gridkey-secret')
  })

  it('reads the endpoint out of the provider the argv selected', async () => {
    const path = write(config(RELAY))
    await expect(readOpencodeGridAssignment(
      { OPENCODE_CONFIG: path },
      'opencode -m autonomous-ai/DeepSeek-V4-Flash-0731',
    )).resolves.toEqual({ baseUrl: RELAY, model: 'DeepSeek-V4-Flash-0731' })
  })

  it('reports the router as the model when that is what was selected', async () => {
    const path = write(config(RELAY))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path }, '-m autonomous-ai/Auto'))
      .resolves.toEqual({ baseUrl: RELAY, model: 'Auto' })
  })

  it('answers null for a provider the argv did not name', async () => {
    // Two grids can be configured side by side; reading the wrong block would report an agent as
    // being on a grid it is not on.
    const path = write(config(RELAY, 'other-grid'))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path }, '-m autonomous-ai/Auto'))
      .resolves.toBeNull()
  })

  it('answers null for an endpoint that is not a relay', async () => {
    const path = write(config('https://api.openai.com/v1'))
    await expect(readOpencodeGridAssignment(
      { OPENCODE_CONFIG: path },
      '-m autonomous-ai/gpt-4o',
    )).resolves.toBeNull()
  })

  it('answers null rather than throwing when the file is gone or unreadable', async () => {
    await expect(readOpencodeGridAssignment(
      { OPENCODE_CONFIG: '/nonexistent/opencode.json' },
      '-m autonomous-ai/Auto',
    )).resolves.toBeNull()
    await expect(readOpencodeGridAssignment({}, '-m autonomous-ai/Auto')).resolves.toBeNull()
  })

  it('answers null when no model was selected on argv', async () => {
    const path = write(config(RELAY))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path }, 'opencode'))
      .resolves.toBeNull()
  })
})
