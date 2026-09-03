import { describe, expect, it } from 'vitest'
import {
  anthropicBaseUrl,
  buildGridEngineLaunch,
  describeGridLaunch,
  gridCapableEngines,
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

  it('uses the OpenAI-compatible pair for opencode and Hermes', () => {
    expect(launchOf('opencode').env).toEqual({
      OPENAI_BASE_URL: RELAY_V1,
      OPENAI_API_KEY: WIRE.apiKey,
    })
    expect(launchOf('hermes').env).toEqual({
      OPENAI_BASE_URL: RELAY_V1,
      OPENAI_API_KEY: WIRE.apiKey,
      HERMES_INFERENCE_MODEL: 'GLM-4.7-Flash',
    })
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

  it('never puts the key in argv, for any engine', () => {
    // `ps` is world-readable for the life of the process; the environment is not.
    for (const engine of gridCapableEngines()) {
      expect(launchOf(engine).args.join(' ')).not.toContain(WIRE.apiKey)
      expect(Object.values(launchOf(engine).env)).toContain(WIRE.apiKey)
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
      .toEqual(['claude', 'codex', 'copilot', 'grok', 'hermes', 'opencode'])
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
