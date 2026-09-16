/**
 * `harness.json` — the one file Harness reads about a domain-specific harness.
 *
 * Spec 1, frozen: see `dsh/spec/README.md` and `dsh/spec/schema/harness.schema.json` at the repo
 * root. The zod schema here is the runtime twin of that JSON Schema; the two must agree, and the
 * fixture under `dsh/starter-dsh/` is parsed by both in the spec.
 *
 * Every path in the manifest is relative to the DSH's install directory and must stay inside it —
 * a manifest is untrusted input (it arrives with a `git clone`), so `..` and absolute paths are
 * refused at parse time rather than discovered at copy time.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { ENGINES } from '../engines/types.js'

export const DSH_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/
export const DSH_MANIFEST_FILE = 'harness.json'
export const DEFAULT_VERDICT_PATH = '.harness/verdict.json'

function insideHarness(path: string): boolean {
  if (isAbsolute(path)) return false
  return !path.split(/[\\/]/).some((segment) => segment === '..')
}

const relativePath = z.string().min(1).max(512).refine(insideHarness, {
  message: 'must be a relative path inside the harness (no leading / and no ..)',
})
const command = z.string().min(1).max(4096)

/** A viewer a harness ships itself: the daemon runs `command` in the harness's install directory. */
const OwnViewerSchema = z.strictObject({
  command,
  url: z.string().min(1).max(2048),
  artifactExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).max(32).optional(),
})
/**
 * A viewer taken from another package (spec 1.1): `use` names a viewer package by id — installed
 * like a harness, run in ITS directory — and the harness may narrow the URL and the extensions.
 */
const UsedViewerSchema = z.strictObject({
  use: z.string().regex(DSH_ID_RE, 'viewer.use must be a package id, owner/name'),
  url: z.string().min(1).max(2048).optional(),
  artifactExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).max(32).optional(),
})

export const DshManifestSchema = z.strictObject({
  spec: z.literal(1),
  /**
   * What the package is (spec 1.1). An `agent` is a harness: a base engine plus skills, toolchain and
   * verdict, one tile in the picker. A `viewer` is a pane other packages point at with `viewer.use`;
   * it has no engine and is never a tile. Absent means agent.
   */
  kind: z.enum(['agent', 'viewer']).optional(),
  id: z.string().regex(DSH_ID_RE, 'id must be owner/name in lowercase letters, digits and dashes'),
  name: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
  /** The one- or two-word kind of thing it makes — "PCB", "CAD", "Slides" — the picker's second line. */
  category: z.string().min(1).max(24).optional(),
  /** Who made the agent — "Autonomous" for everything under autonomous/ — shown beside the category (spec 1.1). */
  author: z.string().min(1).max(80).optional(),
  /** Ids this harness answered to before: an agent created under one keeps its harness across a rename. */
  formerly: z.array(z.string().regex(DSH_ID_RE)).max(8).optional(),
  /** The base engine. Required for an agent; a viewer package has none. */
  engine: z.enum(ENGINES).optional(),
  workspace: z.strictObject({
    template: relativePath.optional(),
    marker: relativePath.optional(),
    init: command.optional(),
  }).optional(),
  agent: z.strictObject({
    instructions: relativePath.optional(),
    skills: z.array(relativePath).max(32).optional(),
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env keys are UPPER_SNAKE'), z.string().max(4096)).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
  }).optional(),
  toolchain: z.strictObject({
    setup: command.optional(),
    doctor: command.optional(),
  }).optional(),
  viewer: z.union([OwnViewerSchema, UsedViewerSchema]).optional(),
  verdict: relativePath.optional(),
}).superRefine((manifest, ctx) => {
  if (manifest.kind === 'viewer') {
    if (!manifest.viewer || !('command' in manifest.viewer)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['viewer'], message: 'a viewer package must ship viewer.command and viewer.url' })
    }
    if (manifest.engine) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['engine'], message: 'a viewer package has no engine' })
    if (manifest.agent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agent'], message: 'a viewer package has no agent' })
  } else if (!manifest.engine) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['engine'], message: 'an agent package needs a base engine' })
  }
})

export type DshManifest = z.infer<typeof DshManifestSchema>
export type DshViewerSpec = z.infer<typeof OwnViewerSchema>
export type DshViewerUse = z.infer<typeof UsedViewerSchema>

/** True for a viewer package: a pane others point at, never a tile. */
export function isViewerPackage(manifest: DshManifest): boolean {
  return manifest.kind === 'viewer'
}

/** The id of the viewer package this harness points at, or null when it ships its own (or none). */
export function viewerUse(manifest: DshManifest): string | null {
  return manifest.viewer && 'use' in manifest.viewer ? manifest.viewer.use : null
}

/** The base engine of an agent package; a viewer package answers null. */
export function dshEngine(manifest: DshManifest): DshManifest['engine'] | null {
  return manifest.engine ?? null
}

export type ManifestResult =
  | { ok: true; manifest: DshManifest }
  | { ok: false; error: string }

export function parseDshManifest(text: string): ManifestResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `harness.json is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = DshManifestSchema.safeParse(value)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `harness.json is not a spec-1 manifest: ${issues}` }
}

/** The manifest at `<dir>/harness.json`, or why there is none. */
export function readDshManifest(dir: string): ManifestResult {
  let text: string
  try {
    text = readFileSync(`${dir}/${DSH_MANIFEST_FILE}`, 'utf8')
  } catch (error) {
    return { ok: false, error: `no ${DSH_MANIFEST_FILE} in ${dir} (${error instanceof Error ? error.message : String(error)})` }
  }
  return parseDshManifest(text)
}

/** The variables a manifest value may name. `${dsh}` is the install directory. */
export interface DshVars {
  dsh: string
  workspace: string
  home?: string
}

/** Expand `${dsh}`, `${workspace}` and `${home}`; anything else is left exactly as written. */
export function expandDshValue(value: string, vars: DshVars): string {
  const home = vars.home ?? homedir()
  return value.replace(/\$\{(dsh|workspace|home)\}/g, (_, name: string) => (
    name === 'dsh' ? vars.dsh : name === 'workspace' ? vars.workspace : home
  ))
}

/** Which tier the manifest declares, by what it ships — the desktop shows this on the tile. */
export function dshTier(manifest: DshManifest): 0 | 1 | 2 {
  if (manifest.viewer) return 2 // its own, or one it uses: either way a pane opens beside it
  if (manifest.verdict) return 1
  return 0
}

/** The workspace-relative path of the verdict file, defaulted. */
export function dshVerdictPath(manifest: DshManifest): string {
  return manifest.verdict ?? DEFAULT_VERDICT_PATH
}

/** Where a base engine looks for project-level skills. */
export function dshSkillsDirFor(engine: NonNullable<DshManifest['engine']>): string {
  return engine === 'claude' ? '.claude/skills' : '.agents/skills'
}
