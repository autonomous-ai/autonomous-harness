/**
 * Where an image paste's PNG bytes land on disk on THIS machine, and how long they stick around.
 *
 * A successful native-clipboard write (osClipboard.ts) only needs the file for the instant the OS
 * takes to ingest it — the OS clipboard owns the bytes after that. The file-path fallback (when no
 * native clipboard is reachable) is different: the path itself is what gets pasted into the pane,
 * so the file has to keep resolving after this call returns. Both cases share one directory so a
 * single prune sweep bounds both.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'

const PASTE_IMAGES_DIR = join(env.ADAPTER_DATA_DIR, 'paste-images')
const RETENTION_MS = 24 * 60 * 60 * 1000

/** Best-effort: a prune failure must never block an image paste that is otherwise fine. */
async function pruneStale(): Promise<void> {
  try {
    const now = Date.now()
    const entries = await readdir(PASTE_IMAGES_DIR)
    await Promise.all(entries.map(async (name) => {
      const path = join(PASTE_IMAGES_DIR, name)
      try {
        const info = await stat(path)
        if (now - info.mtimeMs > RETENTION_MS) await rm(path, { force: true })
      } catch { /* raced with something else touching the same file — ignore */ }
    }))
  } catch { /* directory not there yet, or unreadable — nothing to prune */ }
}

/** Writes `bytes` to a freshly named PNG file under the harness data dir, pruning anything older
 *  than a day from the same directory first, and returns its absolute path. */
export async function writePasteImageFile(bytes: Uint8Array): Promise<string> {
  await mkdir(PASTE_IMAGES_DIR, { recursive: true })
  await pruneStale()
  const path = join(PASTE_IMAGES_DIR, `${randomUUID()}.png`)
  await writeFile(path, bytes)
  return path
}
