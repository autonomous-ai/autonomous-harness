/**
 * `harness dsh check <path>` — the conformance check a DSH must pass before the registry lists it,
 * runnable by its author on a plain checkout. It answers the questions the loader would otherwise
 * answer at create time, when the user is waiting: does the manifest parse, does every path it names
 * exist, does every skills root carry a SKILL.md, is the viewer URL a template Harness can fill.
 *
 * Static only: nothing here runs setup, doctor, or the viewer. `harness dsh doctor` does that for an
 * installed harness, and CI runs the real install in a clean container.
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isViewerPackage, readDshManifest, viewerUse, type DshManifest } from './manifest.js'
import { skillDirsIn } from './materialize.js'

export interface CheckLine {
  level: 'ok' | 'warn' | 'fail'
  what: string
}

export interface CheckResult {
  ok: boolean
  lines: CheckLine[]
  manifest: DshManifest | null
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** A command that looks like a path inside the harness must exist there; a shell line is not checked. */
function commandPath(dir: string, command: string): string | null {
  if (/[\s;&|<>$`'"\\]/.test(command)) return null
  return join(dir, command)
}

export function checkDsh(path: string): CheckResult {
  const dir = resolve(path)
  const lines: CheckLine[] = []
  const add = (level: CheckLine['level'], what: string): void => { lines.push({ level, what }) }
  const read = readDshManifest(dir)
  if (!read.ok) {
    add('fail', read.error)
    return { ok: false, lines, manifest: null }
  }
  const manifest = read.manifest
  const viewerPkg = isViewerPackage(manifest)
  add('ok', viewerPkg
    ? `harness.json parses · ${manifest.id} "${manifest.name}" is a viewer package`
    : `harness.json parses · ${manifest.id} "${manifest.name}" runs on ${manifest.engine}`)
  if (!manifest.description) add('warn', viewerPkg ? 'no description' : 'no description — the picker tile will have none')
  if (!manifest.author && !viewerPkg) add('warn', 'no author — the tile will not say who made it')
  if (viewerPkg) {
    if (manifest.workspace) add('warn', 'a viewer package has no workspace of its own; workspace.* is ignored')
    if (manifest.verdict) add('warn', 'a viewer package writes no verdict; the harness that uses it does')
  }

  const ws = manifest.workspace
  if (ws?.template) {
    if (isDir(join(dir, ws.template))) add('ok', `workspace.template ${ws.template}/`)
    else add('fail', `workspace.template ${ws.template} is not a directory`)
    if (!ws.marker) add('warn', 'workspace.template without workspace.marker: the template is copied on EVERY create')
  }
  if (ws?.marker && ws.template && !existsSync(join(dir, ws.template, ws.marker))) {
    add('warn', `workspace.marker ${ws.marker} is not in the template, so a fresh workspace stays "fresh" until something else writes it`)
  }
  if (ws?.init) {
    const p = commandPath(dir, ws.init)
    if (p === null) add('ok', `workspace.init is a shell line`)
    else if (isFile(p)) add('ok', `workspace.init ${ws.init}`)
    else add('fail', `workspace.init ${ws.init} does not exist`)
  }

  const agent = manifest.agent
  if (agent?.instructions) {
    if (isFile(join(dir, agent.instructions))) add('ok', `agent.instructions ${agent.instructions}`)
    else add('fail', `agent.instructions ${agent.instructions} does not exist`)
  } else {
    add('warn', 'no agent.instructions — the agent gets no AGENTS.md from this harness')
  }
  for (const root of agent?.skills ?? []) {
    const full = join(dir, root)
    if (!isDir(full)) {
      // A skills root that setup populates (upstream skills fetched at install, not vendored — the
      // shape a project without a licence to copy forces) is absent on a plain checkout by design.
      if (manifest.toolchain?.setup) add('warn', `agent.skills ${root} is not in the checkout; toolchain.setup must create it, or the agent gets no skills`)
      else add('fail', `agent.skills ${root} is not a directory`)
      continue
    }
    const dirs = skillDirsIn(full)
    if (!dirs.length) add('fail', `agent.skills ${root} has no SKILL.md-bearing directory`)
    else add('ok', `agent.skills ${root}/ · ${dirs.map((d) => d.slice(full.length + 1) || '.').join(', ')}`)
  }
  if (!agent?.skills?.length && !viewerPkg) add('warn', 'no agent.skills — a tier-0 harness usually ships at least one')
  for (const [key, value] of Object.entries(agent?.env ?? {})) {
    if (key.startsWith('HARNESS_')) add('fail', `agent.env.${key} is reserved (HARNESS_* is set by Harness)`)
    else if (/\$\{(?!dsh\}|workspace\}|home\})/.test(value)) add('warn', `agent.env.${key} uses a variable Harness does not expand: ${value}`)
  }

  for (const [name, command] of Object.entries(manifest.toolchain ?? {})) {
    if (!command) continue
    const p = commandPath(dir, command)
    if (p === null) add('ok', `toolchain.${name} is a shell line`)
    else if (isFile(p)) add('ok', `toolchain.${name} ${command}`)
    else add('fail', `toolchain.${name} ${command} does not exist`)
  }
  if (!manifest.toolchain?.doctor) add('warn', 'no toolchain.doctor — Harness cannot tell the user what is missing before a create')

  const viewer = manifest.viewer
  const uses = viewerUse(manifest)
  if (uses) {
    add('ok', `viewer.use ${uses} — installed with this harness; its command and URL come from that package`)
    if (viewer && 'url' in viewer && viewer.url && !viewer.url.includes('${port}')) add('fail', 'viewer.url has no ${port}: Harness picks the port, the URL must use it')
  } else if (viewer && 'command' in viewer) {
    const p = commandPath(dir, viewer.command)
    if (p === null) add('ok', 'viewer.command is a shell line')
    else if (isFile(p)) add('ok', `viewer.command ${viewer.command}`)
    else add('fail', `viewer.command ${viewer.command} does not exist`)
    if (!viewer.url.includes('${port}')) add('fail', 'viewer.url has no ${port}: Harness picks the port, the URL must use it')
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(viewer.url)) add('warn', 'viewer.url is not loopback; the pane expects a local server')
    if (viewer.url.includes('${artifact}') && !viewer.artifactExtensions?.length) {
      add('warn', 'viewer.url uses ${artifact} but no artifactExtensions are declared: only a verdict can name one')
    }
  }
  if (manifest.verdict && !manifest.verdict.startsWith('.harness/')) add('warn', `verdict ${manifest.verdict} is outside .harness/ — allowed, but the convention is .harness/verdict.json`)

  return { ok: !lines.some((line) => line.level === 'fail'), lines, manifest }
}

export function formatCheck(result: CheckResult): string {
  return result.lines.map((line) => `${line.level.padEnd(4)} ${line.what}`).join('\n')
}
