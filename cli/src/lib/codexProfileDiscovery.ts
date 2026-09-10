/**
 * Finds references to Codex state folders, without executing a shell or reading auth.json. This is
 * a bounded reader of literal shell configuration, not a shell interpreter: computed paths remain
 * available through explicit linking (see `codexProfiles.ts`).
 *
 * Ported from the Flutter desktop app's `lib/core/codex_profile_discovery.dart` (this is the "get
 * data" half of the feature moving down onto the machine the agent will actually launch on, so it
 * works for a remote machine too — see `codex_profiles_list` in `backendSocket.ts`).
 */

import { existsSync, openSync, closeSync, readSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'

const MAX_FILE_BYTES = 64 * 1024
const MAX_FILES = 256
const MAX_ENTRIES = 512
const MAX_DEPTH = 4
const TIMEOUT_MS = 3_000
// Any execute bit (owner/group/other) — same test as Dart's `stat.mode & 0x49`.
const ANY_EXEC_MODE = 0o111
const DATA_FILE_RE = /\.(?:jsonl?|toml|sqlite3?|db)$/i
const SHEBANG_RE = /^#![^\n]*\b(?:ba|z|fi|da|k)?sh\b/

export interface CodexProfileDiscoveryOptions {
  home: string
  environment: Record<string, string>
}

/** Discover candidate `CODEX_HOME`-shaped folders on this machine. Never throws. */
export function discoverCodexProfiles(options: CodexProfileDiscoveryOptions): Set<string> {
  const discovery = new CodexProfileDiscovery(options.home, options.environment)
  try {
    discovery.scan()
  } catch {
    // Best-effort: whatever was found before the failure is still useful.
  }
  return discovery.paths
}

function isDataFile(path: string): boolean {
  return DATA_FILE_RE.test(path)
}

class CodexProfileDiscovery {
  readonly paths = new Set<string>()
  private readonly visited = new Set<string>()
  private readonly binDirectories = new Set<string>()
  private readonly deadline: number
  private stopped = false

  constructor(
    private readonly home: string,
    private readonly environment: Record<string, string>,
  ) {
    this.deadline = Date.now() + TIMEOUT_MS
  }

  private timedOut(): boolean {
    if (this.stopped) return true
    if (Date.now() > this.deadline) this.stopped = true
    return this.stopped
  }

  scan(): void {
    const variables: Record<string, string> = { HOME: this.home, PATH: this.environment.PATH ?? '' }
    for (const [key, value] of Object.entries(this.environment)) {
      if (value.startsWith('/') || key === 'PATH') variables[key] = value
    }
    const inherited = this.environment.CODEX_HOME
    if (inherited && inherited.startsWith('/')) this.paths.add(inherited)
    const config = this.environment.XDG_CONFIG_HOME || join(this.home, '.config')
    this.conventionalHomes(this.home)
    this.conventionalHomes(config)

    // Finder does not inherit the user's shell PATH. Include its usual private bin locations and
    // read startup files directly instead of sourcing them.
    this.binDirectories.add(join(this.home, '.local', 'bin'))
    this.binDirectories.add(join(this.home, 'bin'))
    this.readShell(join(this.home, '.zshenv'), variables, 0)
    const zdot = variables.ZDOTDIR || this.home
    const rcFiles = new Set([
      join(zdot, '.zshenv'),
      join(zdot, '.zprofile'),
      join(zdot, '.zshrc'),
      join(zdot, '.zlogin'),
      join(this.home, '.profile'),
      join(this.home, '.bash_profile'),
      join(this.home, '.bash_login'),
      join(this.home, '.bashrc'),
      join(this.home, '.bash_aliases'),
      join(config, 'fish', 'config.fish'),
    ])
    for (const path of rcFiles) this.readShell(path, variables, 0)
    for (const folder of [join(config, 'fish', 'conf.d'), join(config, 'fish', 'functions')]) {
      for (const entry of this.entries(folder)) {
        if (entry.endsWith('.fish')) this.readShell(entry, variables, 0)
      }
    }
    this.addBinDirectories(this.environment.PATH)
    // Files explicitly referenced by aliases/source have priority over a PATH full of unrelated
    // tools. A huge tool installation must not stall a dialog.
    for (const folder of [...this.binDirectories].slice(0, 24)) {
      for (const entry of this.entries(folder)) {
        if (this.visited.size >= MAX_FILES) break
        this.readShell(entry, { ...variables }, 0, true)
      }
    }
  }

  private entries(path: string): string[] {
    if (this.timedOut()) return []
    try {
      return readdirSync(path).slice(0, MAX_ENTRIES).map((name) => join(path, name))
    } catch {
      return []
    }
  }

  private conventionalHomes(root: string): void {
    for (const entry of this.entries(root)) {
      const base = entry.split('/').pop() ?? entry
      const name = base.replace(/^\./, '')
      if (!name.toLowerCase().startsWith('codex')) continue
      if (existsSync(join(entry, 'auth.json')) || existsSync(join(entry, 'config.toml'))) {
        this.paths.add(entry)
      }
    }
  }

  private addBinDirectories(path: string | undefined): void {
    if (!path) return
    for (const segment of path.split(':')) {
      if (segment.startsWith('/')) this.binDirectories.add(segment)
    }
  }

  private readShell(
    path: string,
    variables: Record<string, string>,
    depth: number,
    executable = false,
  ): void {
    if (this.timedOut() || depth > MAX_DEPTH || this.visited.size >= MAX_FILES) return
    // These are Codex data, never configuration scripts to inspect.
    if (isDataFile(path)) return
    let fd: number
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return
      if (executable && (st.mode & ANY_EXEC_MODE) === 0) return
      const resolved = realpathSync(path)
      if (isDataFile(resolved)) return
      if (this.visited.has(resolved)) return
      this.visited.add(resolved)
      fd = openSync(path, 'r')
    } catch {
      // A missing, unreadable or broken link does not hide the other profiles.
      return
    }
    try {
      // Cap the read too: a file can grow after stat. No named pipes/devices.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_FILE_BYTES) return
      const slice = buffer.subarray(0, bytesRead)
      if (slice.includes(0)) return
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(slice)
      } catch {
        return // An executable binary is not shell configuration.
      }
      if (executable && !SHEBANG_RE.test(content)) return
      this.readCommands(content, variables, depth)
    } catch {
      // Unreadable once opened (e.g. a device file slipping past the stat check).
    } finally {
      closeSync(fd)
    }
  }

  private readCommands(content: string, variables: Record<string, string>, depth: number): void {
    for (const rawCommand of shellCommands(content)) {
      if (this.timedOut()) return
      let start = 0
      while (start < rawCommand.length && (rawCommand[start] === 'then' || rawCommand[start] === 'do')) start++
      const command = rawCommand.slice(start)
      if (command.length === 0) continue
      const first = literal(command[0], variables)
      if (first === 'alias') {
        for (const token of command.slice(1)) {
          const match = /^[\w-]+=([\s\S]*)$/.exec(token)
          if (!match || depth >= MAX_DEPTH) continue
          const body = literal(match[1], variables)
          if (body != null) this.readCommands(body, { ...variables }, depth + 1)
        }
        continue
      }
      if ((first === 'source' || first === '.') && command.length >= 2) {
        const source = literal(command[1], variables)
        if (source != null && source.startsWith('/')) this.readShell(source, variables, depth + 1)
        continue
      }
      // fish: set -gx CODEX_HOME /path; set --export CODEX_HOME /path.
      if (first === 'set') {
        const values = command.slice(1).filter((word) => !word.startsWith('-'))
        if (values.length === 2) this.assignment(`${values[0]}=${values[1]}`, variables)
        continue
      }
      let prefix = true
      for (const token of command) {
        if (!prefix) break
        if (this.assignment(token, variables)) continue
        const word = literal(token, variables)
        if (
          word != null &&
          new Set(['export', 'local', 'declare', 'typeset', 'readonly', 'exec', 'env', 'command', 'then', 'do']).has(word)
        ) {
          continue
        }
        if (token.startsWith('-')) continue
        // Follow literal executable shortcuts, including aliases pointing to a script outside PATH.
        // The script supplies evidence; its name need not mention Codex. Never execute the shortcut
        // to ask it for an answer.
        if (word != null && word.startsWith('/')) {
          this.readShell(word, { ...variables }, depth + 1, true)
        }
        prefix = false
      }
    }
  }

  private assignment(token: string, variables: Record<string, string>): boolean {
    const raw = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token)
    const value0 = literal(token, variables)
    const decoded = value0 == null ? null : /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(value0)
    const name = raw?.[1] ?? decoded?.[1]
    if (!name) return false
    const value = decoded?.[2]
    if (value == null) {
      delete variables[name] // a computed reassignment invalidates the old value
      return true
    }
    if (name === 'CODEX_HOME' && value.startsWith('/')) this.paths.add(value)
    if (name === 'PATH') this.addBinDirectories(value)
    if (value.startsWith('/') || name === 'PATH') {
      variables[name] = value
    } else {
      delete variables[name]
    }
    return true
  }
}

/**
 * Keep quotes until interpretation, so '$HOME' stays literal while "$HOME" expands. In an alias the
 * outer quotes are removed before reading its body.
 */
function* shellCommands(source: string): Generator<string[]> {
  const input = source.replace(/\\\r\n/g, '').replace(/\\\n/g, '')
  let words: string[] = []
  let word = ''
  let quote: string | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '\\' && quote !== "'" && i + 1 < input.length) {
      word += c
      i++
      word += input[i]
      continue
    }
    if (quote != null) {
      word += c
      if (c === quote) quote = null
      continue
    }
    if (c === '$' && i + 1 < input.length && input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2)
      if (end < 0) return
      word += input.slice(i, end + 1)
      i = end
      continue
    }
    if (c === '$' && i + 1 < input.length && input[i + 1] === '(') {
      // Keep computed expressions opaque, including nested commands, so their contents can never
      // become profile declarations of their own.
      let level = 1
      const start = i
      i += 2
      while (i < input.length && level > 0) {
        if (input[i] === '(') level++
        if (input[i] === ')') level--
        i++
      }
      if (level > 0) return
      word += input.slice(start, i)
      i--
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      word += c
      continue
    }
    if (c === '#' && word.length === 0) {
      while (i < input.length && input[i] !== '\n') i++
      if (words.length > 0) yield words
      words = []
      continue
    }
    if (' \t\r\n;|&(){}'.includes(c)) {
      if (word.length > 0) {
        words.push(word)
        word = ''
      }
      if ('\n;|&(){}'.includes(c) && words.length > 0) {
        yield words
        words = []
      }
    } else {
      word += c
    }
  }
  if (quote != null) return
  if (word.length > 0) words.push(word)
  if (words.length > 0) yield words
}

/**
 * Only literal paths and simple variable references. No command substitution, eval, globbing,
 * parameter operators or positional arguments are interpreted.
 */
function literal(raw: string, variables: Record<string, string>): string | null {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && quote !== "'") {
      i++
      if (i >= raw.length) return null
      out += raw[i]
      continue
    }
    if (c === "'" || c === '"') {
      if (quote == null) {
        quote = c
        continue
      }
      if (quote === c) {
        quote = null
        continue
      }
    }
    if (quote !== "'" && c === '$') {
      const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(raw.slice(i))
      const value = match == null ? undefined : variables[match[1] ?? match[2]]
      if (match == null || value == null) return null
      out += value
      i += match[0].length - 1
      continue
    }
    if (quote !== "'" && c === '`') return null
    if (quote == null && '*?[]'.includes(c)) return null
    // Tilde expands only at the start of a word or an assignment's value.
    if (quote == null && c === '~' && (i === 0 || raw[i - 1] === '=') && (i + 1 === raw.length || raw[i + 1] === '/')) {
      out += variables.HOME ?? ''
      continue
    }
    out += c
  }
  return quote == null ? out : null
}
