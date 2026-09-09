import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { runAutonomousDeviceCommand } from './command.js'
vi.mock('../hookAuth.js', () => ({ readHookCredential: () => 'hook-test-credential' }))
afterEach(() => vi.restoreAllMocks())
describe('Autonomous device pairing command direction', () => {
  it('refuses the removed LAN listener and blanket revoke options', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runAutonomousDeviceCommand(['listen'], '/unused', 18473)).toBe(1)
    expect(await runAutonomousDeviceCommand(['revoke', '--all'], '/unused', 18473)).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('takes the device code from stdin and binds it to the displayed pending intent', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ state: 'running' })))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['K7P4X9\n']) as typeof process.stdin)
    const device = 'os._autonomous._tcp.local'
    expect(await runAutonomousDeviceCommand(['pair', '--code-stdin', '--device', device], '/unused', 18473)).toBe(0)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ code: 'K7P4X9', device })
    expect(log.mock.calls.flat().join()).not.toContain('K7P4X9')
  })
  it('refuses missing code or simultaneous positional and stdin sources', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await runAutonomousDeviceCommand(['pair'], '/unused', 18473)).toBe(1)
    expect(await runAutonomousDeviceCommand(['pair', 'K7P4X9', '--code-stdin'], '/unused', 18473)).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join()).not.toContain('K7P4X9')
  })
})
