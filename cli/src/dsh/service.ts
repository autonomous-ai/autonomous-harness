/** Shared daemon installation/update handler, including the progress sent to desktop clients. */
import { installDsh, resolveInstallSource } from './install.js'
import { updateDsh } from './update.js'
import { catalogEntry, refreshDshRegistry } from './catalog.js'

export const mutateDsh = async ({ id, url, ref, update }: { id?: string; url?: string; ref?: string; update?: boolean }, progress: (p: import('./install.js').DshInstallProgress) => void): Promise<{ ok: true; id: string } | { ok: false; error: string; detail: string }> => {
  const catalog = new Map((await refreshDshRegistry(update || (!!id && !catalogEntry(id)))).map(entry => [entry.id, entry]))
  if (!update && id && !catalog.has(id)) return { ok: false, error: 'INVALID_DSH', detail: `${id} is not in this machine's Store catalog` }
  const resolved = update ? { source: '' } : id ? resolveInstallSource(id) : url ? { source: url, ref } : null
  if (!resolved) return { ok: false, error: 'INVALID_DSH', detail: `${id ?? url} is not a known harness` }
  // NARRATE THE LINES, NOT ONLY THE PHASES. A toolchain setup is minutes of npm and uv output, and
  // a dialog that says "Setting up…" for all of it looks hung; the line the command is on is what
  // says it is alive and what it is doing. Throttled: a setup can print hundreds of lines a second
  // (`Updating files: 39%…` arrives as carriage returns on ONE line), and the window redraws on
  // each push. The doctor's own ok/miss/warn lines go out at once — they are the ones a person
  // reads, and there are seven of them.
  let last: import('./install.js').DshInstallProgress | null = null
  let pendingLine: string | null = null
  let timer: NodeJS.Timeout | null = null
  const flushLine = (): void => {
    timer = null
    if (last && pendingLine !== null && last.phase !== 'done' && last.phase !== 'failed') progress({ ...last, line: pendingLine })
    pendingLine = null
  }
  const options: import('./install.js').DshInstallOptions = {
    source: resolved.source,
    expectedId: id,
    registry: dependencyId => catalog.get(dependencyId),
    ref: ref ?? resolved.ref,
    path: 'path' in resolved ? resolved.path : undefined,
    onProgress: (p) => {
      if (timer) { clearTimeout(timer); timer = null }
      pendingLine = null
      last = p
      progress(p)
    },
    onLine: (raw) => {
      console.log(`[dsh] ${update ? 'update' : 'install'} · ${raw}`)
      // The last carriage-return segment is the line as a terminal would show it.
      const line = raw.split('\r').filter((s) => s.trim()).pop()?.trim() ?? ''
      if (!line) return
      pendingLine = line.slice(0, 200)
      if (/^(ok|miss|warn)\s/.test(line)) { if (timer) clearTimeout(timer); flushLine(); return }
      if (!timer) timer = setTimeout(flushLine, 300)
    },
  }
  try {
    const result = update ? await updateDsh({ ...options, id: id! }) : await installDsh(options)
    if (!result.ok) {
      console.warn(`[dsh] ${update ? 'update' : 'install'} of ${id ?? url} failed · ${result.error} · ${result.detail}`)
      return { ok: false, error: result.error, detail: result.detail }
    }
    console.log(`[dsh] ${update ? 'updated' : 'installed'} ${result.installed.id} at ${result.installed.dir}`)
    return { ok: true, id: result.installed.id }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
