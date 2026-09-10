/**
 * Codex profiles — CODEX_HOME folders this machine can point a Codex agent at.
 *
 * Runs entirely on whatever machine the CLI is on (see `backendSocket.ts`'s `codex_profiles_list`
 * and `codex_profile_link` cases), which is what makes this work for a remote machine: the desktop
 * app never touches a filesystem itself, it only renders what this reports. Ported from the Flutter
 * desktop app's `lib/core/codex_profiles.dart`, whose discovery half moved to `codexProfileDiscovery.ts`
 * and whose "linked" persistence moved from the app's own local storage (which could not mean
 * anything for a remote machine) to this machine's own state directory.
 */

import { closeSync, constants, fchmodSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'
import { discoverCodexProfiles } from './codexProfileDiscovery.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'

export interface CodexProfile {
  path: string
  label: string
}

export type CodexProfileError = { error: 'INVALID_PATH' | 'NOT_FOUND' }

const FILE = join(env.ADAPTER_DATA_DIR, 'codex-profiles.json')
const MAX_LINKED = 256
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

function labelFor(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function readLinkedPaths(): Set<string> {
  try {
    const raw = JSON.parse(readPrivateStateFile(FILE, 1024 * 1024)) as unknown
    if (Array.isArray(raw)) {
      return new Set(raw.filter((p): p is string => typeof p === 'string').slice(0, MAX_LINKED))
    }
  } catch {
    // Discovery still works when the optional saved list is unavailable/unreadable/malformed.
  }
  return new Set()
}

function atomicWriteJson(file: string, value: unknown): void {
  hardenPrivateStateFileIfPresent(file)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    renamed = true
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

function writeLinkedPaths(paths: Set<string>): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  atomicWriteJson(FILE, [...paths].slice(0, MAX_LINKED))
}

/** Validate + resolve a folder path the same way for both linking and re-checking a saved one. */
export function resolveCodexProfilePath(path: string): CodexProfile | CodexProfileError {
  if (!path.startsWith('/') || path.length > 4096 || CONTROL_CHARS_RE.test(path)) {
    return { error: 'INVALID_PATH' }
  }
  let st
  try {
    st = statSync(path)
  } catch {
    return { error: 'NOT_FOUND' }
  }
  if (!st.isDirectory()) return { error: 'NOT_FOUND' }
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch {
    return { error: 'NOT_FOUND' }
  }
  if (resolved.length > 4096 || CONTROL_CHARS_RE.test(resolved)) return { error: 'INVALID_PATH' }
  return { path: resolved, label: labelFor(resolved) }
}

/** Link a folder as a Codex profile, persisted on this machine so it survives future requests. */
export function linkCodexProfile(path: string): CodexProfile | CodexProfileError {
  const profile = resolveCodexProfilePath(path)
  if ('error' in profile) return profile
  const linked = readLinkedPaths()
  linked.add(profile.path)
  writeLinkedPaths(linked)
  return profile
}

function processEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value
  }
  return environment
}

/**
 * Every Codex profile this machine can offer: previously linked folders, `observedPaths` (Codex
 * homes the caller already knows about from this same machine's other Codex agents), and freshly
 * discovered folders. Never throws — a discovery scan that fails still returns the linked/observed
 * folders that resolved fine.
 */
export function listCodexProfiles(
  observedPaths: readonly string[] = [],
  /** Injectable for tests only; production always discovers this machine's own home/environment. */
  discoveryOptions: { home: string; environment: Record<string, string> } = {
    home: homedir(),
    environment: processEnvironment(),
  },
): CodexProfile[] {
  const candidates = new Set<string>([...readLinkedPaths(), ...observedPaths])
  try {
    for (const path of discoverCodexProfiles(discoveryOptions)) {
      candidates.add(path)
    }
  } catch {
    // A discovery failure must not hide linked/observed profiles that are still good.
  }
  const profiles = new Map<string, CodexProfile>()
  for (const path of candidates) {
    const resolved = resolveCodexProfilePath(path)
    // A vanished folder or a malformed persisted entry must not be offered as a working profile.
    if (!('error' in resolved)) profiles.set(resolved.path, resolved)
  }
  return [...profiles.values()].sort((a, b) => {
    const byLabel = a.label.toLowerCase().localeCompare(b.label.toLowerCase())
    return byLabel !== 0 ? byLabel : a.path.localeCompare(b.path)
  })
}
