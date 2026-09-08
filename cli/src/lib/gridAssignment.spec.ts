import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignmentMatches, classifyGridAssignment, probeGridAssignment, readOpencodeGridAssignment, readPiGridAssignment } from './gridAssignment.js'
import { buildGridEngineLaunch, gridCapableEngines, type GridLaunchOverride } from './gridLaunch.js'
import type { AgentEngine } from '../engines/types.js'
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

/** The same launch with the grid's web tools wired in — see `gridLaunch`'s MCP section. */
const WITH_MCP: GridLaunchOverride = {
  ...OVERRIDE,
  mcpUrl: 'https://api-grid.autonomous.ai/v1/grid/web-mcp/',
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

  // OpenCode's endpoint lives in the config file this daemon wrote, not in a variable. Two
  // regressions are pinned here:
  //  * listing opencode under BASE_URL_VAR while its endpoint had moved made every opencode agent
  //    report "own login" while the grid answered correctly underneath;
  //  * reading the model out of argv made the app's pill flicker between the model and "own login"
  //    while the agent was answering, because a live process may rewrite its command line.
  const RELAY = 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1'
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-opencode-cfg-'))
    dirs.push(dir)
    const path = join(dir, 'opencode.json')
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  const config = (baseURL: string, models: string[] = ['DeepSeek-V4-Flash-0731']) => ({
    provider: {
      'autonomous-ai': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL },
        models: Object.fromEntries(models.map((m) => [m, { name: m }])),
      },
    },
  })

  it('round-trips the config the LAUNCHER writes, not one written by hand', async () => {
    // The strongest form of this test: build the real launch, write its real files where the probe
    // will look, and read them back. A spec that hand-writes the config proves only that two
    // hand-written shapes agree.
    const built = buildGridEngineLaunch('opencode', OVERRIDE)
    if (!built.ok) throw new Error(built.detail)
    const dir = mkdtempSync(join(tmpdir(), 'opencode-grid-'))
    dirs.push(dir)
    for (const file of built.launch.configDir!.files) {
      writeFileSync(join(dir, file.name), file.content)
    }
    const assignment = await readOpencodeGridAssignment({
      [built.launch.configDir!.envVar]: join(dir, built.launch.configDir!.pointAt!),
    })
    expect(assignment).not.toBeNull()
    expect(assignment!.baseUrl).toContain(NETWORK_ID)
    expect(assignment!.model).toBe(OVERRIDE.model)
    // And the credential never leaves the process, exactly as for every other engine.
    expect(JSON.stringify(assignment)).not.toContain('gridkey-secret')
  })

  it('reports the router as NO model, the way every other engine does', async () => {
    // OpenCode is the only engine whose provider block must name something, so a launch with no
    // model picked writes the relay's router id there. Letting that id back out would be the app's
    // own "Auto" under a second name: the header would print the raw id, and `assignmentMatches`
    // would compare it against null and call every such agent mis-targeted forever.
    const path = write(config(RELAY, ['Auto']))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path }))
      .resolves.toEqual({ baseUrl: RELAY, model: null })
  })

  it('answers the same whatever the engine has done to its command line', async () => {
    // The flicker: argv is a live process's to rewrite, so nothing here may depend on it.
    const path = write(config(RELAY))
    const expected = { baseUrl: RELAY, model: 'DeepSeek-V4-Flash-0731' }
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path })).resolves.toEqual(expected)
  })

  it('answers null for an endpoint that is not a relay', async () => {
    const path = write(config('https://api.openai.com/v1'))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path })).resolves.toBeNull()
  })

  it('answers null for a file this launch did not write', async () => {
    // A user's own config can carry several providers; guessing which one an engine would pick
    // would report an agent as being on a grid it is not on.
    const path = write({
      provider: {
        'autonomous-ai': { options: { baseURL: RELAY }, models: { a: {} } },
        other: { options: { baseURL: RELAY } },
      },
    })
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path })).resolves.toBeNull()
  })

  it('answers null when the provider names more than one model', async () => {
    // Then the file cannot say which one is live, and a guess would be reported as a measurement.
    const path = write(config(RELAY, ['DeepSeek-V4-Flash-0731', 'Auto']))
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: path })).resolves.toBeNull()
  })

  it('answers null rather than throwing when the file is gone or unreadable', async () => {
    await expect(readOpencodeGridAssignment({ OPENCODE_CONFIG: '/nonexistent/opencode.json' }))
      .resolves.toBeNull()
    await expect(readOpencodeGridAssignment({})).resolves.toBeNull()
  })
})

describe('a failed read is not a finding', () => {
  // The flicker this pins: the app's grid pill swapped between an agent's model and "own login" for
  // the length of every turn. Each probe whose `ps` did not answer in time reported "on no grid",
  // the registry wrote that over a known-good assignment, and the next successful probe put it back.
  //
  // The distinction is the fix, not the failure rate. A read can fail for reasons this code will
  // never enumerate — a busy machine, a 2s timeout, a process caught mid-exec — and none of them are
  // evidence about where an agent is pointed.
  const DEAD_PID = 2 ** 31 - 1

  it('answers undefined when the environment cannot be read at all', async () => {
    clearProcessEnvCache()
    await expect(probeGridAssignment(
      { pid: DEAD_PID, executable: 'opencode', startMarker: 'Mon Jan  1 00:00:00 2035' },
      'opencode',
    )).resolves.toBeUndefined()
  })

  it('is distinguishable from a read that found no grid', () => {
    // Same call shape, opposite meaning: this one looked and there was nothing.
    expect(classifyGridAssignment('claude', { PATH: '/usr/bin' })).toBeNull()
    // `null == undefined` is true, so only a strict check tells these apart — which is exactly what
    // `openProcessAgent` and `updateProcessIdentity` do.
    expect(classifyGridAssignment('claude', { PATH: '/usr/bin' })).not.toBeUndefined()
  })
})

describe('web tools do not disturb the probe', () => {
  // Wiring MCP adds argv to Codex and a key to OpenCode's config file, and both are things the probe
  // parses. An agent that IS on a grid reporting as being on none gets pointlessly restarted, so the
  // round trips above are repeated against the shape a launch with web tools produces.
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const classify = (engine: AgentEngine, override: GridLaunchOverride) => {
    const built = buildGridEngineLaunch(engine, override)
    if (!built.ok) throw new Error(`${engine}: ${built.detail}`)
    return classifyGridAssignment(engine, built.launch.env, built.launch.args.join(' '))
  }

  it('reads a process back identically with the MCP argv in the way', () => {
    for (const engine of gridCapableEngines()) {
      if (engine === 'pi' || engine === 'opencode') continue
      // Compared against the same engine launched WITHOUT web tools rather than a literal, so this
      // states the invariant — wiring MCP changes nothing the probe reads — in a form that survives
      // an engine changing which URL shape it wants.
      expect(classify(engine, WITH_MCP), engine).toEqual(classify(engine, OVERRIDE))
      expect(classify(engine, WITH_MCP)?.model, engine).toBe('GLM-4.7-Flash')
    }
  })

  it('never reads the control plane as the place an agent is running', () => {
    // Codex is the one at risk: its endpoint comes out of argv, which now also carries
    // `mcp_servers.grid_web.url=…`. Reading that as the endpoint would report an agent as running on
    // the control plane, and the app would offer to move it off a grid it is already on.
    expect(classify('codex', WITH_MCP)?.baseUrl).toBe(RELAY_V1)
  })

  it("reads OpenCode's config back with the server declared beside the provider", async () => {
    const built = buildGridEngineLaunch('opencode', WITH_MCP)
    if (!built.ok) throw new Error(built.detail)
    const dir = mkdtempSync(join(tmpdir(), 'opencode-grid-mcp-'))
    dirs.push(dir)
    for (const file of built.launch.configDir!.files) {
      writeFileSync(join(dir, file.name), file.content)
    }
    const assignment = await readOpencodeGridAssignment({
      [built.launch.configDir!.envVar]: join(dir, built.launch.configDir!.pointAt!),
    })
    expect(assignment).toEqual({ baseUrl: RELAY_V1, model: 'GLM-4.7-Flash' })
  })
})
