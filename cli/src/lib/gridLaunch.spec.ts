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
import { buildEngineLaunchArgv } from './engineLaunch.js'

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
/** The control plane's web-tools mount, trailing slash and all — see `GridLaunchOverride.mcpUrl`. */
const MCP_URL = 'https://api-grid.autonomous.ai/v1/grid/web-mcp/'
const WITH_MCP: GridLaunchOverride = { ...WITH_MODEL, mcpUrl: MCP_URL }

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

  it('uses the OpenAI-compatible pair for Hermes, with the model on the command line too', () => {
    const launch = launchOf('hermes')
    expect(launch.env).toEqual({
      OPENAI_BASE_URL: RELAY_V1,
      OPENAI_API_KEY: WIRE.apiKey,
      HERMES_INFERENCE_MODEL: 'GLM-4.7-Flash',
    })
    // The variable alone was measured to decide nothing: the pane this daemon opens is hermes'
    // INTERACTIVE CLI, which reads its model from `-m` then config.yaml and from no environment
    // tier — and a grid move relaunches it as `hermes --resume <id>`, which puts the model stored
    // on the session row back unless argv carried an explicit `-m`. The pill read GLM-4.7-Flash
    // out of the environment while the pane ran the config's DeepSeek-V4-Flash-0731.
    expect(launch.args).toEqual(['-m', 'GLM-4.7-Flash'])
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

  it('routes Pi through Auto when the user picked no model, rather than refusing', () => {
    // Pi's provider block has to name a model, so "none" cannot be left blank — but the answer is
    // the router's own id, the way OpenCode's block already does it, not a refusal. This was
    // GRID_MODEL_REQUIRED, which made Pi the one grid-capable engine the New agent dialog could
    // never start: that dialog always creates on Auto and offers no model field.
    const launch = launchOf('pi', OVERRIDE)
    expect(launch.args).toEqual(['--model', 'grid/Auto'])
    const models = launch.configDir?.files.find((file) => file.name === 'models.json')
    const parsed = JSON.parse(models!.content) as {
      providers: Record<string, { models: { id: string; name: string }[] }>
    }
    // Named in the block too, not just in argv — Pi resolves `grid/Auto` against this list.
    expect(parsed.providers.grid.models.map((m) => m.id)).toEqual(['Auto'])
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
    expect(launchOf('hermes', OVERRIDE).args).toEqual([])
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
    // GRID_API_KEY among them: the probe asks for a launch with web tools, and moving an agent to
    // another grid has to take the old grid's MCP credential out of the pane with everything else.
    expect(gridEnvVarNames('claude').sort())
      .toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'GRID_API_KEY'])
  })

  it("names the scope Hermes' web tools are written into", () => {
    // Cleared on a retarget like every other variable here. It points at a directory holding one
    // grid's credential reference; an agent moved to another grid must not keep reading it.
    expect(gridEnvVarNames('hermes')).toContain('HERMES_MANAGED_DIR')
  })

  it("names codex's MCP header variable, which no other engine uses", () => {
    expect(gridEnvVarNames('codex')).toContain('GRID_MCP_AUTHORIZATION')
    expect(gridEnvVarNames('claude')).not.toContain('GRID_MCP_AUTHORIZATION')
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

describe('web tools (grid ADR 0041)', () => {
  const claudeMcpJson = (override = WITH_MCP) => {
    const args = launchOf('claude', override).args
    const at = args.indexOf('--mcp-config')
    expect(at, 'claude was not given --mcp-config').toBeGreaterThanOrEqual(0)
    return JSON.parse(args[at + 1] as string)
  }
  const codexArg = (key: string, override = WITH_MCP): string | undefined => {
    const args = launchOf('codex', override).args
    return args.find((arg) => arg.startsWith(`${key}=`))
  }
  const opencodeConfig = (override = WITH_MCP) =>
    JSON.parse(launchOf('opencode', override).configDir!.files[0]!.content)

  it('accepts the desktop payload carrying an MCP url', () => {
    expect(parseGridLaunchOverride({ ...WIRE, mcpUrl: MCP_URL }))
      .toEqual({ state: 'ok', override: { ...OVERRIDE, mcpUrl: MCP_URL } })
  })

  it('refuses an mcpUrl that is not an http(s) address', () => {
    for (const mcpUrl of ['api-grid.autonomous.ai/v1/grid/web-mcp/', 'file:///etc/passwd', '']) {
      expect(parseGridLaunchOverride({ ...WIRE, mcpUrl }).state, mcpUrl).toBe('invalid')
    }
  })

  it('hands Claude Code the server as a --mcp-config JSON string', () => {
    expect(claudeMcpJson().mcpServers['grid-web'])
      .toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer ${GRID_API_KEY}' } })
  })

  it('leaves the user their own MCP servers', () => {
    // --strict-mcp-config would drop every server they configured for themselves. A grid adds web
    // tools; it does not take an agent's own tools away.
    expect(launchOf('claude', WITH_MCP).args).not.toContain('--strict-mcp-config')
  })

  it("points Codex at it through env_http_headers, which carries the WHOLE header value", () => {
    expect(codexArg('mcp_servers.grid-web.url')).toBe(`mcp_servers.grid-web.url="${MCP_URL}"`)
    expect(codexArg('mcp_servers.grid-web.env_http_headers.Authorization'))
      .toBe('mcp_servers.grid-web.env_http_headers.Authorization="GRID_MCP_AUTHORIZATION"')
    // Bearer included — `bearer_token_env_var` takes a bare token, this one does not, and ADR 0041
    // D-d calls confusing the two a silent 401.
    expect(launchOf('codex', WITH_MCP).env.GRID_MCP_AUTHORIZATION).toBe(`Bearer ${WIRE.apiKey}`)
  })

  it('declares it in the config file opencode already gets', () => {
    expect(opencodeConfig().mcp['grid-web'])
      .toEqual({
        type: 'remote',
        url: MCP_URL,
        enabled: true,
        headers: { Authorization: 'Bearer {env:GRID_API_KEY}' },
      })
  })

  it('gives Hermes a managed-scope overlay, since it takes no flag for MCP', () => {
    const dir = launchOf('hermes', WITH_MCP).configDir
    expect(dir?.envVar).toBe('HERMES_MANAGED_DIR')
    // The directory itself, like Pi — Hermes reads `config.yaml` out of the scope it is handed.
    expect(dir?.pointAt).toBeUndefined()
    const file = dir?.files.find((f) => f.name === 'config.yaml')
    expect(file, 'hermes was given no config.yaml').toBeDefined()
    // Emitted as JSON on purpose: it is a subset of YAML, and Hermes parses this with a YAML loader.
    expect(JSON.parse(file!.content)).toEqual({
      mcp_servers: {
        'grid-web': {
          url: MCP_URL,
          headers: { Authorization: 'Bearer ${GRID_API_KEY}' },
        },
      },
    })
  })

  it("merges into the user's Hermes config rather than replacing it", () => {
    // `_deep_merge` recurses dict-over-dict, so pinning one server under `mcp_servers` keeps every
    // server they configured for themselves. Nothing outside that key may appear here — a second
    // top-level key would pin a setting of theirs that nobody asked us to pin.
    const file = launchOf('hermes', WITH_MCP).configDir!.files[0]!
    expect(Object.keys(JSON.parse(file.content))).toEqual(['mcp_servers'])
  })

  it('calls the server the same thing in every harness', () => {
    // The tools are named after it — an agent sees `mcp__grid-web__web_search` — so a harness that
    // spells it differently gets differently-named tools, and a prompt or skill naming one silently
    // misses on the other. Codex is where this is easy to get wrong: its config keys are dotted TOML
    // paths, which look like they could not carry a `-`. They can.
    expect(Object.keys(claudeMcpJson().mcpServers)).toEqual(['grid-web'])
    expect(Object.keys(opencodeConfig().mcp)).toEqual(['grid-web'])
    expect(Object.keys(JSON.parse(launchOf('hermes', WITH_MCP).configDir!.files[0]!.content).mcp_servers))
      .toEqual(['grid-web'])
    for (const arg of launchOf('codex', WITH_MCP).args) {
      expect(arg, 'codex renamed the server, and with it every tool').not.toContain('grid_web')
    }
    expect(codexArg('mcp_servers.grid-web.url')).toBeDefined()
  })

  it('never writes the key to disk or to an argv', () => {
    for (const engine of ['claude', 'codex', 'opencode', 'hermes'] as const) {
      const launch = launchOf(engine, WITH_MCP)
      for (const arg of launch.args) expect(arg, `${engine} argv`).not.toContain(WIRE.apiKey)
      for (const file of launch.configDir?.files ?? []) {
        expect(file.content, `${engine} ${file.name}`).not.toContain(WIRE.apiKey)
      }
      // It reaches the engine the one way this module allows.
      expect(Object.values(launch.env).some((value) => value.includes(WIRE.apiKey))).toBe(true)
    }
  })

  it('survives the interactive-shell wrapper the pane actually launches through', () => {
    // The one that would be catastrophic to get wrong. An engine is started as
    // `zsh -lic 'unset …; exec "$@"' harness-engine <engine> …`, and if that shell were to expand
    // the argument, `${GRID_API_KEY}` would become the key — in a command line `ps` shows to every
    // user on the machine. `exec "$@"` passes positionals through untouched, which is what keeps
    // the reference a reference; this pins it against a future change to the wrapper.
    const launch = launchOf('claude', WITH_MCP)
    const argv = buildEngineLaunchArgv('claude', { extraArgs: launch.args })
    expect(argv.join(' ')).toContain('Bearer ${GRID_API_KEY}')
    expect(argv.join(' ')).not.toContain(WIRE.apiKey)
  })

  it('adds nothing at all when the desktop sends no mcpUrl', () => {
    // An older desktop, and the no-regression promise: the launch is byte-for-byte what it was.
    expect(launchOf('claude', WITH_MODEL).args).toEqual([])
    expect(launchOf('claude', WITH_MODEL).env.GRID_API_KEY).toBeUndefined()
    expect(codexArg('mcp_servers.grid-web.url', WITH_MODEL)).toBeUndefined()
    expect(launchOf('codex', WITH_MODEL).env.GRID_MCP_AUTHORIZATION).toBeUndefined()
    expect(opencodeConfig(WITH_MODEL).mcp).toBeUndefined()
    // Hermes had no config directory at all before web tools, so it goes back to having none.
    expect(launchOf('hermes', WITH_MODEL).configDir).toBeUndefined()
    expect(launchOf('hermes', WITH_MODEL).env.GRID_API_KEY).toBeUndefined()
  })
})
