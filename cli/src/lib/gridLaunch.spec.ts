import { describe, expect, it } from 'vitest'
import {
  anthropicBaseUrl,
  buildGridEngineLaunch,
  describeGridLaunch,
  gridCapableEngines,
  gridConflictingEnvToClear,
  gridProviderId,
  gridEnvVarNames,
  parseGridLaunchOverride,
  relayBaseUrl,
  type GridLaunchOverride,
} from './gridLaunch.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'

/** The shape the desktop actually sends, with values read off the live control plane. */
const WIRE = {
  networkId: 'grid-3378218621364f16',
  networkName: 'autonomous.ai',
  baseUrl: 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1',
  apiKey: 'gridkey-abc123',
}
const RELAY_V1 = WIRE.baseUrl
const RELAY = 'https://grid.autonomous.ai/grid-3378218621364f16/relay'

const OVERRIDE: GridLaunchOverride = { ...WIRE }
const WITH_MODEL: GridLaunchOverride = { ...WIRE, model: 'GLM-4.7-Flash' }

function launchOf(engine: AgentEngine, override = WITH_MODEL) {
  const built = buildGridEngineLaunch(engine, override)
  if (!built.ok) throw new Error(`${engine} was refused: ${built.detail}`)
  return built.launch
}

describe('parseGridLaunchOverride', () => {
  it('reads absent as absent, not as a failure', () => {
    // The whole no-regression promise rests on this: a client with no grid selected sends no field,
    // and must create agents exactly the way it did before grids existed.
    expect(parseGridLaunchOverride(undefined)).toEqual({ state: 'absent' })
    expect(parseGridLaunchOverride(null)).toEqual({ state: 'absent' })
  })

  it('accepts the desktop payload, with and without a model', () => {
    expect(parseGridLaunchOverride(WIRE)).toEqual({ state: 'ok', override: OVERRIDE })
    expect(parseGridLaunchOverride({ ...WIRE, model: 'glm-5.2' }))
      .toEqual({ state: 'ok', override: { ...OVERRIDE, model: 'glm-5.2' } })
  })

  it('names every missing field at once rather than one per round trip', () => {
    const result = parseGridLaunchOverride({ networkId: 'g1' })
    expect(result.state).toBe('invalid')
    expect(result).toMatchObject({ reason: 'grid is missing networkName, baseUrl, apiKey' })
  })

  it('refuses a baseUrl that is not an http(s) address', () => {
    for (const baseUrl of ['relay.example/v1', 'file:///etc/passwd', 'ws://relay.example/v1']) {
      expect(parseGridLaunchOverride({ ...WIRE, baseUrl }).state).toBe('invalid')
    }
  })

  it('refuses control characters, which would corrupt an environment or an argv silently', () => {
    expect(parseGridLaunchOverride({ ...WIRE, apiKey: 'abc\u0007def' }).state).toBe('invalid')
    expect(parseGridLaunchOverride({ ...WIRE, model: 'glm\n5.2' }).state).toBe('invalid')
  })

  it('refuses a present-but-empty model instead of quietly dropping the choice', () => {
    expect(parseGridLaunchOverride({ ...WIRE, model: '   ' }).state).toBe('invalid')
  })

  it('refuses a grid that is not an object', () => {
    expect(parseGridLaunchOverride('autonomous.ai').state).toBe('invalid')
    expect(parseGridLaunchOverride([WIRE]).state).toBe('invalid')
  })
})

describe('relay base URLs', () => {
  it('keeps the /v1 an OpenAI client needs and drops the one Claude Code appends itself', () => {
    expect(relayBaseUrl(RELAY_V1)).toBe(RELAY_V1)
    expect(relayBaseUrl(RELAY)).toBe(RELAY_V1)
    expect(anthropicBaseUrl(RELAY_V1)).toBe(RELAY)
    expect(anthropicBaseUrl(RELAY)).toBe(RELAY)
  })

  it('is trailing-slash tolerant and leaves a lookalike path alone', () => {
    expect(anthropicBaseUrl(`${RELAY}/v1/`)).toBe(RELAY)
    expect(relayBaseUrl(`${RELAY}//`)).toBe(RELAY_V1)
    expect(anthropicBaseUrl(`${RELAY}/av1`)).toBe(`${RELAY}/av1`)
  })
})

describe('the launch each engine gets', () => {
  it('points Claude Code at the Messages root with the bearer variable only', () => {
    expect(launchOf('claude')).toEqual({
      env: {
        ANTHROPIC_BASE_URL: RELAY,
        ANTHROPIC_AUTH_TOKEN: WIRE.apiKey,
        ANTHROPIC_MODEL: 'GLM-4.7-Flash',
      },
      args: [],
    })
    // Setting it too makes Claude Code warn that auth may not work, and it decides nothing.
    expect(launchOf('claude').env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('configures Codex on its command line, keeping the key in the environment', () => {
    const launch = launchOf('codex')
    expect(launch.env).toEqual({ GRID_API_KEY: WIRE.apiKey })
    expect(launch.args.join(' ')).toContain(`model_providers.grid.base_url="${RELAY_V1}"`)
    expect(launch.args.join(' ')).toContain('model_providers.grid.env_key="GRID_API_KEY"')
    // Codex speaks the Responses dialect and rejects `wire_api = "chat"`.
    expect(launch.args.join(' ')).toContain('model_providers.grid.wire_api="responses"')
    expect(launch.args).toContain('-m')
    expect(launch.args).toContain('GLM-4.7-Flash')
  })

  it('uses the OpenAI-compatible pair for Hermes, which honours the endpoint it is given', () => {
    expect(launchOf('hermes').env).toEqual({
      OPENAI_BASE_URL: RELAY_V1,
      OPENAI_API_KEY: WIRE.apiKey,
      HERMES_INFERENCE_MODEL: 'GLM-4.7-Flash',
    })
  })

  it('does NOT use that pair for opencode, which would not honour it', () => {
    // OpenCode reads the endpoint but keeps its compiled-in `openai` catalogue, so the pair produced
    // an engine naming models the grid had never heard of. It declares a provider instead — see the
    // `opencode declares the grid as a provider` block below.
    expect(launchOf('opencode').env).toEqual({ GRID_API_KEY: WIRE.apiKey })
  })

  it('uses xAI\'s model-list base for Grok, with the model on the command line', () => {
    const launch = launchOf('grok')
    expect(launch.env).toEqual({ GROK_MODELS_BASE_URL: RELAY_V1, XAI_API_KEY: WIRE.apiKey })
    expect(launch.args).toEqual(['-m', 'GLM-4.7-Flash'])
  })

  it('uses the documented BYOK trio for Copilot', () => {
    expect(launchOf('copilot').env).toEqual({
      COPILOT_PROVIDER_BASE_URL: RELAY_V1,
      COPILOT_PROVIDER_API_KEY: WIRE.apiKey,
      COPILOT_MODEL: 'GLM-4.7-Flash',
    })
  })

  it('gives Pi a config directory of ours, never the user\'s own', () => {
    const launch = launchOf('pi')
    expect(launch.env).toEqual({ GRID_API_KEY: WIRE.apiKey })
    expect(launch.args).toEqual(['--model', 'grid/GLM-4.7-Flash'])
    const configDir = launch.configDir
    expect(configDir?.envVar).toBe('PI_CODING_AGENT_DIR')
    const models = configDir?.files.find((file) => file.name === 'models.json')
    expect(models).toBeDefined()
    const parsed = JSON.parse(models!.content) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>
    }
    expect(parsed.providers.grid.baseUrl).toBe(RELAY_V1)
    // `openai-completions` makes Pi post to <base>/chat/completions, which the relay serves.
    expect(parsed.providers.grid.api).toBe('openai-completions')
    // An env REFERENCE. Writing the key itself would put a live credential on disk, outliving the
    // agent and every reason it existed.
    expect(parsed.providers.grid.apiKey).toBe('$GRID_API_KEY')
    expect(models!.content).not.toContain(WIRE.apiKey)
  })

  it('hands Pi back the skills the redirection would otherwise hide', () => {
    const settings = launchOf('pi').configDir?.files.find((file) => file.name === 'settings.json')
    const parsed = JSON.parse(settings!.content) as Record<string, unknown>
    expect((parsed.skills as string[])[0]).toContain('.pi')
    // The Grid app set `defaultProjectTrust: always` because it drove Pi headless with nobody there
    // to answer. Here a person is sitting in front of the pane, so the trust prompt stays theirs.
    expect(parsed).not.toHaveProperty('defaultProjectTrust')
  })

  it('refuses Pi without a model — its provider block has to name one', () => {
    expect(buildGridEngineLaunch('pi', OVERRIDE)).toMatchObject({ ok: false, error: 'GRID_MODEL_REQUIRED' })
  })

  it('never puts the key in argv, or on disk, for any engine', () => {
    // `ps` is world-readable for the life of the process; the environment is not.
    for (const engine of gridCapableEngines()) {
      const launch = launchOf(engine)
      expect(launch.args.join(' '), engine).not.toContain(WIRE.apiKey)
      expect(Object.values(launch.env), engine).toContain(WIRE.apiKey)
      for (const file of launch.configDir?.files ?? []) {
        expect(file.content, `${engine}/${file.name}`).not.toContain(WIRE.apiKey)
      }
    }
  })

  it('leaves the model to the engine when the user picked none', () => {
    expect(launchOf('claude', OVERRIDE).env).not.toHaveProperty('ANTHROPIC_MODEL')
    expect(launchOf('hermes', OVERRIDE).env).not.toHaveProperty('HERMES_INFERENCE_MODEL')
    expect(launchOf('grok', OVERRIDE).args).toEqual([])
    expect(launchOf('codex', OVERRIDE).args).not.toContain('-m')
  })

  it('refuses Copilot without a model rather than letting it fail inside the app', () => {
    const built = buildGridEngineLaunch('copilot', OVERRIDE)
    expect(built).toMatchObject({ ok: false, error: 'GRID_MODEL_REQUIRED' })
  })
})

describe('the engines that cannot', () => {
  it('refuses each one with a reason specific to that engine', () => {
    const capable = new Set(gridCapableEngines())
    const refused = ENGINES.filter((engine) => !capable.has(engine))
    expect(refused.length).toBeGreaterThan(0)
    for (const engine of refused) {
      const built = buildGridEngineLaunch(engine, OVERRIDE)
      expect(built.ok).toBe(false)
      if (built.ok) continue
      expect(built.error).toBe('GRID_ENGINE_UNSUPPORTED')
      expect(built.detail).toContain(OVERRIDE.networkName)
      // "unsupported" alone tells nobody whether to wait, change a setting, or pick another engine.
      expect(built.detail).not.toContain('it has no known way to change its endpoint')
      expect(built.detail).toContain('Engines that can:')
    }
  })

  it('lists exactly the engines with a verified vendor contract', () => {
    expect([...gridCapableEngines()].sort())
      .toEqual(['claude', 'codex', 'copilot', 'grok', 'hermes', 'opencode', 'pi'])
  })
})

describe('describeGridLaunch', () => {
  it('names the grid and the model, and never the key', () => {
    const line = describeGridLaunch('claude', WITH_MODEL)
    expect(line).toContain('autonomous.ai')
    expect(line).toContain('GLM-4.7-Flash')
    expect(line).not.toContain(WIRE.apiKey)
    expect(describeGridLaunch('claude', OVERRIDE)).not.toContain(WIRE.apiKey)
  })
})

describe('gridEnvVarNames', () => {
  // Derived from the contract rather than listed by hand: a second list would drift the first time
  // an engine's contract gained a variable, and the symptom would be a "cleared" agent still running
  // on the grid it was supposedly moved off.
  it('names every variable claude is launched with', () => {
    expect(gridEnvVarNames('claude').sort())
      .toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'])
  })

  it('includes the config-dir pointer for an engine that uses one', () => {
    expect(gridEnvVarNames('pi')).toContain('PI_CODING_AGENT_DIR')
  })

  it('is empty for an engine that cannot be pointed at a grid', () => {
    expect(gridEnvVarNames('amp')).toEqual([])
  })
})

describe('gridConflictingEnvToClear', () => {
  const override = {
    networkId: 'grid-x',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-x/relay/v1',
    apiKey: 'RELAY-KEY',
  }
  const clearedFor = (engine: AgentEngine, model?: string): string[] => {
    const built = buildGridEngineLaunch(engine, model ? { ...override, model } : override)
    if (!built.ok) throw new Error(`${engine} refused: ${JSON.stringify(built)}`)
    return gridConflictingEnvToClear(built.launch)
  }

  it('never clears a variable the same launch sets', () => {
    for (const engine of ['claude', 'codex', 'opencode', 'hermes', 'grok', 'copilot', 'pi'] as const) {
      const built = buildGridEngineLaunch(engine, { ...override, model: 'a-model' })
      if (!built.ok) throw new Error(`${engine} refused`)
      const set = new Set(Object.keys(built.launch.env))
      if (built.launch.configDir) set.add(built.launch.configDir.envVar)
      for (const name of gridConflictingEnvToClear(built.launch)) {
        expect(set.has(name), `${engine} both sets and clears ${name}`).toBe(false)
      }
    }
  })

  it("clears the key that redirected OpenCode away from the grid it was handed", () => {
    // The regression this exists for: OpenCode was given OPENAI_BASE_URL for a grid, found an
    // inherited ANTHROPIC_API_KEY, and spent it on api.anthropic.com instead.
    expect(clearedFor('opencode')).toContain('ANTHROPIC_API_KEY')
    // And OPENAI_* goes too, now that opencode brings its own provider: leaving the user's own
    // OpenAI key in place would re-arm the built-in catalogue this launch exists to get away from.
    expect(clearedFor('opencode')).toContain('OPENAI_BASE_URL')
    expect(clearedFor('opencode')).toContain('OPENAI_API_KEY')
    // Its own variable is the one thing kept.
    expect(clearedFor('opencode')).not.toContain('GRID_API_KEY')
  })

  it('clears the personal Anthropic key even for Claude, whose grid uses the bearer variable', () => {
    // Claude Code warns when both are set and the relay wants the Bearer; leaving the API key behind
    // is what let a dotfile decide which one won.
    expect(clearedFor('claude')).toContain('ANTHROPIC_API_KEY')
    expect(clearedFor('claude')).not.toContain('ANTHROPIC_AUTH_TOKEN')
    expect(clearedFor('claude')).not.toContain('ANTHROPIC_BASE_URL')
  })

  it('keeps ANTHROPIC_MODEL only when the launch pins one', () => {
    expect(clearedFor('claude')).toContain('ANTHROPIC_MODEL')
    expect(clearedFor('claude', 'DeepSeek-V4-Flash-0731')).not.toContain('ANTHROPIC_MODEL')
  })

  it('leaves codex its GRID_API_KEY and clears every vendor variable around it', () => {
    const cleared = clearedFor('codex')
    expect(cleared).not.toContain('GRID_API_KEY')
    expect(cleared).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']))
  })
})

describe('opencode declares the grid as a provider', () => {
  const base: GridLaunchOverride = {
    networkId: 'grid-x',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-x/relay/v1',
    apiKey: 'RELAY-KEY',
  }
  const launch = (model?: string) => {
    const built = buildGridEngineLaunch('opencode', model ? { ...base, model } : base)
    if (!built.ok) throw new Error('opencode refused')
    return built.launch
  }
  const config = (model?: string) => JSON.parse(launch(model).configDir!.files[0].content)

  it('slugifies a grid name into something a person can type as <id>/<model>', () => {
    expect(gridProviderId('autonomous.ai')).toBe('autonomous-ai')
    expect(gridProviderId('private autonomous')).toBe('private-autonomous')
    expect(gridProviderId('macOS')).toBe('macos')
    // Nothing left to slug: an empty provider key would make the config unparseable.
    expect(gridProviderId('...')).toBe('grid')
  })

  it('never writes a top-level `model`, which OpenCode validates against a closed enum', () => {
    // A private grid's model is not in that enum, so this key would make OpenCode refuse the whole
    // config at startup — arriving as a dead pane well after the launch looked fine.
    expect(config('DeepSeek-V4-Flash-0731')).not.toHaveProperty('model')
    expect(config()).not.toHaveProperty('model')
  })

  it('selects the model on argv instead, which is not schema-validated', () => {
    expect(launch('DeepSeek-V4-Flash-0731').args).toEqual(['-m', 'autonomous-ai/DeepSeek-V4-Flash-0731'])
  })

  it("falls back to the grid's router when no model was chosen", () => {
    expect(launch().args).toEqual(['-m', 'autonomous-ai/Auto'])
  })

  it('writes EXACTLY ONE model, which is what the probe reads back', () => {
    // `readOpencodeGridAssignment` answers "which model is this agent on" from this file alone,
    // precisely so it never has to parse a live process's argv — which flickered. A second entry
    // here would leave that question unanswerable and the probe would go back to saying nothing.
    expect(Object.keys(config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].models))
      .toEqual(['DeepSeek-V4-Flash-0731'])
    expect(Object.keys(config().provider['autonomous-ai'].models)).toEqual(['Auto'])
  })

  it('keeps the key out of the file and references it from the environment', () => {
    const written = launch('DeepSeek-V4-Flash-0731')
    expect(written.configDir!.files[0].content).not.toContain('RELAY-KEY')
    expect(written.env).toEqual({ GRID_API_KEY: 'RELAY-KEY' })
    expect(config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].options.apiKey)
      .toBe('{env:GRID_API_KEY}')
  })

  it('does not set OPENAI_* beside its own provider', () => {
    // Those would re-arm OpenCode's built-in `openai` provider, whose compiled-in catalogue is what
    // picked a model the grid answered 503 for.
    expect(launch('DeepSeek-V4-Flash-0731').env).not.toHaveProperty('OPENAI_BASE_URL')
    expect(launch('DeepSeek-V4-Flash-0731').env).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('passes the relay root through verbatim — the SDK appends the path itself', () => {
    expect(config().provider['autonomous-ai'].options.baseURL).toBe(base.baseUrl)
  })

  it('omits `limit` entirely rather than writing half of one', () => {
    // OpenCode requires `context` and `output` together and rejects the config given only one.
    const models = config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].models
    for (const entry of Object.values(models)) expect(entry).not.toHaveProperty('limit')
  })

  it('points OPENCODE_CONFIG at the file, not at the directory holding it', () => {
    expect(launch().configDir!.envVar).toBe('OPENCODE_CONFIG')
    expect(launch().configDir!.pointAt).toBe('opencode.json')
  })
})
