import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { hasSqliteCli, resetSqliteAvailabilityCache, sqlitePreflightMessage } from './sqliteAvailability.js'

const dirs: string[] = []
const realPath = process.env.PATH

afterEach(() => {
  process.env.PATH = realPath
  resetSqliteAvailabilityCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pathWith(executable: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-probe-'))
  dirs.push(dir)
  if (executable) {
    const bin = join(dir, 'sqlite3')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
  }
  return dir
}

describe('sqlite3 preflight', () => {
  it('stays silent when the CLI is on PATH', () => {
    process.env.PATH = pathWith(true)
    resetSqliteAvailabilityCache()
    expect(hasSqliteCli()).toBe(true)
    expect(sqlitePreflightMessage()).toBeNull()
  })

  // Ubuntu does not ship sqlite3 (measured on a stock ubuntu:24.04 image), so on Linux this is the
  // default state, not an exotic one. The line must name the affected engines AND the fix — a bare
  // "sqlite3 not found" leaves the user with four engines that mirror nothing and no idea why.
  it('names the affected engines and the fix when it is absent', () => {
    process.env.PATH = pathWith(false)
    resetSqliteAvailabilityCache()
    expect(hasSqliteCli()).toBe(false)
    const message = sqlitePreflightMessage()
    expect(message).toContain('sqlite3')
    for (const engine of ['opencode', 'kilo', 'hermes', 'devin']) expect(message).toContain(engine)
    expect(message).toMatch(/apt install sqlite3|on PATH/)
  })

  it('ignores a non-executable file of the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-probe-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'sqlite3'), 'not executable')
    chmodSync(join(dir, 'sqlite3'), 0o644)
    process.env.PATH = dir
    resetSqliteAvailabilityCache()
    expect(hasSqliteCli()).toBe(false)
  })

  it('tolerates empty entries in PATH', () => {
    process.env.PATH = `${delimiter}${pathWith(true)}${delimiter}`
    resetSqliteAvailabilityCache()
    expect(hasSqliteCli()).toBe(true)
  })
})
