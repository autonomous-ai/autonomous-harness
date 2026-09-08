import { readHookCredential } from '../hookAuth.js'

/** Native UI and terminal use the same authenticated loopback management API. */
export async function runAutonomousDeviceCommand(argv: string[], dataDir: string, port: number): Promise<number> {
  const json = argv.includes('--json')
  const args = argv.filter(a => !a.startsWith('--'))
  const verb = args[0] ?? 'status'
  const route = ({ status: 'status', list: 'list', pair: 'pair/start', cancel: 'pair/cancel', 'pair-status': 'pair/status', revoke: 'revoke' } as Record<string, string>)[verb]
  const print = (value: unknown) => console.log(JSON.stringify(value, null, json ? undefined : 2))
  if (!route || argv.some(a => a.startsWith('--') && !['--json', '--replace', '--all'].includes(a))
    || (argv.includes('--replace') && verb !== 'pair') || (argv.includes('--all') && verb !== 'revoke')
    || args.length > (verb === 'revoke' ? 2 : 1)
    || (verb === 'revoke' && (!!args[1] === argv.includes('--all')))) {
    print({ error: { code: 'INVALID_ARGUMENT', message: 'Usage: harness autonomous-device pair [--replace] | cancel | pair-status | list | status | revoke <id|--all> [--json]' } })
    return 1
  }
  const credential = readHookCredential(dataDir)
  if (!credential) { print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Start Harness with harness start first.' } }); return 1 }
  const mutation = ['pair', 'cancel', 'revoke'].includes(verb)
  const body = verb === 'pair' ? { replace: argv.includes('--replace') } : verb === 'revoke' ? argv.includes('--all') ? { all: true } : { id: args[1] } : {}
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/autonomous-device/${route}`, {
      method: mutation ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${credential}`, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
      ...(mutation ? { body: JSON.stringify(body) } : {}),
    })
    const value = await result.json()
    print(value)
    return result.ok ? 0 : 1
  } catch {
    print({ error: { code: 'DAEMON_UNAVAILABLE', message: 'Could not reach the Harness Autonomous device API. Start or update Harness CLI.' } })
    return 1
  }
}
