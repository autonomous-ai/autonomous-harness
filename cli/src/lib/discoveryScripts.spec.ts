import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Pi and OpenCode register through generated source, so pin its process-owned wire contract directly. */
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
  it('lets the Pi extension post from any terminal context without launcher metadata', async () => {
    const piHome = scratch()
    vi.resetModules()
    process.env.PI_HOME = piHome
    const { installPiExtension } = await import('./hooks.js')
    installPiExtension(18473)

    const src = readFileSync(join(piHome, 'agent', 'extensions', 'launcher-register.ts'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).toContain('process.env.HERDR_PANE_ID')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
  })

  it('lets the OpenCode plugin post from any terminal context without launcher metadata', async () => {
    const pluginDir = scratch()
    vi.resetModules()
    process.env.OPENCODE_PLUGIN_DIR = pluginDir
    const { installOpencodePlugin } = await import('./hooks.js')
    installOpencodePlugin(18473)

    const src = readFileSync(join(pluginDir, 'launcher-register.js'), 'utf-8')
    expect(src).toContain('process.env.TMUX_PANE')
    expect(src).toContain('process.env.HERDR_PANE_ID')
    expect(src).not.toContain('MACHINE_ID')
    expect(src).not.toContain('launcherId')
    expect(src).toContain('if ((!pane && !herdrPane)')
  })
})
