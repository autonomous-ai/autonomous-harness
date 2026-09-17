// A small ISO-BMFF (MP4 / MOV) reader: duration, size, frame rate, frame count and whether there is
// sound, straight from the `moov` box, so the pane needs no ffprobe. It reads box headers by seeking
// and only loads `moov` itself (kilobytes), wherever it sits in the file.
//
// A file that is still being written — Manim muxes partial clips on worker threads and writes its
// final movie in place — has no complete `moov` yet; probe() answers { complete: false } for it, and
// the library waits for the next change instead of offering a half-written video.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'


function readAt(fd, position, length) {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got)
    if (n <= 0) break
    got += n
  }
  return got === length ? buf : buf.subarray(0, got)
}

/** Top-level boxes, by header only. Returns { type, start, size, header } for each. */
function topLevel(fd, fileSize) {
  const boxes = []
  let pos = 0
  while (pos + 8 <= fileSize) {
    const h = readAt(fd, pos, 16)
    if (h.length < 8) break
    let size = h.readUInt32BE(0)
    const type = h.toString('latin1', 4, 8)
    let header = 8
    if (size === 1) {
      if (h.length < 16) break
      size = Number(h.readBigUInt64BE(8)); header = 16
    } else if (size === 0) {
      size = fileSize - pos
    }
    if (size < header) break
    boxes.push({ type, start: pos, size, header, truncated: pos + size > fileSize })
    pos += size
  }
  return boxes
}

/** Child boxes of a buffer region. */
function children(buf, start, end) {
  const out = []
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16 } else if (size === 0) size = end - pos
    if (size < header || pos + size > end) break
    out.push({ type, start: pos + header, end: pos + size })
    pos += size
  }
  return out
}

function find(buf, box, path) {
  let current = [box]
  for (const type of path) {
    const next = []
    for (const b of current) for (const c of children(buf, b.start, b.end)) if (c.type === type) next.push(c)
    current = next
    if (!current.length) return []
  }
  return current
}

function fullBoxTimes(buf, start) {
  const version = buf.readUInt8(start)
  // version 1: creation(8) modification(8) timescale(4) duration(8); version 0: 4, 4, 4, 4
  if (version === 1) return { timescale: buf.readUInt32BE(start + 20), duration: Number(buf.readBigUInt64BE(start + 24)) }
  return { timescale: buf.readUInt32BE(start + 12), duration: buf.readUInt32BE(start + 16) }
}

function track(buf, trak) {
  const hdlr = find(buf, trak, ['mdia', 'hdlr'])[0]
  const handler = hdlr ? buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) : ''
  const mdhd = find(buf, trak, ['mdia', 'mdhd'])[0]
  const times = mdhd ? fullBoxTimes(buf, mdhd.start) : { timescale: 0, duration: 0 }
  const out = { handler, timescale: times.timescale, duration: times.timescale ? times.duration / times.timescale : 0 }
  if (handler !== 'vide') return out
  const tkhd = find(buf, trak, ['tkhd'])[0]
  if (tkhd) {
    // width and height are the last 8 bytes of tkhd, 16.16 fixed point
    out.width = Math.round(buf.readUInt32BE(tkhd.end - 8) / 65536)
    out.height = Math.round(buf.readUInt32BE(tkhd.end - 4) / 65536)
  }
  const stsd = find(buf, trak, ['mdia', 'minf', 'stbl', 'stsd'])[0]
  if (stsd && stsd.end - stsd.start >= 16) out.codec = buf.toString('latin1', stsd.start + 12, stsd.start + 16)
  const stts = find(buf, trak, ['mdia', 'minf', 'stbl', 'stts'])[0]
  if (stts) {
    const entries = buf.readUInt32BE(stts.start + 4)
    let frames = 0, common = 0, commonCount = -1
    for (let i = 0; i < entries && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
      const count = buf.readUInt32BE(stts.start + 8 + i * 8)
      const delta = buf.readUInt32BE(stts.start + 12 + i * 8)
      frames += count
      if (count > commonCount) { commonCount = count; common = delta }
    }
    out.frames = frames
    if (common && times.timescale) out.fps = times.timescale / common
  }
  return out
}

/** Round a measured rate to the rate it was meant to be (15, 29.97, 30, 60 …). */
export function niceFps(fps) {
  if (!fps || !isFinite(fps)) return null
  for (const r of [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]) if (Math.abs(fps - r) < 0.02) return r
  return Math.round(fps * 1000) / 1000
}

/**
 * Probe one file. { complete, duration, width, height, fps, frames, audio, codec } — complete is false
 * while the file is still being written (no whole moov box yet).
 */
export function probe(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size < 16) return { complete: false }
    const boxes = topLevel(fd, size)
    if (!boxes.length || !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(boxes[0].type)) return { complete: false, unknown: true }
    const moovHead = boxes.find((b) => b.type === 'moov')
    if (!moovHead || moovHead.truncated) return { complete: false }
    if (boxes.some((b) => b.truncated)) return { complete: false }
    if (moovHead.size > 64 * 1024 * 1024) return { complete: false }
    const buf = readAt(fd, moovHead.start, moovHead.size)
    const moov = { type: 'moov', start: moovHead.header, end: buf.length }
    const mvhd = find(buf, moov, ['mvhd'])[0]
    const movie = mvhd ? fullBoxTimes(buf, mvhd.start) : { timescale: 0, duration: 0 }
    const tracks = find(buf, moov, ['trak']).map((t) => track(buf, t))
    const video = tracks.find((t) => t.handler === 'vide')
    if (!video) return { complete: true, duration: movie.timescale ? movie.duration / movie.timescale : null, audio: tracks.some((t) => t.handler === 'soun') }
    const fps = niceFps(video.fps)
    return {
      complete: true,
      duration: video.duration || (movie.timescale ? movie.duration / movie.timescale : null),
      width: video.width ?? null,
      height: video.height ?? null,
      fps,
      frames: video.frames ?? (fps && video.duration ? Math.round(video.duration * fps) : null),
      audio: tracks.some((t) => t.handler === 'soun'),
      codec: video.codec ?? null,
    }
  } catch {
    return { complete: false }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/** GIF: logical screen size, frame count and total delay, from the blocks. */
export function probeGif(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = readAt(fd, 0, Math.min(size, 32 * 1024 * 1024))
    if (buf.toString('latin1', 0, 3) !== 'GIF') return { complete: false }
    const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8)
    let pos = 13
    const flags = buf[10]
    if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1))
    let frames = 0, centis = 0, delay = 0, ended = false
    while (pos < buf.length) {
      const b = buf[pos]
      if (b === 0x3b) { ended = true; break }
      if (b === 0x21) {
        const label = buf[pos + 1]
        if (label === 0xf9) delay = buf.readUInt16LE(pos + 4)
        pos += 2
        while (pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1
        pos += 1
      } else if (b === 0x2c) {
        const lflags = buf[pos + 9]
        pos += 10
        if (lflags & 0x80) pos += 3 * (1 << ((lflags & 7) + 1))
        pos += 1
        while (pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1
        pos += 1
        frames++; centis += delay || 10; delay = 0
      } else break
    }
    return { complete: ended, width, height, frames, duration: centis / 100, fps: frames && centis ? niceFps(frames / (centis / 100)) : null }
  } catch {
    return { complete: false }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/** PNG: IHDR size. */
export function probePng(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = readAt(fd, 0, 32)
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return { complete: false }
    const tail = size >= 12 ? readAt(fd, size - 8, 4).toString('latin1') : ''
    return { complete: tail === 'IEND', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch {
    return { complete: false }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}
