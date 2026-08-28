import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  cursorRuntimeBin,
  ENGINE_CLI_COMMANDS,
  ENGINES,
  executableFileIdentity,
  installedEngineBin,
} from './engineBin.js'

const originalPath = process.env.PATH
const tempDirs: string[] = []

afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('canonical engine CLI commands', () => {
  it('keeps the user-facing 14-engine command contract exact and ordered', () => {
    expect(ENGINES.map((engine) => [engine, ENGINE_CLI_COMMANDS[engine]])).toEqual([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['cursor', 'agent'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['hermes', 'hermes'],
      ['commandcode', 'cmd'],
      ['devin', 'devin'],
      ['muse', 'muse'],
      ['amp', 'amp'],
      ['kilo', 'kilo'],
      ['grok', 'grok'],
      ['agy', 'agy'],
      ['copilot', 'copilot'],
    ])
  })

  it('adapts agent ownership and Cursor recap command to PATH order without install-path assumptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-ownership-'))
    tempDirs.push(root)
    const cursorBin = join(root, 'custom-cursor-prefix', 'bin')
    const grokBin = join(root, 'custom-grok-prefix', 'bin')
    const cursorTarget = join(root, 'share', 'cursor-agent', 'versions', '2099.01.01', 'cursor-agent')
    const grokTarget = join(root, 'downloads', 'renamed-grok-image')
    mkdirSync(cursorBin, { recursive: true })
    mkdirSync(grokBin, { recursive: true })
    mkdirSync(join(cursorTarget, '..'), { recursive: true })
    mkdirSync(join(grokTarget, '..'), { recursive: true })
    writeFileSync(cursorTarget, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(grokTarget, 'grok', { mode: 0o755 })
    symlinkSync(cursorTarget, join(cursorBin, 'agent'))
    symlinkSync(cursorTarget, join(cursorBin, 'cursor-agent'))
    symlinkSync(grokTarget, join(grokBin, 'agent'))
    symlinkSync(grokTarget, join(grokBin, 'grok'))

    process.env.PATH = [grokBin, cursorBin].join(delimiter)
    let snapshot = agentCommandOwnershipSnapshot()
    expect(agentAliasOwner([snapshot.agentCandidates[0]?.fileKey], snapshot)).toBe('grok')
    expect(agentAliasOwner([snapshot.agentCandidates[1]?.fileKey], snapshot)).toBe('cursor')
    expect(cursorRuntimeBin(snapshot)).toBe('cursor-agent')
    expect(installedEngineBin('cursor', snapshot)).toBe(join(cursorBin, 'cursor-agent'))

    process.env.PATH = [cursorBin, grokBin].join(delimiter)
    snapshot = agentCommandOwnershipSnapshot()
    expect(agentAliasOwner([snapshot.agentCandidates[0]?.fileKey], snapshot)).toBe('cursor')
    expect(cursorRuntimeBin(snapshot)).toBe('agent')
    expect(installedEngineBin('cursor', snapshot)).toBe(join(cursorBin, 'agent'))
  })

  const linuxIt = process.platform === 'linux' ? it : it.skip
  linuxIt('keeps the running native image identity after an updater replaces its pathname', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-deleted-image-'))
    tempDirs.push(root)
    const executable = join(root, 'native-agent')
    copyFileSync('/bin/sleep', executable)
    const child = spawn(executable, ['30'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    try {
      rmSync(executable)
      const identity = executableFileIdentity(`/proc/${child.pid}/exe`)
      expect(identity?.fileKey).toMatch(/^\d+:\d+$/)
      expect(identity?.realPath).toContain('native-agent')
    } finally {
      child.kill('SIGKILL')
    }
  })
})
