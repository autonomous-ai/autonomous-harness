/**
 * Booting each implementation on an ephemeral port, with everything it needs faked out.
 *
 * `example-provider` normally spawns the real `claude`. Here it gets a shell script that echoes
 * recorded stream-json instead, so this suite needs no model, no network and no API key — and stays
 * deterministic, which a suite asserting exact event sequences has to be.
 */
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { start as startReference } from '../../reference-provider/src/server.js'
import { createProviderServer as createExample } from '../../example-provider/src/server.js'
import type { Config } from '../../example-provider/src/config.js'

export interface Booted {
  /** Shown in test names, so a failure says WHICH implementation broke. */
  label: string
  url: string
  /** A credential this provider accepts. */
  key: string
  /** A credential it must reject, so the `credential-rejected` checks have something to hit. */
  badKey: string
  /** A prompt that makes it ask the user something, or undefined when it cannot. */
  askPhrase?: string
  /** An agent id that exists on it. */
  agentId: string
  /** A SECOND agent id, for asserting one agent's transcript never leaks into another's. */
  otherAgentId: string
  /** Text that makes this provider take long enough to cancel mid-turn. */
  slowPhrase: string
  close: () => Promise<void>
}

const CLAUDE_SESSION = 'e2e-session'

const textLine = (text: string): unknown => ({
  type: 'stream_event',
  session_id: CLAUDE_SESSION,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const toolLines = (): unknown[] => [
  {
    type: 'assistant',
    session_id: CLAUDE_SESSION,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'note.txt' } }] },
  },
  {
    type: 'user',
    session_id: CLAUDE_SESSION,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'the note' }] },
  },
]
const resultLine = (): unknown => ({ type: 'result', session_id: CLAUDE_SESSION, subtype: 'success', result: 'ok' })

/** The word that makes the fake `claude` hang, so a cancel has a running turn to interrupt. */
export const SLOW_PHRASE = 'TAKE-YOUR-TIME'

/**
 * The three transcript lines one turn leaves behind, matching what the stream emitted.
 *
 * The tool id is the same on both sides ON PURPOSE: `agent.history` must hand back the objects the
 * stream emitted, and a transcript that renamed the id would fail that comparison for a reason that
 * is nobody's bug. It only has to be unique WITHIN a turn, which it is.
 */
const TRANSCRIPT_LINES = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'note.txt' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'the note' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Acme is at 118% of pace.' }] } },
]

/**
 * A `claude` that prints a fixed, tool-using turn, records it, and exits.
 *
 * **It writes the transcript, because a real `claude` does.** Without that, `agent.history` for this
 * implementation is a static fixture: it never grows, so "the transcript appends across turns", "the
 * newest window is the newest turn" and "the user's own message is stored" would all be asserting
 * against a file nobody wrote. The provider reads Claude's JSONL rather than keeping its own store,
 * so the only faithful fake is one that leaves the same trail behind.
 */
function fakeClaude(root: string, projects: string): string {
  const path = join(root, 'claude.sh')
  // Order matters: the transcript records the tool first, so the stream must too.
  const stream = [...toolLines(), textLine('Acme is at '), textLine('118% of pace.'), resultLine()]
  writeFileSync(path, [
    '#!/bin/sh',
    // Reading stdin serves three purposes. It drains the frame the provider writes the user's message
    // to — without that the script can exit before the write lands and node raises EPIPE — it lets ONE
    // turn opt into hanging so `turn.cancel` meets a genuinely in-flight process, and the frame is
    // itself a valid transcript `user` line, so it is appended verbatim exactly as claude records it.
    'input=$(cat)',
    `case "$input" in *${SLOW_PHRASE}*) sleep 30 ;; esac`,
    // Single-quoted, so none of the JSON above or below may contain an apostrophe — it would end the
    // shell string and the script would fail as an EMPTY HISTORY rather than as a syntax error. Keep
    // the fixture text plain.
    ...stream.map((l) => `echo '${JSON.stringify(l)}'`),
    // The project directory is the absolute cwd with every non-alphanumeric character replaced by a
    // dash — the same lossy mangling `jsonl.ts` does, reproduced here rather than passed in, so each
    // agent lands in its own directory the way a real run would.
    // Two traps in one line. `pwd -P`, not `$PWD`: the parent's PWD is inherited through the
    // environment and still points at wherever vitest was started, so using it writes every agent's
    // transcript into one directory named after the test runner. And `printf '%s'` around it, because
    // piping `pwd` straight into `tr` feeds it the trailing NEWLINE too — which `tr -c` faithfully
    // turns into one more dash, producing a directory the provider will never look in.
    `dir="${projects}/$(printf '%s' "$(pwd -P)" | tr -c 'a-zA-Z0-9' '-')"`,
    'mkdir -p "$dir"',
    `file="$dir/${CLAUDE_SESSION}.jsonl"`,
    'printf \'%s\\n\' "$input" >> "$file"',
    ...TRANSCRIPT_LINES.map((l) => `printf '%s\\n' '${JSON.stringify(l)}' >> "$file"`),
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

export async function bootReference(): Promise<Booted> {
  // STEP_DELAY_MS is deliberately NOT forced to 0 here. `server.ts` reads it once at module load, so
  // setting it now would be a no-op that reads like a guarantee — and the mid-turn cancel test needs
  // the opposite guarantee anyway: a turn slow enough to still be running when the cancel lands.
  const s = await startReference(0)
  return {
    label: 'reference-provider',
    url: s.url,
    key: 'e2e',
    badKey: 'bad-key',
    askPhrase: 'ask me',
    agentId: 'alpha',
    otherAgentId: 'beta',
    // Every scripted step pauses for STEP_DELAY_MS, so the default turn is comfortably long enough
    // to be interrupted once its first event has arrived.
    slowPhrase: 'everything',
    close: s.close,
  }
}

export async function bootExample(): Promise<Booted> {
  // realpath'd, because `os.tmpdir()` on macOS hands back `/var/folders/…` while the shell resolves
  // the same directory to `/private/var/folders/…`. The provider mangles the configured path and the
  // fake claude mangles its actual one; unless those are the same string they name two different
  // project directories and every history read comes back empty. `loadConfig` resolves paths for this
  // exact reason, and the harness builds its config by hand, so it has to do the same.
  const rawRoot = join(tmpdir(), `provider-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(rawRoot, { recursive: true })
  const root = realpathSync(rawRoot)
  const cwd = join(root, 'agent')
  // Its OWN directory, not a second name for the first one. Two agents sharing a cwd would share a
  // transcript, and a per-agent isolation test against that fixture would pass for the wrong reason.
  const secondCwd = join(root, 'agent-two')
  const projects = join(root, 'projects')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(secondCwd, { recursive: true })
  mkdirSync(projects, { recursive: true })

  const config: Config = {
    agents: [
      { id: 'scratch', name: 'Scratch', description: 'e2e agent', cwd },
      { id: 'second', name: 'Second', description: 'a second agent, so scoping has something to get wrong', cwd: secondCwd },
    ],
    workspaceRoot: root,
    agentsFile: join(root, 'agents.json'),
    claudeBin: fakeClaude(root, projects),
    model: 'e2e-model',
    port: 0,
    stateFile: join(root, 'state.json'),
    claudeProjectsDir: projects,
    recapModel: 'e2e-recap',
    // Excerpts the turn instead of spawning a second claude — same code path into the stream.
    recapDisabled: true,
  }

  const { server, deps } = createExample(config)
  // The fake claude reports the session id on its stream, but history is read per AGENT — so bind it
  // up front, exactly as a first real turn would.
  for (const id of ['scratch', 'second']) {
    deps.store.ensureAgent(id)
    deps.store.setClaudeSession(id, CLAUDE_SESSION)
  }
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    label: 'example-provider',
    url: `http://127.0.0.1:${port}`,
    key: 'e2e',
    badKey: 'bad-key',
    // It has no scripted "ask" path — a real Claude decides that, so the check is honestly skipped
    // rather than faked into passing.
    agentId: 'scratch',
    otherAgentId: 'second',
    slowPhrase: SLOW_PHRASE,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(root, { recursive: true, force: true })
    },
  }
}
