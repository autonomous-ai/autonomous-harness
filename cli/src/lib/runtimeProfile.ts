import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { env } from '../config/env.js'
import { parseMuseSettings } from '../engines/muse/runtimeProfile.js'
import { parseAmpSession } from '../engines/amp/runtimeProfile.js'
import type { AgentEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import {
  DEVIN_EFFORTS,
  devinFooterModel,
  parseDevinModelsOutput,
  type DevinModelTarget,
} from '../engines/devin/runtimeProfile.js'
import {
  HERMES_EFFORTS,
  hermesStatusModel,
  parseHermesConfig,
  parseHermesModelsCache,
  type HermesModelTarget,
} from '../engines/hermes/runtimeProfile.js'
import {
  COMMANDCODE_EFFORTS,
  commandcodeBannerModel,
  COMMANDCODE_EFFORT_LEVELS,
  parseCommandcodeModelsOutput,
  type CommandcodeModelTarget,
} from '../engines/commandcode/runtimeProfile.js'
import {
  opencodeFooterModelId,
  parseOpencodeFooter,
  parseOpencodeModelsOutput,
  type OpencodeModelTarget,
} from '../engines/opencode/runtimeProfile.js'
import {
  kiloFooterModelId,
  parseKiloModelsOutput,
  type KiloModelTarget,
} from '../engines/kilo/runtimeProfile.js'
import {
  PI_EFFORTS,
  PI_THINKING_LEVELS,
  parsePiFooterProfile,
  parsePiModelsOutput,
} from '../engines/pi/runtimeProfile.js'
import { parseGrokFooterProfile } from '../engines/grok/runtimeProfile.js'
import { parseAgyFooterProfile } from '../engines/agy/runtimeProfile.js'

export interface RuntimeProfile {
  id: string
  sessionId: string
  engine: AgentEngine
  model: string
  effort: string
}

export interface RuntimeModelOption {
  id: string
  displayName: string
}

export interface RuntimeState {
  model: string | null
  effort: string | null
  mode: 'default' | 'plan' | 'unknown'
  cliVersion: string | null
  observedAt: number | null
}

export interface CursorModelTarget {
  rawId: string
  modelKey: string
  familyLabel: string
  context: string | null
  reasoning: string | null
  fast: boolean | null
  thinking: boolean | null
  /** Effort text rendered in the idle footer; null means Cursor omits its native default. */
  footerEffort?: string | null
}

interface CursorCatalogEntry {
  target: CursorModelTarget
  effort: string
  modelLabel: string
}

interface RuntimeControl {
  target: RuntimeProfile
  before: string | null
  modelConfirmed: boolean
  effortConfirmed: boolean
}

interface StateWaiter {
  check: () => boolean
  resolve: (matched: boolean) => void
  timer: NodeJS.Timeout
}

interface CodexCacheModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  supported_reasoning_levels?: Array<{ effort?: unknown }>
}

interface CodexCache {
  models?: CodexCacheModel[]
}

const PROFILE_RE = /^runtime-v1:([^:]+):(claude|codex|cursor|commandcode|pi|devin|opencode|hermes|muse|amp|kilo|grok|agy|copilot):([^@]+)@([a-z0-9_-]+)$/i
const CODEX_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const CLAUDE_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
const CURSOR_EFFORTS = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
const EFFORTS = new Set([
  ...CODEX_EFFORTS, ...CLAUDE_EFFORTS, ...CURSOR_EFFORTS, ...PI_EFFORTS, ...DEVIN_EFFORTS,
  ...COMMANDCODE_EFFORTS, ...HERMES_EFFORTS,
])
/**
 * Versions whose model UI was driven by hand before wiring it up. Open-ended upward: a newer CLI is
 * assumed compatible (the alternative — refusing to switch after every auto-update — is worse), but a
 * KNOWN-older one is refused rather than driven blind.
 */
const DEVIN_CONTROL_MIN_VERSION: [number, number, number] = [3000, 3, 22]
const PI_CONTROL_MIN_VERSION: [number, number, number] = [0, 82, 0]
const OPENCODE_CONTROL_MIN_VERSION: [number, number, number] = [1, 18, 7]
/**
 * 1.6.0 is the first Command Code that can be driven at all: it added `--list-models` (a catalog on
 * stdout) and made `/model <id>` and `/effort <level>` take arguments. On 1.5 and older the only route was
 * arrow-driving a 49-row picker, which is exactly what got the first attempt reverted — so older builds
 * are refused rather than driven.
 */
const COMMANDCODE_CONTROL_MIN_VERSION: [number, number, number] = [1, 6, 0]
/**
 * Hermes ships no version its hook payload exposes, and its `/model` picker has been the same two-level
 * arrow list throughout — so it is gated on the picker being recognisable rather than on a number. The
 * driver refuses to move if it cannot read the cursor (see setHermes), which is the real safety net.
 */
const HERMES_CONTROL_UNVERSIONED = true
/**
 * Cap on how many rows an engine's catalog may contribute. Devin publishes 166 across 72 families, and a
 * 49-row picker was enough to stall the device's the device UI task into a watchdog reset (see the Command Code
 * revert, 2026-07-30). The device already truncates at CATALOG_MAX/PICK_MAX, but truncation there is
 * arbitrary — bounding here keeps the rows we DO send meaningful (see devinModels).
 */
const CATALOG_LIMIT = 96
const BASIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_ALIASES = ['default', 'opus', 'fable', 'sonnet', 'haiku'] as const
const CHANGE_DEBOUNCE_MS = 120
const CLAUDE_ULTRACODE_MIN_VERSION: [number, number, number] = [2, 1, 209]
const CURSOR_CONTROLLED_BUILD = '2026.07.20-8cc9c0b'
const CURSOR_CATALOG_TTL_MS = 5 * 60_000
/** Shared TTL for the stdout catalogs (devin, pi) — same rationale as the cursor one. */
const CATALOG_TTL_MS = 5 * 60_000
import { opencodeBin } from './engineBin.js'

const execFileAsync = promisify(execFile)

function decode(value: string): string | null {
  try {
    const out = decodeURIComponent(value)
    return out ? out : null
  } catch {
    return null
  }
}

export function encodeRuntimeProfile(profile: Omit<RuntimeProfile, 'id'>): string {
  return `runtime-v1:${encodeURIComponent(profile.sessionId)}:${profile.engine}:${encodeURIComponent(profile.model)}@${profile.effort}`
}

export function parseRuntimeProfile(value: unknown): RuntimeProfile | null {
  if (typeof value !== 'string') return null
  const match = PROFILE_RE.exec(value)
  if (!match) return null
  const sessionId = decode(match[1])
  const model = decode(match[3])
  const effort = match[4].toLowerCase()
  if (!sessionId || !model || !EFFORTS.has(effort)) return null
  return {
    id: value,
    sessionId,
    engine: match[2].toLowerCase() as AgentEngine,
    model,
    effort,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')
}

function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (typeof item === 'string') return item
    const obj = record(item)
    return text(obj?.text) || text(obj?.content)
  }).filter(Boolean).join('\n')
}

function confirmsClaudeAutoEffort(content: string): boolean {
  return [
    /\b(?:set|reset)\b.{0,40}\b(?:effort level|effort)\b.{0,40}\b(?:auto|model default)\b/i,
    /\b(?:effort level|effort)\b.{0,40}\b(?:set|reset)\b.{0,40}\b(?:auto|model default)\b/i,
    /\busing\b.{0,40}\bauto\b.{0,40}\beffort\b/i,
  ].some((pattern) => pattern.test(content))
}

function parseVersion(value: string | null): [number, number, number] | null {
  const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(value ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function versionAtLeast(value: string | null, wanted: [number, number, number]): boolean {
  const parsed = parseVersion(value)
  if (!parsed) return false
  for (let i = 0; i < wanted.length; i++) {
    if (parsed[i] !== wanted[i]) return parsed[i] > wanted[i]
  }
  return true
}

export function supportsNativeRuntimeControl(session: RegisteredSession): boolean {
  // A gateway agent (`ori claude`, `ori codex`) is DISPLAY-ONLY (owner, 2026-08-17). Its CLI runs with
  // gateway model discovery, so the picker holds the user's OpenRouter catalog rather than the native
  // aliases this controller knows how to type — and a `/model opus` typed into that pane would be a
  // guess. The chip still names what it is running; nothing offers to change it.
  if (session.gateway) return false
  // Switching is Claude and Codex only (owner, 2026-07-31); everything else is view-only, so it never gets
  // here with anything to apply. This is the second gate rather than the only one — modelsForSession
  // already returns an empty catalogue for those engines — because a stale profile id from an older device
  // would otherwise still drive a CLI the owner took off the switchable list.
  if (session.engine === 'claude') return versionAtLeast(session.cliVersion, [2, 1, 153])
  if (session.engine !== 'codex') return false
  if (session.engine !== 'codex') return false
  const version = parseVersion(session.cliVersion)
  return !!version && version[0] === 0 && (version[1] === 144 || version[1] === 145)
}

export function codexEffortAllowed(model: string, effort: string): boolean {
  if (!CODEX_EFFORTS.has(effort)) return false
  if (effort !== 'max' && effort !== 'ultra') return true
  return /^gpt-5\.6(?:-|$)/i.test(model) || model.toLowerCase() === 'codex-auto-review'
}

function titlePart(value: string): string {
  if (/^gpt$/i.test(value)) return 'GPT'
  if (/^xhigh$/i.test(value)) return 'XHigh'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function runtimeModelLabel(model: string): string {
  const alias = /^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$/i.exec(model)
  if (alias) return `${titlePart(alias[1].toLowerCase())}${alias[2] ?? ''}`
  return model.split(/[-_]/).filter(Boolean).map(titlePart).join(' ')
}

function effortLabel(effort: string): string {
  return effort === 'xhigh' ? 'XHigh' : titlePart(effort)
}

function cursorEffortFromId(rawId: string): { effort: string | null; modelKey: string } {
  const parts = rawId.split('-')
  let index = -1
  let width = 1
  for (let i = 2; i < parts.length; i++) {
    if (parts[i] === 'extra' && parts[i + 1] === 'high') {
      index = i
      width = 2
      i++
    } else if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(parts[i])) {
      index = i
      width = 1
    }
  }
  if (index < 0) return { effort: null, modelKey: rawId }
  const rawEffort = parts.slice(index, index + width).join('-')
  parts.splice(index, width)
  return {
    effort: rawEffort === 'extra-high' ? 'xhigh' : rawEffort,
    modelKey: parts.join('-'),
  }
}

function cursorEffortFromDisplay(value: string): string | null {
  const match = /\b(Extra High|None|Low|Medium|High|Max)\b/i.exec(value)
  if (!match) return null
  return match[1].toLowerCase().replace(/\s+/g, '') === 'extrahigh'
    ? 'xhigh'
    : match[1].toLowerCase()
}

function cursorDisplayParts(displayName: string): {
  familyLabel: string
  context: string | null
  fast: boolean
  thinking: boolean
} {
  let value = displayName
    .replace(/\s+\((?:current|default)(?:,\s*(?:current|default))?\)\s*$/i, '')
    .replace(/\s+\(NO ZDR\)\s*$/i, '')
    .replace(/\s*[·│]\s*\d+(?:\.\d+)?%.*$/i, '')
    .trim()
  const contextMatch = /\b(\d+(?:\.\d+)?[KM])\b/i.exec(value)
  const context = contextMatch?.[1].toLowerCase() ?? null
  const fast = /\bFast\b/i.test(value)
  const thinking = !/\bNo\s+Thinking\b/i.test(value) && /\bThinking\b/i.test(value)
  value = value
    .replace(/\b\d+(?:\.\d+)?[KM]\b/gi, '')
    .replace(/\bExtra High\b/gi, '')
    .replace(/\b(?:None|Low|Medium|High|Max)\b/gi, '')
    .replace(/\bNo\s+Thinking\b/gi, '')
    .replace(/\b(?:Fast|Thinking)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { familyLabel: value, context, fast, thinking }
}

/** Strictly parse `agent models`; headings, tips and malformed rows are ignored. */
export function parseCursorModelsOutput(output: string): CursorCatalogEntry[] {
  const candidates: Array<CursorCatalogEntry & { explicitEffort: boolean }> = []
  for (const rawLine of output.split('\n')) {
    const match = /^([a-z0-9][a-z0-9._-]*) - (.+?)\s*$/i.exec(rawLine)
    if (!match) continue
    const rawId = match[1]
    const displayName = match[2].trim()
    const display = cursorDisplayParts(displayName)
    if (!display.familyLabel) continue
    if (rawId === 'auto') {
      candidates.push({
        target: {
          rawId,
          modelKey: rawId,
          familyLabel: 'Auto',
          context: null,
          reasoning: null,
          fast: null,
          thinking: null,
          footerEffort: 'auto',
        },
        effort: 'auto',
        modelLabel: 'Auto',
        explicitEffort: true,
      })
      continue
    }
    const parsed = cursorEffortFromId(rawId)
    const effort = parsed.effort
    const footerEffort = cursorEffortFromDisplay(displayName)
    candidates.push({
      target: {
        rawId,
        modelKey: parsed.modelKey,
        familyLabel: display.familyLabel,
        context: display.context,
        reasoning: effort,
        fast: display.fast,
        thinking: display.thinking,
        footerEffort,
      },
      effort: effort ?? 'auto',
      modelLabel: [
        display.familyLabel,
        display.context ? `(${display.context.toUpperCase()})` : '',
        display.thinking ? 'Thinking' : '',
        display.fast ? 'Fast' : '',
      ].filter(Boolean).join(' '),
      explicitEffort: effort !== null,
    })
  }

  // Some medium/default rows omit the effort segment (for example `gpt-5.3-codex`).
  // Infer medium only when explicit siblings prove that the same exact model group has efforts.
  const effortfulGroups = new Set(candidates.filter((item) => item.explicitEffort).map((item) => item.target.modelKey))
  for (const item of candidates) {
    if (item.target.rawId === 'auto' || item.effort !== 'auto' || !effortfulGroups.has(item.target.modelKey)) continue
    item.effort = 'medium'
    item.target.reasoning = 'medium'
  }
  return candidates.map(({ explicitEffort: _explicitEffort, ...item }) => item)
}

function parseCursorFooter(value: string): {
  familyLabel: string
  context: string | null
  effort: string | null
  fast: boolean
  thinking: boolean
} | null {
  const line = stripAnsi(value).trim()
  if (/^Auto(?:\s*$|\s*[·│])/i.test(line)) {
    return { familyLabel: 'Auto', context: null, effort: 'auto', fast: false, thinking: false }
  }
  const effort = cursorEffortFromDisplay(line)
  const hasUsage = /[·│]\s*\d+(?:\.\d+)?%/i.test(line)
  const hasThinkingMode = /\b(?:No\s+Thinking|Thinking)\b/i.test(line)
  if (!effort && !hasUsage && !hasThinkingMode) return null
  const parts = cursorDisplayParts(line)
  if (!parts.familyLabel || !/\d/.test(parts.familyLabel)) return null
  return {
    ...parts,
    effort,
  }
}

function cursorSyntheticTarget(
  parsed: NonNullable<ReturnType<typeof parseCursorFooter>>,
  effort: string,
): CursorModelTarget {
  if (parsed.familyLabel.toLowerCase() === 'auto' && parsed.effort === 'auto') {
    return {
      rawId: 'auto',
      modelKey: 'auto',
      familyLabel: 'Auto',
      context: null,
      reasoning: null,
      fast: null,
      thinking: null,
      footerEffort: 'auto',
    }
  }
  const family = parsed.familyLabel.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'model'
  // Keep the public runtime-v1 model key compatible with every client formatter. The Cursor routing
  // details remain on CursorModelTarget (and rawId) for selection/confirmation; they do not belong in
  // the user-facing profile key as a percent-encoded "[fast=...,thinking=...]" implementation detail.
  const modelKey = [
    family,
    parsed.context?.toLowerCase() ?? '',
    parsed.thinking ? 'thinking' : '',
    parsed.fast ? 'fast' : '',
  ].filter(Boolean).join('-')
  const parameters = [
    parsed.context ? `context=${parsed.context}` : '',
    `fast=${parsed.fast}`,
    `thinking=${parsed.thinking}`,
  ].filter(Boolean).join(',')
  return {
    rawId: `cursor-${family}[${parameters},effort=${effort}]`,
    modelKey,
    familyLabel: parsed.familyLabel,
    context: parsed.context,
    reasoning: effort === 'auto' ? null : effort,
    fast: parsed.fast,
    thinking: parsed.thinking,
    footerEffort: parsed.effort,
  }
}

function normalizeClaudeDisplay(value: string): string | null {
  const cleaned = value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+\(default\).*$/i, '')
    .replace(/\s+and saved.*$/i, '')
    .replace(/\s+for (?:the )?current session.*$/i, '')
    .trim()
  if (!cleaned) return null
  const alias = /^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$/i.exec(cleaned)
  if (alias) return `${alias[1].toLowerCase()}${alias[2]?.toLowerCase() ?? ''}`
  const family = /^(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)(?:\s+\(1M context\))?/i.exec(cleaned)
  if (family) return `claude-${family[1].toLowerCase()}-${family[2].replace(/\./g, '-')}${/1M context/i.test(cleaned) ? '[1m]' : ''}`
  if (/^claude-[a-z0-9._:-]+(?:\[1m\])?$/i.test(cleaned)) return cleaned.toLowerCase()
  return null
}

function claudeAliasForModel(model: string): string | null {
  const normalized = model.toLowerCase()
  if ((CLAUDE_ALIASES as readonly string[]).includes(normalized)) return normalized
  return /^claude-(opus|fable|sonnet|haiku)(?:-|$)/.exec(normalized)?.[1] ?? null
}

function claudeEfforts(model: string, cliVersion: string | null = null): string[] {
  // `[1m]` marks the 1M-context variant, not a different model — strip it so `claude-opus-5[1m]` gets
  // the same efforts as `claude-opus-5` (otherwise a 1M model looked effort-less and a /model switch
  // reset the observed effort to `auto`). The version match is open-ended (4.7/4.8, then 5+) so a new
  // release like Opus 5 works without a code change.
  const normalized = model.toLowerCase().replace(/\[1m\]$/, '')
  let efforts: string[] = []
  if (/^claude-(?:opus|fable|sonnet)-(?:4-[78]|[5-9]|\d{2,})(?:-|$)/.test(normalized)) efforts = [...BASIC_EFFORTS]
  else if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(normalized)) efforts = ['low', 'medium', 'high', 'max']
  else if (/^(?:fable|opus|sonnet)$/.test(normalized)) efforts = [...BASIC_EFFORTS]
  if (efforts.length > 0 && versionAtLeast(cliVersion, CLAUDE_ULTRACODE_MIN_VERSION)) efforts.push('ultracode')
  return efforts
}

function availableModelMatches(model: string, allowed: string[]): boolean {
  if (model === 'default') return true
  if (allowed.length === 0) return true
  const lower = model.toLowerCase()
  const family = lower.replace(/\[1m\]$/, '')
  const wantsLongContext = lower.endsWith('[1m]')
  return allowed.some((item) => {
    const candidate = item.toLowerCase()
    const sameFamily = candidate.includes(`-${family}-`) || candidate.endsWith(`-${family}`)
    const contextMatches = wantsLongContext === /(?:\[1m\]|1m.context)/i.test(candidate)
    return lower === candidate || lower.startsWith(`${candidate}-`) || lower.startsWith(`${candidate}[`) || (sameFamily && contextMatches)
  })
}

function currentPaneUi(paneText: string): string {
  const lines = paneText.split('\n')
  const promptIndex = lines.findLastIndex((line) => {
    const marker = line.search(/[›❯→]/u)
    return marker >= 0 && !/^\s*\d+\.\s/.test(line.slice(marker + 1))
  })
  return (promptIndex >= 0 ? lines.slice(promptIndex) : lines).join('\n')
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readFile(file, 'utf8'))) } catch { return null }
}

/** Raw file text, or '' when it cannot be read — hermes' config is YAML, not JSON. */
async function readText(file: string): Promise<string> {
  try { return await readFile(file, 'utf8') } catch { return '' }
}

function claudeSettingsFiles(session: RegisteredSession): string[] {
  const root = dirname(env.CLAUDE_PROJECTS_DIR)
  const files = [join(root, 'settings.json')]
  if (session.cwd) {
    files.push(join(session.cwd, '.claude', 'settings.json'))
    files.push(join(session.cwd, '.claude', 'settings.local.json'))
  }
  return files
}

async function claudeAvailableModels(session: RegisteredSession): Promise<string[]> {
  const merged: string[] = []
  for (const file of claudeSettingsFiles(session)) {
    const config = await readJson(file)
    const values = config?.availableModels
    if (!Array.isArray(values)) continue
    for (const value of values) if (typeof value === 'string' && !merged.includes(value)) merged.push(value)
  }
  return merged
}

/** Command Code ids are "vendor/name"; everything we store and show uses the name alone. */
function shortCommandcodeModel(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

/**
 * Command Code keeps the reasoning level in its GLOBAL config, keyed by the FULL gateway id:
 *   { "model": "deepseek/deepseek-v4-flash", "reasoningEffort": { "deepseek/deepseek-v4-flash": "high" } }
 * Nothing in the transcript, the pane footer or the session header carries it, so this file is the only
 * source. It is per MACHINE rather than per session: two agents on the same model necessarily read the same
 * level. Matching is done on the short name because that is what the running model is stored as.
 */
/** The configured level for `model`, or 'auto' when the model has none set. */
async function commandcodeConfiguredEffort(model: string | null): Promise<{ effort: string; defaultModel: string }> {
  const config = await readJson(join(env.COMMANDCODE_HOME, 'config.json'))
  const defaultModel = shortCommandcodeModel(text(config?.model))
  const efforts = record(config?.reasoningEffort)
  const wanted = model || defaultModel
  if (!efforts || !wanted) return { effort: 'auto', defaultModel }
  for (const [id, level] of Object.entries(efforts)) {
    if (shortCommandcodeModel(id) !== wanted) continue
    const normalized = text(level).toLowerCase()
    if (normalized && normalized !== 'default' && EFFORTS.has(normalized)) return { effort: normalized, defaultModel }
  }
  return { effort: 'auto', defaultModel }
}

async function claudeConfiguredEffort(session: RegisteredSession): Promise<string> {
  let configured: string | null = null
  for (const file of claudeSettingsFiles(session)) {
    const config = await readJson(file)
    const raw = text(config?.effortLevel) || text(config?.effort)
    const normalized = raw.toLowerCase() === 'default' ? 'auto' : raw.toLowerCase()
    if (CLAUDE_EFFORTS.has(normalized)) configured = normalized
  }
  return configured ?? 'auto'
}

function addOption(
  output: RuntimeModelOption[],
  seen: Set<string>,
  session: RegisteredSession,
  model: string,
  effort: string,
  modelLabel = runtimeModelLabel(model),
): void {
  // The id inside a `runtime-v1:` string is what the web/device echoes back on a pick, so it is the
  // AGENT id — the public one — not the engine session that happens to be bound right now.
  const id = encodeRuntimeProfile({ sessionId: session.agentId, engine: session.engine, model, effort })
  if (seen.has(id)) return
  seen.add(id)
  output.push({ id, displayName: `${modelLabel} / ${effortLabel(effort)}` })
}

export class RuntimeProfileManager {
  private readonly states = new Map<string, RuntimeState>()
  private readonly controls = new Map<string, RuntimeControl>()
  private readonly waiters = new Map<string, Set<StateWaiter>>()
  private readonly changeTimers = new Map<string, NodeJS.Timeout>()
  private readonly cursorTargets = new Map<string, Map<string, CursorModelTarget>>()
  /** profile id → the exact `/model` argument, per session (devin ids are not derivable from the key). */
  private readonly devinTargets = new Map<string, Map<string, DevinModelTarget>>()
  private devinCatalogCache: { key: string; expiresAt: number; entries: DevinModelTarget[] } | null = null
  private piCatalogCache: { key: string; expiresAt: number; entries: ReturnType<typeof parsePiModelsOutput> } | null = null
  private opencodeCatalogCache: { key: string; expiresAt: number; entries: OpencodeModelTarget[] } | null = null
  private kiloCatalogCache: { key: string; expiresAt: number; entries: KiloModelTarget[] } | null = null
  private commandcodeCatalogCache: { key: string; expiresAt: number; entries: CommandcodeModelTarget[] } | null = null
  /** profile id → the full `/model` argument (the profile carries the SHORT name the device labels by). */
  private readonly commandcodeTargets = new Map<string, Map<string, CommandcodeModelTarget>>()
  private hermesCatalogCache: { key: string; expiresAt: number; entries: HermesModelTarget[] } | null = null
  /** profile id → the picker page + row a hermes model sits on. */
  private readonly hermesTargets = new Map<string, Map<string, HermesModelTarget>>()
  private cursorCatalogCache: { key: string; expiresAt: number; entries: CursorCatalogEntry[] } | null = null
  private suppressNotifications = 0
  onChanged: ((sessionId: string) => void) | null = null

  hydrate(session: RegisteredSession, rawLines: string[]): void {
    this.states.set(session.sessionId, {
      // Registries written by older builds can hold a non-string model; treat it as unknown instead of
      // letting it reach claudeAliasForModel and abort startup.
      model: typeof session.model === 'string' ? session.model : null,
      effort: null,
      mode: 'unknown',
      cliVersion: session.cliVersion,
      observedAt: null,
    })
    for (const line of rawLines) this.ingest(session, line, true)
  }

  ingest(session: RegisteredSession, rawLine: string, silent = false): boolean {
    let raw: Record<string, unknown> | null
    try { raw = record(JSON.parse(rawLine)) } catch { return false }
    if (!raw) return false
    const before = this.selectedModel(session)
    if (session.engine === 'codex') this.ingestCodex(session, raw)
    else if (session.engine === 'cursor') this.ingestCursor(session, raw)
    else if (session.engine === 'commandcode') {
      const model = this.states.get(session.sessionId)?.model ?? null
      this.ingestCommandcode(session, raw)
      // The reasoning level is stored PER MODEL, so a model change makes the level we are holding wrong.
      // Re-read it now instead of showing the previous model's level until the next poll.
      if ((this.states.get(session.sessionId)?.model ?? null) !== model) {
        void this.ingestConfig(session, silent).catch(() => undefined)
      }
    }
    else if (session.engine === 'grok') this.ingestGrok(session, raw)
    else this.ingestClaude(session, raw)
    const after = this.selectedModel(session)
    this.wake(session.sessionId)
    if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) this.scheduleChanged(session.sessionId)
    return before !== after
  }

  async ingestConfig(session: RegisteredSession, silent = false): Promise<boolean> {
    if (session.engine === 'hermes') {
      // Both axes are scalars in config.yaml and neither is announced, so this poll is the only reader.
      const before = this.selectedModel(session)
      const state = this.state(session.sessionId)
      const parsed = parseHermesConfig(await readText(join(env.HERMES_HOME, 'config.yaml')))
      if (parsed.model) state.model = parsed.model.slice(parsed.model.lastIndexOf('/') + 1)
      state.effort = parsed.effort ?? 'auto'
      state.observedAt = Date.now()
      const after = this.selectedModel(session)
      this.wake(session.sessionId)
      if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {
        this.scheduleChanged(session.sessionId)
      }
      return before !== after
    }
    if (session.engine === 'muse') {
      // Both axes are plain scalars in ~/.config/muse/settings.json (`model`, `reasoning_effort`) and
      // neither is announced anywhere, so reading the file IS the only way the chip is ever populated.
      // `reasoning_effort` is muse's own vocabulary (none|minimal|low|medium|high|xhigh|ultra); the
      // absence of the key means the CLI default, which its own --help documents as `high`.
      const before = this.selectedModel(session)
      const state = this.state(session.sessionId)
      const parsed = parseMuseSettings(await readText(join(env.MUSE_CONFIG_DIR, 'settings.json')))
      if (parsed.model) state.model = parsed.model
      state.effort = parsed.effort ?? 'auto'
      state.observedAt = Date.now()
      const after = this.selectedModel(session)
      this.wake(session.sessionId)
      if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {
        this.scheduleChanged(session.sessionId)
      }
      return before !== after
    }
    if (session.engine === 'amp') {
      // Amp has no models — only agent MODES — so the mode is reported as the model and there is no
      // second axis to report. `~/.local/share/amp/session.json` is the only local place it is written.
      const before = this.selectedModel(session)
      const state = this.state(session.sessionId)
      const parsed = parseAmpSession(await readText(join(env.AMP_STATE_DIR, 'session.json')))
      if (parsed.mode) state.model = parsed.mode
      state.effort = 'auto'
      state.observedAt = Date.now()
      const after = this.selectedModel(session)
      this.wake(session.sessionId)
      if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {
        this.scheduleChanged(session.sessionId)
      }
      return before !== after
    }
    if (session.engine === 'opencode') {
      // The footer only resolves against the catalog, so warm it here — `ingestPane` is synchronous and
      // cannot fetch, and without this the chip stays blank until the web happens to ask for models.
      await this.opencodeCatalog()
      return false
    }
    if (session.engine === 'kilo') {
      // Same reason as opencode: kilo names its model only in the composer footer, which resolves only
      // against the catalog, and `ingestPane` is synchronous.
      await this.kiloCatalog()
      return false
    }
    if (session.engine === 'devin') {
      // Same shape: devin's model exists only as a DISPLAY name in its pane footer, and only the catalog
      // maps that back to a model key + effort. Warm it on attach so the first pane read resolves.
      await this.devinCatalog()
      return false
    }
    if (session.engine !== 'claude' && session.engine !== 'commandcode') return false
    const before = this.selectedModel(session)
    const state = this.state(session.sessionId)
    if (session.engine === 'commandcode') {
      const config = await commandcodeConfiguredEffort(state.model)
      state.effort = config.effort
      // Before the agent has answered once there is no transcript line to read the model from; the config's
      // own model is what a fresh session starts on, so the chip names it instead of falling back to Auto.
      if (!state.model && config.defaultModel) state.model = config.defaultModel
    } else {
      state.effort = await claudeConfiguredEffort(session)
    }
    state.observedAt = Date.now()
    const after = this.selectedModel(session)
    this.wake(session.sessionId)
    if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {
      this.scheduleChanged(session.sessionId)
    }
    return before !== after
  }

  ingestPane(session: RegisteredSession, paneText: string, silent = false): boolean {
    const before = this.selectedModel(session)
    const state = this.state(session.sessionId)
    paneText = stripAnsi(paneText)
    const currentUi = currentPaneUi(paneText)
    if (session.engine === 'codex') {
      const matches = [...paneText.matchAll(/\b(gpt-[a-z0-9][a-z0-9._-]*)\s+(low|medium|high|xhigh|max|ultra|default)\s*[·│]/gi)]
      const latest = matches[matches.length - 1]
      if (latest) {
        state.model = latest[1].toLowerCase()
        state.effort = latest[2].toLowerCase() === 'default' ? 'auto' : latest[2].toLowerCase()
        state.observedAt = Date.now()
      }
      if (/\bplan mode\b/i.test(currentUi)) state.mode = 'plan'
      else if (/\b(?:default|work) mode\b/i.test(currentUi)) state.mode = 'default'
    } else if (session.engine === 'cursor') {
      if (/Available models|Models matching|— Edit Parameters|Type to filter.*Tab to edit|Esc to go back/i.test(currentUi)) return false
      const footerLines = currentUi.split('\n')
        .filter((line) => stripAnsi(line).trim())
        .slice(-12)
        .reverse()
      const parsed = footerLines.map(parseCursorFooter).find((item) => item !== null)
      if (parsed) {
        const targets = this.cursorTargets.get(session.sessionId) ?? new Map<string, CursorModelTarget>()
        let target = [...targets.values()].find((candidate) =>
          candidate.familyLabel.toLowerCase() === parsed.familyLabel.toLowerCase()
          && (parsed.effort
            ? (candidate.reasoning ?? 'auto') === parsed.effort
            : candidate.footerEffort === null)
          && (candidate.fast ?? false) === parsed.fast
          && (candidate.thinking ?? false) === parsed.thinking
          && (!candidate.context || candidate.context === parsed.context))
        const effort = parsed.effort ?? target?.reasoning ?? 'auto'
        if (!target) {
          target = cursorSyntheticTarget(parsed, effort)
          const id = encodeRuntimeProfile({
            sessionId: session.agentId,
            engine: 'cursor',
            model: target.modelKey,
            effort,
          })
          targets.set(id, target)
          this.cursorTargets.set(session.sessionId, targets)
        }
        state.model = target.modelKey
        state.effort = effort
        state.observedAt = Date.now()
        const control = this.controls.get(session.sessionId)
        if (control && target?.modelKey === control.target.model && effort === control.target.effort) {
          control.modelConfirmed = true
          control.effortConfirmed = true
        }
      }
      if (/\bPlan\b/i.test(currentUi)) state.mode = 'plan'
      else if (/Plan, search, build anything/i.test(currentUi)) state.mode = 'default'
    } else if (session.engine === 'devin') {
      // Devin writes no transcript unless the user passes `--export`, so the footer's bottom-left cell is
      // the only per-session record of the running model. It is a DISPLAY name (`SWE-1.6 Slow`); the
      // catalog resolves it back to a model key so the chip and the picker agree.
      const label = devinFooterModel(paneText)
      const model = label ? this.devinModelKeyForLabel(session.sessionId, label) : null
      if (model) {
        state.model = model.modelKey
        state.effort = model.effort
        state.observedAt = Date.now()
        this.confirmObserved(session.sessionId, model.modelKey, model.effort)
      }
    } else if (session.engine === 'hermes') {
      // `⚕ minimax-m3 │ ctx --` — the status line is how a switch is seen immediately; config.yaml is
      // rewritten too, but the poll that reads it runs on its own schedule.
      const model = hermesStatusModel(paneText)
      if (model && model !== state.model) {
        state.model = model
        state.observedAt = Date.now()
      }
    } else if (session.engine === 'commandcode') {
      // `/model` reprints the session banner (`# models: kimi-k2.6 · taste-1`) with the new model. The
      // transcript would say the same thing, but only after the NEXT turn runs — too late to confirm a
      // switch, and long enough for the chip to look stuck.
      const model = commandcodeBannerModel(paneText)
      if (model && model !== state.model) {
        state.model = model
        state.observedAt = Date.now()
        // Effort is stored per model in the CLI's global config, so the level we hold belongs to the old
        // one. Re-read rather than carry it across.
        void this.ingestConfig(session, true).catch(() => undefined)
      }
    } else if (session.engine === 'opencode') {
      // OpenCode names what is running in its composer footer
      // (`Build · MiniMax M3 (vibe) Vibe Gateway · high`). Prefer the catalog entry it resolves to,
      // because that id is also what a SWITCH is addressed to — the cached entries rather than a
      // fresh (async) fetch, since this runs on the pane poll.
      //
      // Fall back to the footer's own words when the catalog does not list it. That is not a corner
      // case: with no provider connected OpenCode runs a built-in free model that `opencode models`
      // never prints, so insisting on a catalog match left the chips blank on a freshly opened agent
      // — showing nothing about a model the terminal was naming two lines below.
      const footer = parseOpencodeFooter(paneText)
      const id = opencodeFooterModelId(paneText, this.opencodeCatalogCache?.entries ?? [])
      const model = id ?? footer?.target ?? null
      if (model) {
        // 'auto' remains the default: early builds had no reasoning axis at all, and inventing a
        // level for them would put a wrong value on the chip instead of an empty one.
        const effort = footer?.effort ?? 'auto'
        state.model = model
        state.effort = effort
        state.observedAt = Date.now()
        this.confirmObserved(session.sessionId, model, effort)
      }
    } else if (session.engine === 'kilo') {
      // Kilo names the model in its composer footer too, but the line is shaped differently enough that
      // its resolver had to be rewritten rather than renamed — see engines/kilo/runtimeProfile.ts.
      const id = kiloFooterModelId(paneText, this.kiloCatalogCache?.entries ?? [])
      if (id) {
        state.model = id
        state.effort = 'auto'
        state.observedAt = Date.now()
        this.confirmObserved(session.sessionId, id, 'auto')
      }
    } else if (session.engine === 'pi') {
      // Pi puts both axes in one footer cell: `minimax/minimax-m3 • high`.
      const footer = parsePiFooterProfile(paneText)
      if (footer) {
        state.model = footer.model
        state.effort = footer.effort
        state.observedAt = Date.now()
        this.confirmObserved(session.sessionId, footer.model, footer.effort)
      }
    } else if (session.engine === 'grok') {
      const footer = parseGrokFooterProfile(paneText)
      if (footer) {
        state.model = footer.model
        state.effort = footer.effort
        state.observedAt = Date.now()
      }
    } else if (session.engine === 'agy') {
      // agy's transcript never names the model, so the pane footer is the only continuous source; the
      // hook payload's `modelName` seeds it at session start.
      const footer = parseAgyFooterProfile(paneText)
      if (footer) {
        state.model = footer.model
        state.effort = footer.effort
        state.observedAt = Date.now()
      }
    } else {
      const header = /(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)(\s+\(1M context\))?\s+with\s+(low|medium|high|xhigh|max|ultracode)\s+effort/gi
      const matches = [...paneText.matchAll(header)]
      const latest = matches[matches.length - 1]
      if (latest) {
        state.model = `claude-${latest[1].toLowerCase()}-${latest[2].replace(/\./g, '-')}${latest[3] ? '[1m]' : ''}`
        state.effort = latest[4].toLowerCase()
        state.observedAt = Date.now()
      }
      const footer = paneText.split('\n').slice(-8).join('\n')
      if (/─+\s*ultracode\s*─+/i.test(footer)) {
        state.effort = 'ultracode'
        state.observedAt = Date.now()
      }
      if (/\bplan mode on\b/i.test(currentUi)) state.mode = 'plan'
      else if (/\b(?:auto|default) mode on\b/i.test(currentUi)) state.mode = 'default'
    }
    const after = this.selectedModel(session)
    this.wake(session.sessionId)
    if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) this.scheduleChanged(session.sessionId)
    return before !== after
  }

  getState(sessionId: string): RuntimeState {
    return { ...this.state(sessionId) }
  }

  async withoutChangeEvents<T>(operation: () => Promise<T>): Promise<T> {
    this.suppressNotifications++
    try { return await operation() } finally { this.suppressNotifications-- }
  }

  selectedModel(session: RegisteredSession): string | null {
    const state = this.states.get(session.sessionId)
    if (!state?.model) return null
    const model = session.engine === 'claude' ? claudeAliasForModel(state.model) ?? state.model : state.model
    const effort = state.effort ?? (session.engine === 'claude' && claudeEfforts(model).length === 0 ? 'auto' : null)
    if (!effort) return null
    return encodeRuntimeProfile({
      sessionId: session.agentId,
      engine: session.engine,
      model,
      effort,
    })
  }

  beginControl(session: RegisteredSession, target: RuntimeProfile): boolean {
    if (this.controls.has(session.sessionId)) return false
    const before = this.selectedModel(session)
    const current = parseRuntimeProfile(before)
    this.controls.set(session.sessionId, {
      target,
      before,
      modelConfirmed: current?.model === target.model,
      effortConfirmed: current?.effort === target.effort,
    })
    return true
  }

  cancelControl(sessionId: string): void {
    const control = this.controls.get(sessionId)
    this.controls.delete(sessionId)
    this.wake(sessionId)
    if (control) this.scheduleChanged(sessionId)
  }

  finishControl(session: RegisteredSession): void {
    const control = this.controls.get(session.sessionId)
    this.controls.delete(session.sessionId)
    this.wake(session.sessionId)
    this.scheduleChanged(session.sessionId)
  }

  confirmEffort(sessionId: string, effort: string): void {
    if (!EFFORTS.has(effort)) return
    const state = this.state(sessionId)
    state.effort = effort
    state.observedAt = Date.now()
    const control = this.controls.get(sessionId)
    if (control) control.effortConfirmed = control.target.effort === effort
    this.wake(sessionId)
  }

  confirmControlProfile(target: RuntimeProfile): void {
    const state = this.state(target.sessionId)
    state.model = target.model
    state.effort = target.effort
    state.observedAt = Date.now()
    const control = this.controls.get(target.sessionId)
    if (control?.target.id === target.id) {
      control.modelConfirmed = true
      control.effortConfirmed = true
    }
    this.wake(target.sessionId)
  }

  waitForModel(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.waitFor(sessionId, () => this.controls.get(sessionId)?.modelConfirmed === true, timeoutMs)
  }

  waitForProfile(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.waitFor(sessionId, () => {
      const control = this.controls.get(sessionId)
      return control?.modelConfirmed === true && control.effortConfirmed === true
    }, timeoutMs)
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId)
    this.controls.delete(sessionId)
    const timer = this.changeTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.changeTimers.delete(sessionId)
    this.cursorTargets.delete(sessionId)
    for (const waiter of this.waiters.get(sessionId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.waiters.delete(sessionId)
  }

  async modelsForSessions(sessions: RegisteredSession[]): Promise<RuntimeModelOption[]> {
    const groups = await Promise.all(sessions.map((session) => this.modelsForSession(session)))
    return groups.flat()
  }

  /**
   * Only Claude and Codex can be SWITCHED from the device (owner, 2026-07-31). Every other engine is
   * view-only: its chip still names the model and effort it is running — that comes from the ingest paths,
   * not from here — but it offers nothing to pick.
   *
   * An empty catalogue is the whole mechanism: the device's picker returns to the projects screen when the
   * list comes back empty, so this policy lives in one place and needs no firmware change to revise.
   * The per-engine builders (cursor/opencode/pi/hermes/commandcode/devin) are kept, unused by this path,
   * because the catalogues they fetch are what the ingest paths resolve pane footers against.
   */
  async modelsForSession(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    // Display-only through a gateway: the empty catalogue IS the mechanism (see the note above), so web
    // renders a static chip and the device picker closes instead of offering a list we cannot enumerate.
    if (session.gateway) return []
    if (session.engine === 'codex') return this.codexModels(session)
    if (session.engine === 'claude') return this.claudeModels(session)
    return []
  }

  cursorTarget(sessionId: string, profileId: string): CursorModelTarget | null {
    return this.cursorTargets.get(sessionId)?.get(profileId) ?? null
  }

  /** The `/model` argument for a devin profile id — devin's ids do not follow from the model key. */
  devinTarget(sessionId: string, profileId: string): DevinModelTarget | null {
    return this.devinTargets.get(sessionId)?.get(profileId) ?? null
  }

  /** Mark an in-flight control confirmed once the pane shows the profile it asked for. */
  private confirmObserved(sessionId: string, model: string, effort: string): void {
    const control = this.controls.get(sessionId)
    if (!control || control.target.model !== model || control.target.effort !== effort) return
    control.modelConfirmed = true
    control.effortConfirmed = true
  }

  /** Resolve devin's footer display name (`SWE-1.6 Slow`) back to the catalog row it names. */
  private devinModelKeyForLabel(sessionId: string, label: string): DevinModelTarget | null {
    // Resolve against the CATALOG, not the per-session id map. That map is only built when something opens
    // the model picker, so a session nobody had picked on could not read its own footer and the chip stayed
    // blank. The catalog is the same data minus the per-session ids, and ingestConfig warms it on attach.
    // The session map stays first: its rows are the ones the picker will offer.
    const targets = this.devinTargets.get(sessionId)
    const pool: Iterable<DevinModelTarget> = targets?.size
      ? targets.values()
      : this.devinCatalogCache?.entries ?? []
    const wanted = label.trim().toLowerCase()
    for (const target of pool) {
      // A row whose id carries no effort keeps the effort word in its label ("GLM-5.2 High"), so an exact
      // label match is what identifies it; anything looser would tie the footer to the wrong sibling.
      if (target.label.toLowerCase() === wanted) return target
      if (target.effort !== 'auto' && `${target.label} ${effortLabel(target.effort)}`.toLowerCase() === wanted) {
        return target
      }
    }
    return null
  }

  private state(sessionId: string): RuntimeState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = { model: null, effort: null, mode: 'unknown', cliVersion: null, observedAt: null }
      this.states.set(sessionId, state)
    }
    return state
  }

  private ingestCodex(session: RegisteredSession, raw: Record<string, unknown>): void {
    const state = this.state(session.sessionId)
    const payload = record(raw.payload)
    const cliVersion = raw.type === 'session_meta' ? text(payload?.cli_version) : ''
    if (parseVersion(cliVersion)) {
      session.cliVersion = cliVersion
      state.cliVersion = cliVersion
    }
    let source: Record<string, unknown> | null = null
    if (raw.type === 'event_msg' && payload?.type === 'thread_settings_applied') source = record(payload.thread_settings)
    else if (raw.type === 'turn_context') source = payload
    if (!source) return
    const model = text(source.model)
    const effort = text(source.reasoning_effort) || text(source.effort)
    const collaboration = record(source.collaboration_mode)
    const mode = text(collaboration?.mode)
    if (model) state.model = model
    if (CODEX_EFFORTS.has(effort.toLowerCase())) state.effort = effort.toLowerCase()
    if (mode === 'plan' || mode === 'default') state.mode = mode
    if (model || effort || mode) state.observedAt = Date.now()
    const control = this.controls.get(session.sessionId)
    if (control && state.model === control.target.model) {
      control.modelConfirmed = true
      if (control.target.effort === 'auto' || state.effort === control.target.effort) control.effortConfirmed = true
    }
  }

  private ingestCursor(session: RegisteredSession, raw: Record<string, unknown>): void {
    const state = this.state(session.sessionId)
    const version = text(raw.version) || text(raw.cursor_version)
    if (version) {
      session.cliVersion = version
      state.cliVersion = version
    }
    const model = text(raw.model)
    if (model) {
      state.model = model
      // Default the effort to 'auto' when we do not have one yet. selectedModel() returns null unless BOTH
      // axes are known, so without this a Cursor session whose model we DO know shows nothing at all on
      // the device — the model is thrown away because the effort is missing.
      //
      // Cursor reports its model in the transcript but its reasoning level only in the pane footer, so
      // the effort arrives later (ingestPane) or not at all for a model that has no reasoning levels.
      // 'auto' is not a guess about Cursor's behaviour: it is exactly how the device renders "not
      // specified", and the pane path overwrites it with the real value the moment one is read.
      state.effort ??= 'auto'
      state.observedAt = Date.now()
    }
  }

  private ingestClaude(session: RegisteredSession, raw: Record<string, unknown>): void {
    const state = this.state(session.sessionId)
    const cliVersion = text(raw.version)
    if (parseVersion(cliVersion)) {
      session.cliVersion = cliVersion
      state.cliVersion = cliVersion
    }
    const message = record(raw.message)
    const assistantModel = raw.type === 'assistant' ? text(message?.model) : ''
    if (assistantModel) {
      state.model = assistantModel
      state.observedAt = Date.now()
    }
    const content = `${flattenContent(message?.content)}\n${flattenContent(raw.content)}`
    const control = this.controls.get(session.sessionId)
    const modelMatch = /Set model to\s+(.+?)(?:\n|$)/i.exec(content)
    if (modelMatch) {
      const nextModel = control?.target.model ?? normalizeClaudeDisplay(modelMatch[1]) ?? state.model
      state.model = nextModel
      if (!control && nextModel && state.effort && !claudeEfforts(nextModel, session.cliVersion).includes(state.effort)) {
        state.effort = 'auto'
      }
      state.observedAt = Date.now()
      if (control) control.modelConfirmed = true
    }
    const effortMatch = /Set effort level to\s+(low|medium|high|xhigh|max|ultracode)/i.exec(content)
    const effortAuto = confirmsClaudeAutoEffort(content)
    if (effortMatch || effortAuto) {
      state.effort = effortMatch?.[1].toLowerCase() ?? 'auto'
      state.observedAt = Date.now()
      if (control) control.effortConfirmed = control.target.effort === 'auto' || state.effort === control.target.effort
    }
  }

  private ingestGrok(session: RegisteredSession, raw: Record<string, unknown>): void {
    const params = record(raw.params)
    const update = record(params?.update)
    const meta = record(update?._meta)
    const model = text(meta?.modelId)
    if (!model) return
    const state = this.state(session.sessionId)
    state.model = model
    state.observedAt = Date.now()
  }

  private async claudeModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    const allowed = await claudeAvailableModels(session)
    for (const model of CLAUDE_ALIASES) {
      if (model === 'fable' && !versionAtLeast(session.cliVersion, [2, 1, 170])) continue
      if (!availableModelMatches(model, allowed)) continue
      addOption(output, seen, session, model, 'auto')
      for (const effort of claudeEfforts(model, session.cliVersion)) addOption(output, seen, session, model, effort)
    }
    const state = this.states.get(session.sessionId)
    if (state?.model) {
      const model = claudeAliasForModel(state.model) ?? state.model
      addOption(output, seen, session, model, 'auto')
      for (const effort of claudeEfforts(model, session.cliVersion)) addOption(output, seen, session, model, effort)
      if (state.effort) addOption(output, seen, session, model, state.effort)
    }
    return output
  }

  private async codexModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    let cache: CodexCache = {}
    try { cache = JSON.parse(await readFile(join(env.CODEX_HOME, 'models_cache.json'), 'utf8')) as CodexCache } catch { /* current state fallback below */ }
    for (const item of Array.isArray(cache.models) ? cache.models : []) {
      const model = text(item.slug)
      if (!model || item.visibility === 'hide') continue
      const label = text(item.display_name) || runtimeModelLabel(model)
      addOption(output, seen, session, model, 'auto', label)
      for (const level of Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : []) {
        const effort = text(level.effort).toLowerCase()
        if (CODEX_EFFORTS.has(effort) && effort !== 'auto' && codexEffortAllowed(model, effort)) {
          addOption(output, seen, session, model, effort, label)
        }
      }
    }
    const state = this.states.get(session.sessionId)
    if (state?.model) {
      addOption(output, seen, session, state.model, 'auto')
      if (state.effort && codexEffortAllowed(state.model, state.effort)) {
        addOption(output, seen, session, state.model, state.effort)
      }
    }
    return output
  }

  /** Command Code stamps the model on every assistant line as the full gateway id
   *  ("deepseek/deepseek-v4-flash"). Store the short name so it matches the catalogue and the chip label.
   *  `raw.version` here is the transcript SCHEMA version (3), not a CLI version — never read it as one. */
  private ingestCommandcode(session: RegisteredSession, raw: Record<string, unknown>): void {
    const model = text(raw.model)
    if (!model) return
    const state = this.state(session.sessionId)
    state.model = shortCommandcodeModel(model)
    // Effort is NOT touched here: it comes from the CLI config (ingestConfig), and stamping 'auto' on every
    // assistant line would wipe a configured level a second after it was read.
    state.observedAt = Date.now()
  }

  private async cursorModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const key = `${session.cliVersion ?? 'unknown'}\0${process.env.HOME ?? ''}`
    let entries = this.cursorCatalogCache?.key === key && this.cursorCatalogCache.expiresAt > Date.now()
      ? this.cursorCatalogCache.entries
      : null
    if (!entries) {
      try {
        const result = await execFileAsync('agent', ['models'], {
          env: process.env,
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        })
        entries = parseCursorModelsOutput(result.stdout)
        this.cursorCatalogCache = { key, entries, expiresAt: Date.now() + CURSOR_CATALOG_TTL_MS }
      } catch (err) {
        console.warn('[runtime-profile] Cursor model catalog failed:', err instanceof Error ? err.message : err)
        entries = []
      }
    }

    const output: RuntimeModelOption[] = []
    const previousTargets = this.cursorTargets.get(session.sessionId) ?? new Map<string, CursorModelTarget>()
    const targets = new Map<string, CursorModelTarget>()
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!CURSOR_EFFORTS.has(entry.effort)) continue
      const id = encodeRuntimeProfile({
        sessionId: session.agentId,
        engine: 'cursor',
        model: entry.target.modelKey,
        effort: entry.effort,
      })
      if (seen.has(id)) continue
      seen.add(id)
      targets.set(id, entry.target)
      output.push({ id, displayName: `${entry.modelLabel} / ${effortLabel(entry.effort)}` })
    }
    const state = this.states.get(session.sessionId)
    const current = state?.model && state.effort
      ? encodeRuntimeProfile({
          sessionId: session.agentId,
          engine: 'cursor',
          model: state.model,
          effort: state.effort,
        })
      : null
    const observed = current ? previousTargets.get(current) : null
    if (observed) {
      const familyEfforts = [...new Set(entries
        .filter((entry) => entry.target.familyLabel.toLowerCase() === observed.familyLabel.toLowerCase())
        .map((entry) => entry.effort)
        .filter((effort) => effort !== 'auto'))]
      const efforts = familyEfforts.length ? familyEfforts : [state!.effort!]
      for (const effort of efforts) {
        const id = encodeRuntimeProfile({
          sessionId: session.agentId,
          engine: 'cursor',
          model: observed.modelKey,
          effort,
        })
        if (seen.has(id)) continue
        seen.add(id)
        targets.set(id, { ...observed, reasoning: effort, footerEffort: effort })
        const label = [
          observed.familyLabel,
          observed.context ? `(${observed.context.toUpperCase()})` : '',
          observed.thinking ? 'Thinking' : '',
          observed.fast ? 'Fast' : '',
        ].filter(Boolean).join(' ')
        output.push({ id, displayName: `${label} / ${effortLabel(effort)}` })
      }
    }
    this.cursorTargets.set(session.sessionId, targets)
    return output
  }

  /**
   * Devin's catalog comes from `devin models list` on stdout — no picker to scrape. It is big (166 rows
   * across 72 models on this account), so it is trimmed to CATALOG_LIMIT, and the model the session is
   * ACTUALLY running is pinned to the front so trimming can never hide it.
   */
  private async devinModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.devinCatalog()
    const targets = new Map<string, DevinModelTarget>()
    const state = this.states.get(session.sessionId)
    // Keep every row of the running model together with it, so its effort list stays complete.
    const ordered = state?.model
      ? [...entries].sort((a, b) => Number(b.modelKey === state.model) - Number(a.modelKey === state.model))
      : entries

    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of ordered) {
      if (output.length >= CATALOG_LIMIT) break
      if (!DEVIN_EFFORTS.has(entry.effort)) continue
      const id = encodeRuntimeProfile({
        sessionId: session.agentId,
        engine: 'devin',
        model: entry.modelKey,
        effort: entry.effort,
      })
      if (seen.has(id)) continue
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: `${entry.label} / ${effortLabel(entry.effort)}` })
    }
    this.devinTargets.set(session.sessionId, targets)
    return output
  }

  private async devinCatalog(): Promise<DevinModelTarget[]> {
    const key = env.DEVIN_HOME
    if (this.devinCatalogCache?.key === key && this.devinCatalogCache.expiresAt > Date.now()) {
      return this.devinCatalogCache.entries
    }
    let entries: DevinModelTarget[] = []
    try {
      const result = await execFileAsync('devin', ['models', 'list'], {
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
      entries = parseDevinModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Devin model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.devinCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  /**
   * Pi lists models on stdout too, and its `thinking` column says which of them accept a reasoning depth —
   * so effort rows are attached per model instead of assumed. A model that is configured but absent from
   * the table (the state fallback) still gets its own row so the chip never goes blank.
   */
  private async piModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.piCatalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      addOption(output, seen, session, entry.model, 'auto', entry.model)
      if (!entry.thinking) continue
      for (const level of PI_THINKING_LEVELS) addOption(output, seen, session, entry.model, level, entry.model)
    }
    const state = this.states.get(session.sessionId)
    if (entries.length && state?.model) {
      addOption(output, seen, session, state.model, 'auto', state.model)
      if (state.effort && PI_EFFORTS.has(state.effort)) {
        addOption(output, seen, session, state.model, state.effort, state.model)
      }
    }
    return output
  }

  /** The picker page + row a hermes profile id points at. */
  hermesTarget(sessionId: string, profileId: string): HermesModelTarget | null {
    return this.hermesTargets.get(sessionId)?.get(profileId) ?? null
  }

  /**
   * Hermes offers MODELS only. Its reasoning effort lives in `agent.reasoning_effort` in config.yaml with
   * no in-session command to change it (`/config` only prints), and a running session does not re-read the
   * file — so an effort row would be a control that silently does nothing. The level is still OBSERVED, so
   * the chip names it truthfully; it just cannot be picked.
   */
  private async hermesModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.hermesCatalog()
    const state = this.states.get(session.sessionId)
    const targets = new Map<string, HermesModelTarget>()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    const effort = state?.effort && HERMES_EFFORTS.has(state.effort) ? state.effort : 'auto'
    const add = (entry: HermesModelTarget): void => {
      const short = entry.id.slice(entry.id.lastIndexOf('/') + 1)
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'hermes', model: short, effort,
      })
      if (seen.has(id)) return
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: runtimeModelLabel(short) })
    }
    for (const entry of entries) add(entry)
    // The provider in use is often absent from the picker cache (a `custom` gateway is its own one-model
    // page), so the configured model is always offered — otherwise the running model is missing from its
    // own list.
    if (state?.model && !seen.size) add({ id: state.model, provider: '' })
    else if (state?.model && ![...targets.values()].some((t) => t.id.endsWith(state.model!))) {
      add({ id: state.model, provider: '' })
    }
    this.hermesTargets.set(session.sessionId, targets)
    return output
  }

  private async hermesCatalog(): Promise<HermesModelTarget[]> {
    const key = env.HERMES_HOME
    if (this.hermesCatalogCache?.key === key && this.hermesCatalogCache.expiresAt > Date.now()) {
      return this.hermesCatalogCache.entries
    }
    const cache = await readJson(join(env.HERMES_HOME, 'provider_models_cache.json'))
    const entries = parseHermesModelsCache(cache)
    this.hermesCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  /** The full `/model` argument for a Command Code profile id — the profile itself holds the short name. */
  commandcodeTarget(sessionId: string, profileId: string): CommandcodeModelTarget | null {
    return this.commandcodeTargets.get(sessionId)?.get(profileId) ?? null
  }

  /**
   * Command Code's catalog comes from `--list-models`. Effort rows are attached to every model because the
   * CLI does not publish which models take one; an unsupported pick is refused in words at apply time
   * (see COMMANDCODE_EFFORT_LEVELS).
   */
  private async commandcodeModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.commandcodeCatalog()
    const targets = new Map<string, CommandcodeModelTarget>()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    const add = (entry: CommandcodeModelTarget, effort: string): void => {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'commandcode', model: entry.shortId, effort,
      })
      if (seen.has(id)) return
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: `${runtimeModelLabel(entry.shortId)} / ${effortLabel(effort)}` })
    }
    for (const entry of entries) {
      add(entry, 'auto')
      for (const level of COMMANDCODE_EFFORT_LEVELS) add(entry, level)
    }
    const state = this.states.get(session.sessionId)
    // `entries.length` guards the fallback: a model row is worth adding when the catalogue is readable but
    // does not list what the session runs (a pinned build, a just-removed model). When the catalogue could
    // not be read at all, one lone row is a picker that cannot pick anything — better to offer none.
    if (entries.length && state?.model && !entries.some((entry) => entry.shortId === state.model)) {
      const own: CommandcodeModelTarget = { id: state.model, shortId: state.model, section: '', isDefault: false }
      add(own, 'auto')
      if (state.effort && COMMANDCODE_EFFORTS.has(state.effort)) add(own, state.effort)
    }
    this.commandcodeTargets.set(session.sessionId, targets)
    return output
  }

  private async commandcodeCatalog(): Promise<CommandcodeModelTarget[]> {
    const key = env.COMMANDCODE_HOME
    if (this.commandcodeCatalogCache?.key === key && this.commandcodeCatalogCache.expiresAt > Date.now()) {
      return this.commandcodeCatalogCache.entries
    }
    let entries: CommandcodeModelTarget[] = []
    try {
      const result = await execFileAsync('commandcode', ['--list-models'], {
        env: process.env, timeout: 15_000, maxBuffer: 1024 * 1024,
      })
      entries = parseCommandcodeModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Command Code model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.commandcodeCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  /** OpenCode has no effort axis, so every model is one `auto` row and the label carries no effort. */
  private async opencodeModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.opencodeCatalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'opencode', model: entry.id, effort: 'auto',
      })
      if (seen.has(id)) continue
      seen.add(id)
      output.push({ id, displayName: entry.id })
    }
    const state = this.states.get(session.sessionId)
    // See commandcodeModels: only worth a row when the catalogue itself came back.
    if (entries.length && state?.model && !entries.some((entry) => entry.id === state.model)) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'opencode', model: state.model, effort: 'auto',
      })
      if (!seen.has(id)) output.push({ id, displayName: state.model })
    }
    return output
  }

  async opencodeCatalog(): Promise<OpencodeModelTarget[]> {
    const key = env.OPENCODE_DATA_DIR
    if (this.opencodeCatalogCache?.key === key && this.opencodeCatalogCache.expiresAt > Date.now()) {
      return this.opencodeCatalogCache.entries
    }
    let entries: OpencodeModelTarget[] = []
    try {
      const result = await execFileAsync(opencodeBin(), ['models'], {
        env: process.env, timeout: 10_000, maxBuffer: 1024 * 1024,
      })
      entries = parseOpencodeModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] OpenCode model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.opencodeCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  /** Kilo has no effort axis either, so every model is one `auto` row. */
  private async kiloModels(session: RegisteredSession): Promise<RuntimeModelOption[]> {
    const entries = await this.kiloCatalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'kilo', model: entry.id, effort: 'auto',
      })
      if (seen.has(id)) continue
      seen.add(id)
      output.push({ id, displayName: entry.id })
    }
    return output
  }

  async kiloCatalog(): Promise<KiloModelTarget[]> {
    const key = env.KILO_DATA_DIR
    if (this.kiloCatalogCache?.key === key && this.kiloCatalogCache.expiresAt > Date.now()) {
      return this.kiloCatalogCache.entries
    }
    let entries: KiloModelTarget[] = []
    try {
      // Measured: `kilo models` answers WITHOUT the user being logged in (unlike `kilo profile`), and
      // prints 299 ids on this machine — so an empty catalog here means the binary is missing, not that
      // the account is signed out.
      const result = await execFileAsync(env.KILO_PATH || 'kilo', ['models'], {
        env: process.env, timeout: 10_000, maxBuffer: 1024 * 1024,
      })
      entries = parseKiloModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Kilo model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.kiloCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  private async piCatalog(): Promise<ReturnType<typeof parsePiModelsOutput>> {
    const key = env.PI_HOME
    if (this.piCatalogCache?.key === key && this.piCatalogCache.expiresAt > Date.now()) {
      return this.piCatalogCache.entries
    }
    let entries: ReturnType<typeof parsePiModelsOutput> = []
    try {
      const result = await execFileAsync('pi', ['--list-models'], {
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
      entries = parsePiModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Pi model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.piCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  private scheduleChanged(sessionId: string): void {
    const previous = this.changeTimers.get(sessionId)
    if (previous) clearTimeout(previous)
    this.changeTimers.set(sessionId, setTimeout(() => {
      this.changeTimers.delete(sessionId)
      if (!this.controls.has(sessionId)) this.onChanged?.(sessionId)
    }, CHANGE_DEBOUNCE_MS))
  }

  private waitFor(sessionId: string, check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: StateWaiter = {
        check,
        resolve,
        timer: setTimeout(() => {
          this.waiters.get(sessionId)?.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      const set = this.waiters.get(sessionId) ?? new Set<StateWaiter>()
      set.add(waiter)
      this.waiters.set(sessionId, set)
    })
  }

  private wake(sessionId: string): void {
    const set = this.waiters.get(sessionId)
    if (!set) return
    for (const waiter of [...set]) {
      if (!waiter.check()) continue
      clearTimeout(waiter.timer)
      set.delete(waiter)
      waiter.resolve(true)
    }
    if (set.size === 0) this.waiters.delete(sessionId)
  }
}
