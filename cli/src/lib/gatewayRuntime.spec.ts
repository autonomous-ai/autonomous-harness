import { describe, expect, it, vi } from 'vitest'
import {
  argvNamesOpenRouterProvider,
  classifyGatewayRuntime,
  clearGatewayRuntimeCache,
  gatewayRuntimeCacheKey,
  probeGatewayRuntime,
  parseEnviron,
  parsePsEnviron,
} from './gatewayRuntime.js'

// READ OFF A REAL PROCESS, not from ori's source: `ori claude` on 0.7.1, macOS, 2026-08-17, captured
// after the execve with `ps eww`. The surprise is the key layout — ANTHROPIC_AUTH_TOKEN is EMPTY and the
// `sk-or-…` value sits in OPENROUTER_API_KEY and ANTHROPIC_API_KEY, the reverse of what ori's own
// bundled launcher code says. Anything that reads a key must survive that, and a future ori flipping it
// back.
const ORI_CLAUDE_ENV = [
  'OPENROUTER_API_KEY=sk-or-v1-abc123',
  'ANTHROPIC_BASE_URL=https://openrouter.ai/api',
  'ANTHROPIC_AUTH_TOKEN=',
  'ANTHROPIC_API_KEY=sk-or-v1-abc123',
  'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1',
  'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1',
  'ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-5[1m]',
]

// `ori codex` configures its provider through argv, not env — the pane process carries these verbatim.
const ORI_CODEX_ARGS = '/opt/homebrew/bin/codex -c model_provider=openrouter -c '
  + 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"'

describe('parseEnviron (linux /proc)', () => {
  it('reads NUL-separated pairs and keeps values containing =', () => {
    const env = parseEnviron('HOME=/home/u\0ANTHROPIC_BASE_URL=https://openrouter.ai/api\0X=a=b\0')
    expect(env.HOME).toBe('/home/u')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(env.X).toBe('a=b')
  })
})

describe('parsePsEnviron (macOS ps eww)', () => {
  it('skips the argv prefix and reads the variables that follow', () => {
    const env = parsePsEnviron(`/Users/u/.local/bin/claude --resume abc ${ORI_CLAUDE_ENV.join(' ')}`)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-abc123')
  })

  it('is not derailed by the JSON blob ori now passes as --settings', () => {
    // Measured: `ori claude` execs `claude --settings {"apiKeyHelper":…,"env":{…}} -p noop`. That JSON is
    // argv, contains spaces and colons, and mentions the same variable names as the real environment.
    const argv = '/Users/u/.local/bin/claude --settings {"apiKeyHelper":"printf %s \\"$OPENROUTER_API_KEY\\"",'
      + '"env":{"ANTHROPIC_BASE_URL":"https://openrouter.ai/api"}} -p noop'
    const env = parsePsEnviron(`${argv} ${ORI_CLAUDE_ENV.join(' ')}`)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-abc123')
  })

  it('rejoins a value that contains spaces, since ps quotes nothing', () => {
    const env = parsePsEnviron('claude LANG=en_US.UTF-8 SOME_TITLE=two words HOME=/Users/u')
    expect(env.SOME_TITLE).toBe('two words')
    expect(env.HOME).toBe('/Users/u')
  })
})

describe('argvNamesOpenRouterProvider', () => {
  it('recognizes the provider block ori codex injects', () => {
    expect(argvNamesOpenRouterProvider(ORI_CODEX_ARGS)).toBe(true)
  })

  it('does not fire on a plain codex, or on prompt text that mentions openrouter', () => {
    expect(argvNamesOpenRouterProvider('/opt/homebrew/bin/codex --full-auto')).toBe(false)
    expect(argvNamesOpenRouterProvider('claude -p "compare openrouter and anthropic pricing"')).toBe(false)
  })
})

describe('classifyGatewayRuntime', () => {
  it('marks an ori claude pane and lifts its key', () => {
    const runtime = classifyGatewayRuntime(parsePsEnviron(`claude ${ORI_CLAUDE_ENV.join(' ')}`))
    expect(runtime.kind).toBe('ori')
    expect(runtime.apiKey).toBe('sk-or-v1-abc123')
  })

  it('finds the key whichever variable this ori version put it in', () => {
    const base = { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }
    // Measured layout: AUTH_TOKEN empty, key in ANTHROPIC_API_KEY.
    expect(classifyGatewayRuntime({ ...base, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-or-v1-a' }).apiKey).toBe('sk-or-v1-a')
    // Documented layout: key in AUTH_TOKEN, API_KEY blanked.
    expect(classifyGatewayRuntime({ ...base, ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-b', ANTHROPIC_API_KEY: '' }).apiKey).toBe('sk-or-v1-b')
  })

  it('marks an ori codex pane from argv alone', () => {
    expect(classifyGatewayRuntime({ OPENROUTER_API_KEY: 'sk-or-v1-abc123' }, ORI_CODEX_ARGS).kind).toBe('ori')
  })

  it('leaves a normal vendor login alone, key or not', () => {
    expect(classifyGatewayRuntime({ ANTHROPIC_API_KEY: 'sk-ant-1' }).kind).toBeNull()
    expect(classifyGatewayRuntime({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }).kind).toBeNull()
    expect(classifyGatewayRuntime({}).kind).toBeNull()
  })

  it('is not fooled by a host that merely ends in something similar', () => {
    expect(classifyGatewayRuntime({ ANTHROPIC_BASE_URL: 'https://notopenrouter.ai/api' }).kind).toBeNull()
    expect(classifyGatewayRuntime({ ANTHROPIC_BASE_URL: 'https://gw.openrouter.ai/api' }).kind).toBe('ori')
  })

  it('separates one live process image from another in the cache key', () => {
    const identity = { pid: 4242, startMarker: 'Sun Aug 17 10:36:00 2026', executable: 'ori' }
    expect(gatewayRuntimeCacheKey(identity))
      .not.toBe(gatewayRuntimeCacheKey({ ...identity, executable: 'codex' }))
    expect(gatewayRuntimeCacheKey({ ...identity, startMarker: 'Sun Aug 17 11:00:00 2026' }))
      .not.toBe(gatewayRuntimeCacheKey(identity))
    // A genuine re-scan of the same image shares one entry — that is what makes this a cache.
    expect(gatewayRuntimeCacheKey({ ...identity })).toBe(gatewayRuntimeCacheKey({ ...identity }))
  })

  it('re-probes a live process that was NOT a gateway, so a pre-exec read cannot pin it forever', async () => {
    // The live bug this pins: `ori codex` was scanned in the ~100ms before execve, read as `ori` (which
    // carries none of the routing it is about to install), and the null answer stuck for the agent's whole
    // life. Keying on the executable is not enough on its own — macOS truncates comm to 16 chars, so
    // `~/.local/bin/ori` and `~/.local/bin/claude` are indistinguishable — hence a TTL on negatives.
    clearGatewayRuntimeCache()
    const identity = { pid: process.pid, startMarker: 'Sun Aug 17 10:36:00 2026', executable: 'ori' }
    const first = await probeGatewayRuntime(identity)     // this test process is not a gateway
    expect(first.kind).toBeNull()

    // Same identity, one minute later: the negative has expired and the probe runs again.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 61_000
      const spy = vi.spyOn(process, 'platform', 'get')
      spy.mockReturnValue('linux')   // makes the re-probe read /proc, which fails here → still null…
      const second = await probeGatewayRuntime(identity)
      expect(second.kind).toBeNull()
      // …and a failed read is never cached, so the next pass tries once more rather than settling.
      expect(await probeGatewayRuntime(identity)).toEqual({ kind: null })
    } finally {
      Date.now = realNow
      vi.restoreAllMocks()
      clearGatewayRuntimeCache()
    }
  })

  it('still marks the session when the endpoint is routed but no key is readable', () => {
    const runtime = classifyGatewayRuntime({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })
    expect(runtime.kind).toBe('ori')
    expect(runtime.apiKey).toBeUndefined()
  })
})
