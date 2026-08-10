import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  ENGINE_CLI_COMMANDS,
  ENGINES,
  executableFileIdentity,
} from './engineBin.js'
import { probeTmuxAgents } from './tmuxAgentDiscovery.js'

const exec = promisify(execFile)
const realDescribe = process.env.RUN_REAL_TMUX_DISCOVERY === '1' ? describe : describe.skip
const createdSessions = new Set<string>()

const engines: Array<[AgentEngine, string]> = ENGINES.map((engine) => [engine, ENGINE_CLI_COMMANDS[engine]])
const ownership = agentCommandOwnershipSnapshot()
const installedAgentAliases: Array<[AgentEngine, string]> = []
const seenAgentAliases = new Set<string>()
for (const [engine, candidates] of [
  ['cursor', ownership.cursorAgentCandidates],
  ['grok', ownership.grokCandidates],
] as const) {
  for (const candidate of candidates) {
    const alias = executableFileIdentity(join(dirname(candidate.path), 'agent'))
    if (!alias || seenAgentAliases.has(alias.realPath) || agentAliasOwner([alias.fileKey], ownership) !== engine) continue
    seenAgentAliases.add(alias.realPath)
    installedAgentAliases.push([engine, alias.path])
  }
}

async function tmux(args: string[]): Promise<string> {
  return (await exec('tmux', args, { timeout: 5_000 })).stdout.trim()
}

async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

async function executable(name: string): Promise<string> {
  const result = await exec('/bin/zsh', ['-lc', `command -v ${name}`], { timeout: 5_000 })
  const path = result.stdout.trim()
  if (!path) throw new Error(`${name} is not installed`)
  return path
}

realDescribe.sequential('real installed CLI process discovery', () => {
  afterAll(async () => {
    for (const session of createdSessions) {
      await exec('tmux', ['kill-session', '-t', session], { timeout: 5_000 }).catch(() => {})
    }
  })

  it.each(engines)('discovers %s once and process-only deletion preserves its pane', async (engine, bin) => {
    const dir = await mkdtemp(join(tmpdir(), `harness-real-${engine}-`))
    const session = `harness-real-${process.pid}-${engine}`
    createdSessions.add(session)

    try {
      const path = await executable(bin)
      await tmux(['new-session', '-d', '-s', session, '-c', dir])
      const pane = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}'])
      await tmux(['send-keys', '-t', pane, '-l', '--', path])
      await tmux(['send-keys', '-t', pane, 'C-m'])

      const discovered = await eventually(async () => {
        const result = await probeTmuxAgents()
        if (!result.ok) throw new Error(result.error)
        const inPane = result.agents.filter((candidate) => candidate.tmuxPane === pane)
        return inPane.length === 1 && inPane[0].engine === engine ? inPane[0] : null
      })
      const capture = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '')
      expect(discovered, `${bin} was not discovered in ${pane}\n${capture}`).not.toBeNull()

      const pid = discovered!.processIdentity.pid
      process.kill(pid, 'SIGTERM')
      const gone = await eventually(async () => {
        try { process.kill(pid, 0) } catch { return true }
        return null
      }, 2_000)
      if (!gone) {
        try { process.kill(pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }

      const absent = await eventually(async () => {
        const result = await probeTmuxAgents()
        if (!result.ok) throw new Error(result.error)
        return result.agents.some((candidate) => candidate.tmuxPane === pane) ? null : true
      }, 5_000)
      expect(absent, `${bin} remained discoverable after its exact saved PID was terminated`).toBe(true)
      await expect(tmux(['display-message', '-p', '-t', pane, '#{pane_id}'])).resolves.toBe(pane)
    } finally {
      await exec('tmux', ['kill-session', '-t', session], { timeout: 5_000 }).catch(() => {})
      createdSessions.delete(session)
      await rm(dir, { recursive: true, force: true })
    }
  }, 35_000)

  it.each(installedAgentAliases)('classifies installed %s alias named agent from its executable identity', async (engine, path) => {
    const dir = await mkdtemp(join(tmpdir(), `harness-real-agent-alias-${engine}-`))
    const session = `harness-real-${process.pid}-${engine}-agent-alias`
    createdSessions.add(session)
    try {
      await tmux(['new-session', '-d', '-s', session, '-c', dir])
      const pane = await tmux(['list-panes', '-t', session, '-F', '#{pane_id}'])
      await tmux(['send-keys', '-t', pane, '-l', '--', path])
      await tmux(['send-keys', '-t', pane, 'C-m'])
      const discovered = await eventually(async () => {
        const result = await probeTmuxAgents()
        if (!result.ok) throw new Error(result.error)
        const inPane = result.agents.filter((candidate) => candidate.tmuxPane === pane)
        return inPane.length === 1 && inPane[0].engine === engine ? inPane[0] : null
      })
      const capture = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '')
      expect(discovered, `${path} was not classified as ${engine} in ${pane}\n${capture}`).not.toBeNull()
    } finally {
      await exec('tmux', ['kill-session', '-t', session], { timeout: 5_000 }).catch(() => {})
      createdSessions.delete(session)
      await rm(dir, { recursive: true, force: true })
    }
  }, 35_000)
})
