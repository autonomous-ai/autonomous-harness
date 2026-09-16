/**
 * `harness dsh …` — the terminal face of domain-specific harnesses, for a server with no desktop
 * and for the development loop (`--link` a checkout, iterate, no re-clone).
 */
import { listDshState, installedDsh } from './installed.js'
import { dshTier } from './manifest.js'
import { bundledDshRegistry } from './registry.js'
import { installDsh, removeDsh, resolveInstallSource, runDshDoctor } from './install.js'
import { checkDsh, formatCheck } from './check.js'

export function dshUsage(): string {
  return `Domain-specific harnesses (a DSH turns Harness into a product for one domain — see dsh/README.md):
  harness dsh list                 what is installed on this computer, and what the registry offers
  harness dsh install <id|url|path> [--ref <ref>] [--link]
                                   install by registry id (autonomous/copper), git URL, or local path;
                                   --link symlinks a local checkout instead of cloning it
  harness dsh doctor <id>          re-run the harness's own readiness check
  harness dsh remove <id>          uninstall (a --link install removes only the link)
  harness dsh check <path>         conformance check for a harness checkout (what the registry runs)`
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

/** `verb` is the word after `dsh`; `rest` is everything after THAT, flags included. */
export async function dshCommand(verb: string | undefined, rest: readonly string[]): Promise<number> {
  const args = rest.filter((arg) => !arg.startsWith('-'))
  switch (verb) {
    case 'list': {
      const { installed, broken } = listDshState()
      const registry = bundledDshRegistry()
      const seen = new Set<string>()
      const rows: string[] = []
      for (const dsh of installed) {
        seen.add(dsh.id)
        rows.push(`  ${dsh.id.padEnd(28)} ${dsh.manifest.name.padEnd(12)} ${(dsh.manifest.kind === 'viewer' ? 'viewer' : `on ${dsh.manifest.engine}`).padEnd(11)} tier ${dshTier(dsh.manifest)}  installed${dsh.linked ? ' (linked)' : ''} · ${dsh.dir}`)
      }
      for (const row of broken) {
        seen.add(row.id)
        rows.push(`  ${row.id.padEnd(28)} ${'?'.padEnd(12)} ${''.padEnd(11)} ${''.padEnd(6)}  BROKEN · ${row.error}`)
      }
      for (const entry of registry) {
        if (seen.has(entry.id)) continue
        rows.push(`  ${entry.id.padEnd(28)} ${entry.name.padEnd(12)} ${(entry.kind === 'viewer' ? 'viewer' : `on ${entry.engine}`).padEnd(11)} tier ${entry.tier ?? '?'}  available · ${entry.repo}`)
      }
      console.log(rows.length ? rows.join('\n') : '  (nothing installed, registry empty)')
      return 0
    }
    case 'install': {
      const target = args[0]
      if (!target) { console.error(dshUsage()); return 1 }
      const resolved = resolveInstallSource(target)
      if (!resolved) { console.error(`harness dsh install: ${target} is not an id, URL or path`); return 1 }
      const link = rest.includes('--link')
      const ref = flagValue(rest, '--ref') ?? resolved.ref
      const result = await installDsh({
        source: resolved.source,
        ref: link ? undefined : ref,
        link,
        onProgress: (p) => console.log(`[dsh] ${p.id ?? target} · ${p.phase}${p.detail ? ` · ${p.detail}` : ''}`),
        onLine: (line) => console.log(`    ${line}`),
      })
      if (!result.ok) { console.error(`harness dsh install failed · ${result.error} · ${result.detail}`); return 1 }
      console.log(`Installed ${result.installed.id} (${result.installed.manifest.name}, ${result.installed.manifest.kind === 'viewer' ? 'a viewer package' : `runs on ${result.installed.manifest.engine}`}) at ${result.installed.dir}`)
      return 0
    }
    case 'doctor': {
      const id = args[0]
      const dsh = id ? installedDsh(id) : undefined
      if (!dsh) { console.error(`harness dsh doctor: ${id ?? '<id>'} is not installed`); return 1 }
      const doctor = await runDshDoctor(dsh, (line) => console.log(`  ${line}`))
      console.log(doctor.ok ? `${dsh.id} is ready` : `${dsh.id} is not ready`)
      return doctor.ok ? 0 : 1
    }
    case 'check': {
      const target = args[0] ?? '.'
      const result = checkDsh(target)
      console.log(formatCheck(result))
      console.log(result.ok ? `${result.manifest?.id ?? target} conforms to spec 1` : `${result.manifest?.id ?? target} does not conform`)
      return result.ok ? 0 : 1
    }
    case 'remove': {
      const id = args[0]
      if (!id) { console.error(dshUsage()); return 1 }
      const result = removeDsh(id)
      if (!result.ok) { console.error(`harness dsh remove failed · ${result.error} · ${result.detail}`); return 1 }
      console.log(`Removed ${id}`)
      return 0
    }
    default:
      console.error(dshUsage())
      return verb === undefined || verb === 'help' ? 0 : 1
  }
}
