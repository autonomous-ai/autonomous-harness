import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Base64 inside an E2EE JSON envelope stays below 256 KiB per reply. The client
// requests bounded chunks, so neither machine holds an entire video in memory.
export const MEDIA_PREVIEW_CHUNK_BYTES = 128 * 1024
export const MEDIA_PREVIEW_MAX_BYTES = 512 * 1024 * 1024

export class MediaPreviewError extends Error {
  constructor(code: string) { super(code); this.name = 'MediaPreviewError' }
}

const extensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heic', '.heif', '.bmp',
  '.tif', '.tiff', '.svg', '.ico', '.mp4', '.m4v', '.mov', '.webm', '.mkv',
  '.avi', '.mpeg', '.mpg', '.ogv', '.3gp',
])

function fail(code: string): never { throw new MediaPreviewError(code) }

/** A media-only variant of agent_read_file, not a relaxation of its text-file
 * guard. Absolute paths are intentional: agent artifacts often live in /tmp.
 * Relative paths stay under the selected agent's working folder; ~ and file://
 * are resolved on the machine that owns the file, never on the viewing machine. */
function resolveTarget(root: string, target: string): { path: string; relative: boolean } {
  if (!target || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target)) fail('MEDIA_INVALID_REQUEST')
  let path = target
  if (/^file:/i.test(path)) {
    try {
      const uri = new URL(path)
      if (uri.hostname && uri.hostname !== 'localhost') fail('MEDIA_INVALID_REQUEST')
      uri.search = ''; uri.hash = ''
      path = fileURLToPath(uri)
    } catch { fail('MEDIA_INVALID_REQUEST') }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    fail('MEDIA_INVALID_REQUEST')
  }
  if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2))
  if (!extensions.has(extname(path).toLowerCase())) fail('MEDIA_UNSUPPORTED')
  const relative = !isAbsolute(path)
  if (relative) {
    const base = resolve(root)
    path = resolve(base, path)
    if (!path.startsWith(base.endsWith(sep) ? base : base + sep)) fail('MEDIA_INVALID_REQUEST')
  }
  return { path, relative }
}

/** Check content as well as the suffix, so a renamed text/credential file does
 * not become a media download. Container checks are deliberately lightweight;
 * decoding/playback remains the OS viewer's job. */
function hasMediaHeader(bytes: Buffer, extension: string): boolean {
  const starts = (...signature: number[]) => bytes.subarray(0, signature.length).equals(Buffer.from(signature))
  const text = (start: number, end: number) => bytes.toString('ascii', start, end)
  switch (extension) {
    case '.png': return starts(137, 80, 78, 71, 13, 10, 26, 10)
    case '.jpg': case '.jpeg': return starts(255, 216, 255)
    case '.gif': return ['GIF87a', 'GIF89a'].includes(text(0, 6))
    case '.webp': return text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP'
    case '.bmp': return text(0, 2) === 'BM'
    case '.tif': case '.tiff': return starts(73, 73, 42, 0) || starts(77, 77, 0, 42)
    case '.ico': return starts(0, 0, 1, 0)
    case '.svg': {
      const xml = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart()
      return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/.test(xml)
    }
    case '.avi': return text(0, 4) === 'RIFF' && text(8, 12) === 'AVI '
    case '.webm': case '.mkv': return starts(26, 69, 223, 163)
    case '.ogv': return text(0, 4) === 'OggS'
    case '.mpg': case '.mpeg': return starts(0, 0, 1, 186) || starts(0, 0, 1, 179)
    case '.avif': case '.heic': case '.heif': {
      if (text(4, 8) !== 'ftyp') return false
      const brands = bytes.toString('ascii', 8, Math.min(bytes.length, 128))
      return extension === '.avif' ? /avif|avis/.test(brands) : /heic|heix|hevc|hevx|mif1|msf1/.test(brands)
    }
    case '.mp4': case '.m4v': case '.3gp': return text(4, 8) === 'ftyp'
    case '.mov': return ['ftyp', 'moov', 'mdat', 'wide'].includes(text(4, 8))
    default: return false
  }
}

function revisionOf(path: string, stat: BigIntStats): string {
  return createHash('sha256').update(JSON.stringify([
    path, stat.dev.toString(), stat.ino.toString(), stat.size.toString(),
    stat.mtimeNs.toString(), stat.ctimeNs.toString(),
  ])).digest('hex')
}

export interface MediaPreviewChunk {
  media: true
  filename: string
  totalBytes: number
  offset: number
  revision: string
  contentBase64: string
}

/** Stateless bounded reads: cancelling stops future requests, and disconnects
 * leave no file handles or transfer sessions behind on the remote machine. */
export async function readMediaPreviewChunk(
  root: string,
  target: string,
  offset: unknown,
  expectedRevision?: unknown,
): Promise<MediaPreviewChunk> {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || offset % MEDIA_PREVIEW_CHUNK_BYTES !== 0
    || (offset > 0 && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)))) {
    fail('MEDIA_INVALID_REQUEST')
  }
  const requested = resolveTarget(root, target)
  const requestedPath = requested.path
  try {
    const canonicalPath = await realpath(requestedPath)
    if (requested.relative) {
      const base = await realpath(root)
      if (!canonicalPath.startsWith(base.endsWith(sep) ? base : base + sep)) fail('MEDIA_INVALID_REQUEST')
    }
    // Resolve symlinks once, then refuse a last-component swap. NONBLOCK avoids
    // hanging on a FIFO before fstat can reject anything other than a file.
    const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.size <= 0n) fail('MEDIA_NOT_FOUND')
      if (before.size > BigInt(MEDIA_PREVIEW_MAX_BYTES)) fail('MEDIA_TOO_LARGE')
      const totalBytes = Number(before.size)
      if (offset >= totalBytes) fail('MEDIA_INVALID_REQUEST')
      const revision = revisionOf(canonicalPath, before)
      if (expectedRevision !== undefined && expectedRevision !== revision) fail('MEDIA_CHANGED')
      const header = Buffer.alloc(Math.min(4096, totalBytes))
      const headerRead = await file.read(header, 0, header.length, 0)
      if (!hasMediaHeader(header.subarray(0, headerRead.bytesRead), extname(requestedPath).toLowerCase())) {
        fail('MEDIA_UNSUPPORTED')
      }
      const bytes = Buffer.alloc(Math.min(MEDIA_PREVIEW_CHUNK_BYTES, totalBytes - offset))
      let read = 0
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, offset + read)
        if (!result.bytesRead) fail('MEDIA_CHANGED')
        read += result.bytesRead
      }
      if (revisionOf(canonicalPath, await file.stat({ bigint: true })) !== revision) fail('MEDIA_CHANGED')
      return { media: true, filename: basename(requestedPath), totalBytes, offset, revision, contentBase64: bytes.toString('base64') }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof MediaPreviewError) throw error
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) fail('MEDIA_NOT_FOUND')
    fail('MEDIA_READ_FAILED')
  }
}
