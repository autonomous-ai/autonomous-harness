import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const REAL_PATH = process.env.PATH
const REAL_HOME = process.env.HOME
const REAL_SHELL = process.env.SHELL

afterEach(() => {
  process.env.PATH = REAL_PATH
  if (REAL_HOME) process.env.HOME = REAL_HOME
  if (REAL_SHELL) process.env.SHELL = REAL_SHELL; else delete process.env.SHELL
  vi.resetModules()
})

function fakeHomeWithOpencode(): string {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
  const bin = join(home, '.opencode', 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'opencode')
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return home
}

describe('opencodeBin', () => {
  it('finds the install when PATH does not have it', async () => {
    // The daemon is started by the desktop app, so it gets the GUI's PATH — no shell profile, and
    // therefore not the ~/.opencode/bin entry OpenCode's installer appends there. Every recap spun
    // on `spawn opencode ENOENT` while the same command worked fine from a terminal.
    const home = fakeHomeWithOpencode()
    process.env.HOME = home
    process.env.PATH = '/usr/bin:/bin'

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe(join(home, '.opencode', 'bin', 'opencode'))
  })

  it('leaves a PATH install alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-empty-'))
    const dir = mkdtempSync(join(tmpdir(), 'oc-path-'))
    const file = join(dir, 'opencode')
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
    process.env.HOME = home
    process.env.PATH = `${dir}:/usr/bin`

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe('opencode')
  })

  it('returns an absolute path for an install only the login shell can see', async () => {
    // THE CASE THAT DEFEATED THE FALLBACK ABOVE. The resolver also searches the
    // interactive shell's PATH, and a child inherits only this process's — so a
    // hit there used to come back as the bare name and die on `spawn ENOENT`,
    // without the ~/.opencode fallback ever being reached. Measured on a live
    // daemon: 44 entries in the process PATH, 48 in the interactive one.
    const home = mkdtempSync(join(tmpdir(), 'oc-empty-'));
    const shellOnly = mkdtempSync(join(tmpdir(), 'oc-shell-'));
    const file = join(shellOnly, 'opencode');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);

    // A shell that answers the resolver's probe with a PATH this process lacks.
    const fakeShell = join(mkdtempSync(join(tmpdir(), 'oc-sh-')), 'shell');
    writeFileSync(
      fakeShell,
      `#!/bin/sh\nprintf '\\n__HARNESS_ENGINE_PATH__=%s\\n' "${shellOnly}"\n`,
    );
    chmodSync(fakeShell, 0o755);

    process.env.HOME = home;
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = fakeShell;
    const realNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;   // the interactive probe is skipped under test
    try {
      const { opencodeBin } = await import('./engineBin.js');
      expect(opencodeBin()).toBe(file);
    } finally {
      if (realNodeEnv !== undefined) process.env.NODE_ENV = realNodeEnv;
    }
  });

  it('still says `opencode` when nothing is installed, so the error is the usual one', async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'oc-none-'))
    process.env.PATH = '/nonexistent'

    const { opencodeBin } = await import('./engineBin.js')
    expect(opencodeBin()).toBe('opencode')
  })
})
