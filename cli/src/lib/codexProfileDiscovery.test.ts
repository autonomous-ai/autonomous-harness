import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverCodexProfiles } from './codexProfileDiscovery.js'

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-discovery-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(path: string, content: string, { executable = false } = {}): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (executable) chmodSync(path, 0o755)
}

describe('discoverCodexProfiles — conventional homes', () => {
  it('finds a .codex folder that has auth.json', () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    expect(discoverCodexProfiles({ home, environment: {} })).toContain(join(home, '.codex'))
  })

  it('finds a folder named like a Codex profile that has config.toml', () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex_personal'))
    writeFileSync(join(home, '.codex_personal', 'config.toml'), '')
    expect(discoverCodexProfiles({ home, environment: {} })).toContain(join(home, '.codex_personal'))
  })

  it('finds a codex-prefixed folder under XDG_CONFIG_HOME', () => {
    const home = tempHome()
    const config = join(home, 'myconfig')
    mkdirSync(join(config, 'codex-team'), { recursive: true })
    writeFileSync(join(config, 'codex-team', 'auth.json'), '{}')
    const found = discoverCodexProfiles({ home, environment: { XDG_CONFIG_HOME: config } })
    expect(found).toContain(join(config, 'codex-team'))
  })

  it('ignores an empty .codex folder with no marker file', () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex'))
    expect(discoverCodexProfiles({ home, environment: {} })).not.toContain(join(home, '.codex'))
  })

  it('ignores a folder that merely starts with "codex" but has no marker', () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex-unrelated'))
    writeFileSync(join(home, '.codex-unrelated', 'notes.txt'), 'hi')
    expect(discoverCodexProfiles({ home, environment: {} })).not.toContain(join(home, '.codex-unrelated'))
  })
})

describe('discoverCodexProfiles — CODEX_HOME', () => {
  it('honors an absolute CODEX_HOME from the environment', () => {
    const home = tempHome()
    const found = discoverCodexProfiles({ home, environment: { CODEX_HOME: '/opt/codex-ci' } })
    expect(found).toContain('/opt/codex-ci')
  })

  it('ignores a relative CODEX_HOME', () => {
    const home = tempHome()
    const found = discoverCodexProfiles({ home, environment: { CODEX_HOME: 'relative/codex' } })
    expect(found).not.toContain('relative/codex')
  })
})

describe('discoverCodexProfiles — shell configuration', () => {
  it('reads a literal CODEX_HOME export from .zshrc', () => {
    const home = tempHome()
    write(join(home, '.zshrc'), 'export CODEX_HOME=/Users/x/.codex-work\n')
    expect(discoverCodexProfiles({ home, environment: {} })).toContain('/Users/x/.codex-work')
  })

  it('expands $HOME and ${HOME} and a leading tilde in an assignment', () => {
    const home = tempHome()
    write(
      join(home, '.bashrc'),
      [
        'CODEX_HOME=$HOME/.codex-a',
        'CODEX_HOME=${HOME}/.codex-b',
        'CODEX_HOME=~/.codex-c',
      ].join('\n'),
    )
    const found = discoverCodexProfiles({ home, environment: {} })
    expect(found).toContain(join(home, '.codex-a'))
    expect(found).toContain(join(home, '.codex-b'))
    expect(found).toContain(join(home, '.codex-c'))
  })

  it('follows an alias body into its assignment', () => {
    const home = tempHome()
    write(join(home, '.zshrc'), "alias work-codex='CODEX_HOME=/Users/x/.codex-aliased codex'\n")
    expect(discoverCodexProfiles({ home, environment: {} })).toContain('/Users/x/.codex-aliased')
  })

  it('follows a sourced file', () => {
    const home = tempHome()
    write(join(home, '.zshenv'), `source ${join(home, 'extra.sh')}\n`)
    write(join(home, 'extra.sh'), 'export CODEX_HOME=/Users/x/.codex-sourced\n')
    expect(discoverCodexProfiles({ home, environment: {} })).toContain('/Users/x/.codex-sourced')
  })

  it('supports ZDOTDIR', () => {
    const home = tempHome()
    const zdot = join(home, 'zdotdir')
    mkdirSync(zdot, { recursive: true })
    write(join(home, '.zshenv'), `export ZDOTDIR=${zdot}\n`)
    write(join(zdot, '.zshrc'), 'export CODEX_HOME=/Users/x/.codex-zdot\n')
    expect(discoverCodexProfiles({ home, environment: {} })).toContain('/Users/x/.codex-zdot')
  })

  it('supports fish set -gx and conf.d/functions', () => {
    const home = tempHome()
    const config = join(home, '.config')
    write(join(config, 'fish', 'config.fish'), 'set -gx CODEX_HOME /Users/x/.codex-fish\n')
    write(join(config, 'fish', 'conf.d', 'extra.fish'), 'set --export CODEX_HOME /Users/x/.codex-fish-confd\n')
    write(join(config, 'fish', 'functions', 'helper.fish'), 'set -gx CODEX_HOME /Users/x/.codex-fish-fn\n')
    const found = discoverCodexProfiles({ home, environment: {} })
    expect(found).toContain('/Users/x/.codex-fish')
    expect(found).toContain('/Users/x/.codex-fish-confd')
    expect(found).toContain('/Users/x/.codex-fish-fn')
  })

  it('ignores comments, computed expressions and single-quoted literals', () => {
    const home = tempHome()
    write(
      join(home, '.zshrc'),
      [
        '# CODEX_HOME=/Users/x/.codex-comment',
        'CODEX_HOME=$(echo /Users/x/.codex-computed)',
        "CODEX_HOME='$HOME/.codex-literal'",
      ].join('\n'),
    )
    const found = discoverCodexProfiles({ home, environment: {} })
    expect(found).not.toContain('/Users/x/.codex-comment')
    expect(found).not.toContain('/Users/x/.codex-computed')
    // Single-quoted: '$HOME' must stay literal text, not expand, and not start with '/' either way.
    expect([...found].some((p) => p.includes('.codex-literal'))).toBe(false)
  })

  it('follows a literal executable path referenced without alias/source, but never runs it', () => {
    const home = tempHome()
    const sentinel = join(home, 'MUST_NOT_EXECUTE')
    const script = join(home, 'bin-shortcut.sh')
    write(script, `#!/bin/sh\ntouch ${sentinel}\nexport CODEX_HOME=/Users/x/.codex-shortcut\n`, { executable: true })
    write(join(home, '.zshrc'), `${script}\n`)
    const found = discoverCodexProfiles({ home, environment: {} })
    expect(found).toContain('/Users/x/.codex-shortcut')
    expect(() => statSync(sentinel)).toThrow()
  })

  it('does not treat auth.json as shell configuration even if sourced', () => {
    const home = tempHome()
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), 'CODEX_HOME=/should-never-be-read')
    write(join(home, '.zshrc'), `source ${join(home, '.codex', 'auth.json')}\n`)
    const found = discoverCodexProfiles({ home, environment: {} })
    expect(found).not.toContain('/should-never-be-read')
  })

  it('skips a shell file larger than the 64KB cap', () => {
    const home = tempHome()
    const huge = 'x'.repeat(70 * 1024) + '\nCODEX_HOME=/Users/x/.codex-oversized\n'
    write(join(home, '.zshrc'), huge)
    expect(discoverCodexProfiles({ home, environment: {} })).not.toContain('/Users/x/.codex-oversized')
  })

  it('skips a binary file (contains a null byte) even under a script-like name', () => {
    const home = tempHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.zshrc'), Buffer.from('CODEX_HOME=/nope\0binary'))
    expect(discoverCodexProfiles({ home, environment: {} })).not.toContain('/nope')
  })

  it('discovers an executable declaring CODEX_HOME in a PATH bin directory', () => {
    const home = tempHome()
    const bin = join(home, 'custom-bin')
    write(join(bin, 'tool'), '#!/bin/bash\nexport CODEX_HOME=/Users/x/.codex-path-bin\n', { executable: true })
    const found = discoverCodexProfiles({ home, environment: { PATH: bin } })
    expect(found).toContain('/Users/x/.codex-path-bin')
  })

  it('ignores a non-executable file sitting in a PATH bin directory', () => {
    const home = tempHome()
    const bin = join(home, 'custom-bin')
    write(join(bin, 'tool'), '#!/bin/bash\nexport CODEX_HOME=/Users/x/.codex-noexec\n', { executable: false })
    const found = discoverCodexProfiles({ home, environment: { PATH: bin } })
    expect(found).not.toContain('/Users/x/.codex-noexec')
  })

  it('ignores an executable with no recognizable shell shebang', () => {
    const home = tempHome()
    const bin = join(home, 'custom-bin')
    write(join(bin, 'tool'), '#!/usr/bin/env python3\nCODEX_HOME=/Users/x/.codex-python\n', { executable: true })
    const found = discoverCodexProfiles({ home, environment: { PATH: bin } })
    expect(found).not.toContain('/Users/x/.codex-python')
  })
})
