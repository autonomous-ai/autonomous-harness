import { describe, expect, it } from 'vitest'
import {
  GRID_ENGINE_ENV,
  anthropicBaseUrl,
  buildGridEngineEnv,
  describeGridLaunch,
  gridCapableEngines,
  parseGridLaunchOverride,
  type GridLaunchOverride,
} from './gridLaunch.js'
import { ENGINES } from '../engines/types.js'

/** The shape the desktop actually sends, with values read off the live control plane. */
const WIRE = {
  networkId: 'grid-3378218621364f16',
  networkName: 'autonomous.ai',
  baseUrl: 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1',
  apiKey: 'gridkey-abc123',
}

const OVERRIDE: GridLaunchOverride = { ...WIRE }

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

  it('refuses control characters, which would corrupt the environment silently', () => {
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

describe('anthropicBaseUrl', () => {
  it('drops the /v1 that OpenAI clients need and Claude Code appends itself', () => {
    expect(anthropicBaseUrl(WIRE.baseUrl)).toBe('https://grid.autonomous.ai/grid-3378218621364f16/relay')
  })

  it('is idempotent and trailing-slash tolerant', () => {
    const relay = 'https://relay.example/relay'
    expect(anthropicBaseUrl(relay)).toBe(relay)
    expect(anthropicBaseUrl(`${relay}/v1/`)).toBe(relay)
    expect(anthropicBaseUrl(`${relay}//`)).toBe(relay)
  })

  it('leaves a path that merely ends in something like v1 alone', () => {
    expect(anthropicBaseUrl('https://relay.example/relay/av1')).toBe('https://relay.example/relay/av1')
  })
})

describe('buildGridEngineEnv', () => {
  it('points Claude Code at the relay with the bearer variable only', () => {
    const built = buildGridEngineEnv('claude', OVERRIDE)
    expect(built).toEqual({
      ok: true,
      env: {
        ANTHROPIC_BASE_URL: 'https://grid.autonomous.ai/grid-3378218621364f16/relay',
        ANTHROPIC_AUTH_TOKEN: WIRE.apiKey,
      },
    })
    // Setting it too makes Claude Code warn that auth may not work, and it decides nothing.
    expect(built).not.toHaveProperty('env.ANTHROPIC_API_KEY')
  })

  it('sets the model the user picked, and none when they picked none', () => {
    const chosen = buildGridEngineEnv('claude', { ...OVERRIDE, model: 'glm-5.2' })
    expect(chosen).toMatchObject({ ok: true, env: { ANTHROPIC_MODEL: 'glm-5.2' } })
    expect(buildGridEngineEnv('claude', OVERRIDE)).not.toHaveProperty('env.ANTHROPIC_MODEL')
  })

  it('refuses every engine with no verified environment contract, naming the grid and the way out', () => {
    for (const engine of ENGINES) {
      if (GRID_ENGINE_ENV[engine]) continue
      const built = buildGridEngineEnv(engine, OVERRIDE)
      expect(built.ok).toBe(false)
      expect(built).toMatchObject({ error: 'GRID_ENGINE_UNSUPPORTED' })
      if (built.ok) continue
      expect(built.detail).toContain(OVERRIDE.networkName)
      expect(built.detail).toContain('claude')
    }
  })

  it('declares an entry for every engine, so a new one cannot default into a guess', () => {
    expect(Object.keys(GRID_ENGINE_ENV).sort()).toEqual([...ENGINES].sort())
    expect(gridCapableEngines()).toEqual(['claude'])
  })
})

describe('describeGridLaunch', () => {
  it('names the grid and the model, and never the key', () => {
    const line = describeGridLaunch('claude', { ...OVERRIDE, model: 'glm-5.2' })
    expect(line).toContain('autonomous.ai')
    expect(line).toContain('glm-5.2')
    expect(line).not.toContain(WIRE.apiKey)
    expect(describeGridLaunch('claude', OVERRIDE)).not.toContain(WIRE.apiKey)
  })
})
