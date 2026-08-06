/**
 * Point every test's data dir at a throwaway directory BEFORE any module reads `env`.
 *
 * `config/env.ts` resolves `ADAPTER_DATA_DIR` at import time and defaults to the user's real
 * `~/.harness/cli/data`. Specs that import the hook server (and through it the registry) therefore wrote
 * their fixtures into the LIVE registry — a stale `late-session` record turned up there, written by
 * `launcherWs.spec.ts`, which is how this was found. Tests must never touch the user's data.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adapter-test-data-'))
