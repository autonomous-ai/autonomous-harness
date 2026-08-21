import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { adoptComputerId, readOrMintComputerId } from './computerIdentity.js'

// The invariant under test is one sentence: a computer that already has an id must never get a new one.
// Every case below is a path that used to be able to break it — see the file's docstring for why that
// is a data-loss bug (the old machine is orphaned and a replacement is created) rather than a refresh.

let home = ''
const root = () => join(home, '.harness')
const canonical = () => join(root(), 'computer-id')
const dataDir = () => join(root(), 'cli', 'data')
const strayDataDir = () => join(home, '.machine', 'cli', 'data')

/** The adoption order env.ts uses, newest tree first. */
const legacyPaths = () => [
  join(dataDir(), 'computer-id'),
  join(dataDir(), 'machine-id'),
  join(strayDataDir(), 'computer-id'),
  join(strayDataDir(), 'machine-id'),
]

function seed(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, value + '\n')
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'computer-identity-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('readOrMintComputerId', () => {
  it('mints once, then returns the same value forever', () => {
    const first = readOrMintComputerId(canonical())
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(readOrMintComputerId(canonical())).toBe(first)
    expect(readOrMintComputerId(canonical())).toBe(first)
  })

  it('writes the file 0600 — it identifies this box to the backend', () => {
    readOrMintComputerId(canonical())
    expect(statSync(canonical()).mode & 0o777).toBe(0o600)
  })

  it('never overwrites an id already on disk', () => {
    seed(canonical(), 'an-existing-id')
    expect(readOrMintComputerId(canonical())).toBe('an-existing-id')
    expect(readFileSync(canonical(), 'utf-8').trim()).toBe('an-existing-id')
  })

  it('treats an empty or whitespace-only file as absent and mints into it', () => {
    seed(canonical(), '   ')
    const id = readOrMintComputerId(canonical())
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the pin wins but is never written, so unsetting it returns the file id', () => {
    seed(canonical(), 'file-id')
    expect(readOrMintComputerId(canonical(), 'pinned-id')).toBe('pinned-id')
    expect(readFileSync(canonical(), 'utf-8').trim()).toBe('file-id')
    expect(readOrMintComputerId(canonical())).toBe('file-id')
  })

  it('ignores a blank pin rather than treating it as an identity', () => {
    seed(canonical(), 'file-id')
    expect(readOrMintComputerId(canonical(), '   ')).toBe('file-id')
  })

  it('recovers from a blank file instead of bricking every command', () => {
    // A crashed or truncated write leaves the file present but empty, which fails the `wx` create AND
    // the re-read. Throwing there would take down `harness status` too; a blank file was never sent to
    // the backend, so there is no identity to protect.
    seed(canonical(), '')
    const id = readOrMintComputerId(canonical())
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(canonical(), 'utf-8').trim()).toBe(id)
    expect(readOrMintComputerId(canonical())).toBe(id)
  })
})

describe('adoptComputerId', () => {
  it('lifts an id out of the data dir instead of leaving it to be wiped', () => {
    seed(join(dataDir(), 'computer-id'), 'legacy-id')
    expect(adoptComputerId(canonical(), legacyPaths())).toBe(1)
    expect(readOrMintComputerId(canonical())).toBe('legacy-id')
  })

  it('adopts the pre-rename machine-id name', () => {
    seed(join(dataDir(), 'machine-id'), 'older-id')
    adoptComputerId(canonical(), legacyPaths())
    expect(readOrMintComputerId(canonical())).toBe('older-id')
  })

  it('adopts from the stray ~/.machine tree', () => {
    seed(join(strayDataDir(), 'computer-id'), 'stray-id')
    adoptComputerId(canonical(), legacyPaths())
    expect(readOrMintComputerId(canonical())).toBe('stray-id')
  })

  it('the newest tree wins and the stray one cannot replace it', () => {
    // This is the ~/.machine force-move bug: it used to rmSync the target and rename over it.
    seed(join(dataDir(), 'computer-id'), 'current-id')
    seed(join(strayDataDir(), 'computer-id'), 'stray-id')
    adoptComputerId(canonical(), legacyPaths())
    expect(readOrMintComputerId(canonical())).toBe('current-id')
  })

  it('never replaces an id already at the canonical path', () => {
    seed(canonical(), 'settled-id')
    seed(join(dataDir(), 'computer-id'), 'legacy-id')
    expect(adoptComputerId(canonical(), legacyPaths())).toBe(0)
    expect(readOrMintComputerId(canonical())).toBe('settled-id')
  })

  it('is a no-op on a fresh install and does not mint anything', () => {
    expect(adoptComputerId(canonical(), legacyPaths())).toBe(0)
    expect(() => readFileSync(canonical(), 'utf-8')).toThrow()
  })

  it('leaves no directory behind when there is nothing to adopt', () => {
    // Runs at import time on EVERY command, so a run with nothing to move must not create the tree.
    adoptComputerId(canonical(), legacyPaths())
    expect(existsSync(root())).toBe(false)
  })

  it('adopts from a custom data dir, which is how a non-default install keeps its identity', () => {
    // `migrateLegacyAdapterState` bails out early for a custom ADAPTER_DATA_DIR — the computer id is
    // deliberately lifted BEFORE that bail-out, because re-minting it is not a layout choice.
    const custom = join(home, 'custom-data')
    seed(join(custom, 'computer-id'), 'custom-dir-id')
    adoptComputerId(canonical(), [join(custom, 'computer-id'), ...legacyPaths()])
    expect(readOrMintComputerId(canonical())).toBe('custom-dir-id')
  })

  it('is idempotent — running it again after adopting changes nothing', () => {
    seed(join(dataDir(), 'computer-id'), 'legacy-id')
    adoptComputerId(canonical(), legacyPaths())
    adoptComputerId(canonical(), legacyPaths())
    expect(readOrMintComputerId(canonical())).toBe('legacy-id')
  })
})

describe('survives the commands that clear local state', () => {
  // `harness reset` clears the data dir; in the dataDir !== cliDir case it rmSyncs the whole tree.
  // The id sits ABOVE both, which is the entire reason it was moved out of there.
  it.each([
    ['data dir wiped', () => rmSync(dataDir(), { recursive: true, force: true })],
    ['cli tree wiped', () => rmSync(join(root(), 'cli'), { recursive: true, force: true })],
    ['stray tree wiped', () => rmSync(join(home, '.machine'), { recursive: true, force: true })],
  ])('%s', (_label, wipe) => {
    mkdirSync(dataDir(), { recursive: true })
    mkdirSync(strayDataDir(), { recursive: true })
    const id = readOrMintComputerId(canonical())
    wipe()
    expect(readOrMintComputerId(canonical())).toBe(id)
  })

  it('only deleting the product root itself makes this a new computer', () => {
    const id = readOrMintComputerId(canonical())
    rmSync(root(), { recursive: true, force: true })
    expect(readOrMintComputerId(canonical())).not.toBe(id)
  })
})
