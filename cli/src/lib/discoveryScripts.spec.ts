import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Pi and OpenCode are the only two engines that do NOT register through notify.mjs — they register from a
 * script the adapter generates and drops into the engine's own extension/plugin directory. When the
 * launcher landed, `registry.register` began refusing any session without a `launcherId`; notify.mjs was
 * taught to forward `MACHINE_ID` but these two scripts were not, so pi and opencode silently stopped
 * producing agents at all. These assertions are on the GENERATED SOURCE, because that is the artifact
 * that was wrong.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-discovery-'))
  dirs.push(dir)
  return dir
}

describe('generated discovery scripts', () => {
  it('makes the Pi extension carry the launcher id', async () => {
    const piHome = scratch()
    vi.resetModules()
    process.env.PI_HOME = piHome
    const { installPiExtension } = await import('./hooks.js')
    installPiExtension(18473)

    const src = readFileSync(join(piHome, 'agent', 'extensions', 'launcher-register.ts'), 'utf-8')
    expect(src).toContain('process.env.MACHINE_ID')
    expect(src).toContain('launcherId,')            // sent in the POST body
    expect(src).toMatch(/if \(!launcherId\) return/) // and no registration without one
  })

  it('makes the OpenCode plugin carry the launcher id', async () => {
    const pluginDir = scratch()
    vi.resetModules()
    process.env.OPENCODE_PLUGIN_DIR = pluginDir
    const { installOpencodePlugin } = await import('./hooks.js')
    installOpencodePlugin(18473)

    const src = readFileSync(join(pluginDir, 'launcher-register.js'), 'utf-8')
    expect(src).toContain('process.env.MACHINE_ID')
    expect(src).toContain('launcherId,')
    // The bail is folded into the existing guard rather than added as a second early return.
    expect(src).toMatch(/if \(!pane \|\| !launcherId/)
  })
})
