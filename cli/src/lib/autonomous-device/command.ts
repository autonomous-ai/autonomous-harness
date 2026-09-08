import { readHookCredential } from '../hookAuth.js'

/** Native UI writes the displayed device code to stdin so it never appears in process arguments. */
async function stdinCode(): Promise<string> {
  let value = ''
  for await (const chunk of process.stdin) {
    value += String(chunk)
    if (value.length > 64) throw new Error('code input too long')
  }
  return value.trim()
}
export async function runAutonomousDeviceCommand(argv: string[], dataDir: string, port: number): Promise<number> {
  const json = argv.includes('--json'), args: string[] = []
  let device: string | undefined
  const flags = new Set<string>()
  let invalid = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--device') { if (device !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) invalid = true; else device = argv[++i] }
    else if (a.startsWith('--')) { if (!['--json', '--code-stdin'].includes(a) || flags.has(a)) invalid = true; flags.add(a) }
    else args.push(a)
  }
  const verb = args[0] ?? 'status', fromStdin = flags.has('--code-stdin')
  const route = ({ discover: 'discover', status: 'status', list: 'list', pair: 'pair/start', 'pair-status': 'pair/status', revoke: 'revoke' } as Record<string, string>)[verb]
  const print = (value: unknown) => console.log(JSON.stringify(value, null, json ? undefined : 2))
  if (invalid || !route || (verb === 'pair' && !device) || ((fromStdin || device !== undefined) && verb !== 'pair')
    || args.length !== (verb === 'pair' ? fromStdin ? 1 : 2 : verb === 'revoke' ? 2 : args[0] ? 1 : 0)) {
    print({ error: { code: 'INVALID_ARGUMENT', message: 'Usage: harness autonomous-device pair <code> --device <id> | pair --code-stdin --device <id> | discover | pair-status | list | status | revoke <fingerprint> [--json]' } })
    return 1
  }
  const credential = readHookCredential(dataDir)
  if (!credential) { print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Start Harness with harness start first.' } }); return 1 }
  const mutation = ['pair', 'revoke'].includes(verb)
  try {
    const body = verb === 'pair' ? { code: fromStdin ? await stdinCode() : args[1], ...(device ? { device } : {}) }
      : verb === 'revoke' ? { id: args[1] } : {}
    const result = await fetch(`http://127.0.0.1:${port}/api/autonomous-device/${route}`, {
      method: mutation ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${credential}`, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
      ...(mutation ? { body: JSON.stringify(body) } : {}),
    })
    print(await result.json())
    return result.ok ? 0 : 1
  } catch {
    print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Could not reach the Harness Autonomous device API or read pairing input. Start or update Harness CLI.' } })
    return 1
  }
}
