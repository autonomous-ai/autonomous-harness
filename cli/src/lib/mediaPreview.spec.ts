import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProjectFile } from './files.js'
import { MEDIA_PREVIEW_CHUNK_BYTES, MEDIA_PREVIEW_MAX_BYTES, readMediaPreviewChunk } from './mediaPreview.js'

describe('remote media preview reads', () => {
  let root: string
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-media-test-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reassembles exact bytes across bounded reads with one stable revision', async () => {
    const image = Buffer.alloc(MEDIA_PREVIEW_CHUNK_BYTES * 3 + 17, 91)
    pngHeader.copy(image)
    await writeFile(join(root, 'ảnh one.png'), image)
    const chunks: Buffer[] = []
    let revision: string | undefined
    for (let offset = 0; offset < image.length; offset += MEDIA_PREVIEW_CHUNK_BYTES) {
      const reply = await readMediaPreviewChunk(root, 'ảnh one.png', offset, revision)
      expect(reply).toMatchObject({ media: true, filename: 'ảnh one.png', offset, totalBytes: image.length })
      expect(reply.revision).toMatch(/^[a-f0-9]{64}$/)
      if (revision) expect(reply.revision).toBe(revision)
      revision = reply.revision
      chunks.push(Buffer.from(reply.contentBase64, 'base64'))
      // Include the second base64 expansion used by an encrypted JSON envelope.
      expect(Buffer.byteLength(Buffer.from(JSON.stringify(reply)).toString('base64')) + 4096).toBeLessThan(256 * 1024)
    }
    expect(Buffer.concat(chunks)).toEqual(image)
  })

  it('reads absolute and file URI artifacts outside the agent cwd', async () => {
    const path = join(root, '100% ảnh #1.png')
    await writeFile(path, pngHeader)
    for (const target of [path, pathToFileURL(path).href]) {
      const reply = await readMediaPreviewChunk(join(root, 'workspace'), target, 0)
      expect(Buffer.from(reply.contentBase64, 'base64')).toEqual(pngHeader)
    }
  })

  it.each([
    ['clip.mp4', Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0])],
    ['clip.webm', Buffer.from([26, 69, 223, 163, 0, 0])],
    ['clip.mov', Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypqt  '), 0, 0, 0, 0])],
    ['image.jpg', Buffer.from([255, 216, 255, 224])],
    ['image.svg', Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['image.gif', Buffer.from('GIF89a0000')],
  ])('supports %s media without interpreting it as UTF-8 text', async (filename, bytes) => {
    await writeFile(join(root, filename), bytes)
    expect(Buffer.from((await readMediaPreviewChunk(root, filename, 0)).contentBase64, 'base64')).toEqual(bytes)
  })

  it('preserves the existing text reader restrictions', async () => {
    await writeFile(join(root, 'image.png'), Buffer.concat([pngHeader, Buffer.from([0])]))
    await writeFile(join(root, 'source.txt'), 'hello')
    expect(readProjectFile(root, 'source.txt')).toBe('hello')
    expect(() => readProjectFile(root, 'image.png')).toThrow('NOT_TEXT')
    await expect(readMediaPreviewChunk(root, 'source.txt', 0)).rejects.toThrow('MEDIA_UNSUPPORTED')
  })

  it('rejects renamed non-media files and symlinks to non-media', async () => {
    await writeFile(join(root, 'credentials.txt'), 'a-private-credential')
    await writeFile(join(root, 'renamed.png'), 'a-private-credential')
    await symlink(join(root, 'credentials.txt'), join(root, 'linked.png'))
    for (const target of ['renamed.png', 'linked.png']) {
      await expect(readMediaPreviewChunk(root, target, 0)).rejects.toThrow('MEDIA_UNSUPPORTED')
    }
  })

  it('refuses to mix versions when a file changes or is replaced mid-download', async () => {
    const path = join(root, 'image.png')
    const image = Buffer.alloc(MEDIA_PREVIEW_CHUNK_BYTES + 10)
    pngHeader.copy(image)
    await writeFile(path, image)
    const first = await readMediaPreviewChunk(root, path, 0)
    await rm(path)
    await writeFile(path, image)
    await expect(readMediaPreviewChunk(root, path, MEDIA_PREVIEW_CHUNK_BYTES, first.revision)).rejects.toThrow('MEDIA_CHANGED')
  })

  it('keeps relative symlink targets inside the agent workspace', async () => {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(root, 'outside.png'), pngHeader)
    await symlink(join(root, 'outside.png'), join(workspace, 'linked.png'))
    await expect(readMediaPreviewChunk(workspace, 'linked.png', 0)).rejects.toThrow('MEDIA_INVALID_REQUEST')
    expect((await readMediaPreviewChunk(workspace, join(root, 'outside.png'), 0)).totalBytes).toBe(pngHeader.length)
  })

  it('refuses a missing file and an empty file', async () => {
    await expect(readMediaPreviewChunk(root, 'gone.png', 0)).rejects.toThrow('MEDIA_NOT_FOUND')
    await writeFile(join(root, 'empty.png'), '')
    await expect(readMediaPreviewChunk(root, 'empty.png', 0)).rejects.toThrow('MEDIA_NOT_FOUND')
  })

  it('rejects oversized files using metadata before reading contents', async () => {
    const file = await open(join(root, 'large.mp4'), 'w')
    await file.truncate(MEDIA_PREVIEW_MAX_BYTES + 1)
    await file.close()
    await expect(readMediaPreviewChunk(root, 'large.mp4', 0)).rejects.toThrow('MEDIA_TOO_LARGE')
  })

  it.each([-1, 1.5, 1, '0', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid offset %s', async (offset) => {
    await expect(readMediaPreviewChunk(root, 'image.png', offset)).rejects.toThrow('MEDIA_INVALID_REQUEST')
  })

  it.each(['../outside.png', 'file://other-host/tmp/photo.png', 'https://example.com/photo.png', 'bad\0.png'])('refuses invalid target %s', async (target) => {
    await expect(readMediaPreviewChunk(root, target, 0)).rejects.toThrow('MEDIA_INVALID_REQUEST')
  })

  it('requires the first revision for every subsequent chunk', async () => {
    await expect(readMediaPreviewChunk(root, 'image.png', MEDIA_PREVIEW_CHUNK_BYTES)).rejects.toThrow('MEDIA_INVALID_REQUEST')
  })
})
