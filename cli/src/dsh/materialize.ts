/**
 * Put a DSH into a workspace, idempotently, before its engine is launched there — the four steps of
 * the contract (`dsh/spec/README.md` § Materialization):
 *
 *   1. an EMPTY workspace (no marker) gets the template, then the init command runs;
 *   2. `AGENTS.md` is copied in, or the DSH's text is appended under a marker line; a `claude` base
 *      also gets a `CLAUDE.md` that imports it, because that is the file Claude Code reads;
 *   3. each skill directory is symlinked into the engine's project-skills folder, so a DSH update
 *      is live in every workspace without a second copy;
 *   4. `.harness/` exists, so the verdict watcher has a directory to watch before the first verdict.
 *
 * Nothing here touches the user's own files beyond those: an existing AGENTS.md keeps its content,
 * an existing skill link that points elsewhere is left alone and reported.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { InstalledDsh } from './installed.js'
import { dshSkillsDirFor } from './manifest.js'
import { runDshCommand } from './shell.js'

export interface MaterializeResult {
  /** Files and links this call created. */
  created: string[]
  /** Things already in place, left untouched. */
  kept: string[]
  /** Things that could not be done, with why; never fatal. */
  warnings: string[]
  /** Output of the init command, when it ran. */
  initLines: string[]
}

export const AGENTS_FILE = 'AGENTS.md'
export const CLAUDE_FILE = 'CLAUDE.md'
export const CLAUDE_IMPORT_LINE = '@AGENTS.md'

export function dshMarkerLine(id: string): string {
  return `<!-- harness:dsh ${id} -->`
}

/** Subdirectories of `dir` that carry a SKILL.md, or `dir` itself when it is a single skill. */
export function skillDirsIn(dir: string): string[] {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir]
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .map((name) => join(dir, name))
    .filter((path) => {
      try { return statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md')) } catch { return false }
    })
    .sort()
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function copyTemplate(templateDir: string, workspace: string, result: MaterializeResult): void {
  if (!existsSync(templateDir)) {
    result.warnings.push(`template ${templateDir} is missing`)
    return
  }
  // Never overwrite: a workspace with no marker may still have files the user put there.
  cpSync(templateDir, workspace, { recursive: true, force: false, errorOnExist: false })
  result.created.push(`template → ${workspace}`)
}

function writeInstructions(dsh: InstalledDsh, workspace: string, result: MaterializeResult): void {
  const source = dsh.manifest.agent?.instructions
  if (!source) return
  const sourcePath = join(dsh.realDir, source)
  let text: string
  try {
    text = readFileSync(sourcePath, 'utf8')
  } catch {
    result.warnings.push(`instructions ${sourcePath} could not be read`)
    return
  }
  const marker = dshMarkerLine(dsh.id)
  const target = join(workspace, AGENTS_FILE)
  const body = `${marker}\n${text.trim()}\n`
  if (!existsSync(target)) {
    writeFileSync(target, body)
    result.created.push(AGENTS_FILE)
  } else {
    const existing = readFileSync(target, 'utf8')
    if (existing.includes(marker)) {
      result.kept.push(AGENTS_FILE)
    } else {
      writeFileSync(target, `${existing.replace(/\s*$/, '')}\n\n${body}`)
      result.created.push(`${AGENTS_FILE} (appended)`)
    }
  }
  if (dshBaseEngine(dsh) === 'claude') {
    const claude = join(workspace, CLAUDE_FILE)
    if (!existsSync(claude)) {
      writeFileSync(claude, `${CLAUDE_IMPORT_LINE}\n`)
      result.created.push(CLAUDE_FILE)
    } else {
      const existing = readFileSync(claude, 'utf8')
      if (existing.split('\n').some((line) => line.trim() === CLAUDE_IMPORT_LINE)) {
        result.kept.push(CLAUDE_FILE)
      } else {
        writeFileSync(claude, `${existing.replace(/\s*$/, '')}\n\n${CLAUDE_IMPORT_LINE}\n`)
        result.created.push(`${CLAUDE_FILE} (import added)`)
      }
    }
  }
}

function linkSkills(dsh: InstalledDsh, workspace: string, result: MaterializeResult): void {
  const roots = dsh.manifest.agent?.skills ?? []
  if (!roots.length) return
  const skillsDir = join(workspace, dshSkillsDirFor(dshBaseEngine(dsh)))
  ensureDir(skillsDir)
  for (const root of roots) {
    const dirs = skillDirsIn(join(dsh.realDir, root))
    if (!dirs.length) result.warnings.push(`no SKILL.md under ${root}`)
    for (const dir of dirs) {
      const link = join(skillsDir, basename(dir))
      let existing: ReturnType<typeof lstatSync> | null = null
      try { existing = lstatSync(link) } catch { existing = null }
      if (existing?.isSymbolicLink()) {
        if (readlinkSync(link) === dir) { result.kept.push(relative(workspace, link)); continue }
        // Ours from an earlier install path (a relink, a moved checkout): repoint it.
        rmSync(link)
      } else if (existing) {
        result.warnings.push(`${relative(workspace, link)} exists and is not a link; left alone`)
        continue
      }
      symlinkSync(dir, link)
      result.created.push(relative(workspace, link))
    }
  }
}

/** A command that is a path inside the harness becomes that absolute path, shell-quoted. */
export function resolveDshCommand(dsh: Pick<InstalledDsh, 'realDir'>, command: string): string {
  if (/[\s;&|<>$`'"\\]/.test(command)) return command
  const inside = join(dsh.realDir, command)
  if (!existsSync(inside)) return command
  return `'${inside.replace(/'/g, `'\\''`)}'`
}

/** The engine an agent package runs on. A viewer package is refused before this is asked. */
function dshBaseEngine(dsh: InstalledDsh): NonNullable<InstalledDsh['manifest']['engine']> {
  return dsh.manifest.engine ?? 'claude'
}

export async function materializeWorkspace(dsh: InstalledDsh, workspace: string): Promise<MaterializeResult> {
  const result: MaterializeResult = { created: [], kept: [], warnings: [], initLines: [] }
  if (dsh.manifest.kind === 'viewer') {
    result.warnings.push(`${dsh.id} is a viewer package; it has no workspace to lay out`)
    return result
  }
  const ws = dsh.manifest.workspace
  const marker = ws?.marker ? join(workspace, ws.marker) : null
  const fresh = marker ? !existsSync(marker) : false
  if (fresh && ws?.template) copyTemplate(join(dsh.realDir, ws.template), workspace, result)
  if (fresh && ws?.init) {
    // The init runs IN the workspace, so a command that names a script by its path inside the
    // harness (the usual shape: `harness/toolchain/init-workspace.sh`) is resolved against the
    // install directory first; anything else is a shell line and runs as written.
    const init = await runDshCommand(resolveDshCommand(dsh, ws.init), {
      cwd: workspace,
      env: { HARNESS_DSH: dsh.id, HARNESS_DSH_DIR: dsh.realDir, HARNESS_WORKSPACE: workspace },
      onLine: (line) => result.initLines.push(line),
      timeoutMs: 5 * 60_000,
    })
    if (init.code !== 0 || init.timedOut) {
      result.warnings.push(`init exited ${init.timedOut ? 'by timeout' : init.code ?? init.signal}`)
    }
  } else if (marker && !fresh) {
    result.kept.push(ws!.marker!)
  }
  writeInstructions(dsh, workspace, result)
  linkSkills(dsh, workspace, result)
  ensureDir(join(workspace, '.harness'))
  return result
}
