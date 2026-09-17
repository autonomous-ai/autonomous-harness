// node --test   (from the package folder) — the MP4 reader and the library, on synthetic files (no Manim, no ffmpeg).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { probe } from '../lib/mp4.mjs'
import { createLibrary, diffRenders, manimParts, readClipList } from '../lib/library.mjs'

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]) }

/** A minimal MP4: ftyp, mdat, moov with one video track (and optionally a sound track). */
function mp4({ frames, fps = 15, width = 854, height = 480, audio = false, moovFirst = false }) {
  const ts = 15360, delta = ts / fps, dur = frames * delta
  const track = (handler) => box('trak',
    box('tkhd', u32(0), u32(0), u32(0), u32(1), u32(0), u32(dur), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), Buffer.alloc(36), u32(handler === 'vide' ? width * 65536 : 0), u32(handler === 'vide' ? height * 65536 : 0)),
    box('mdia',
      box('mdhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), u16(0), u16(0)),
      box('hdlr', u32(0), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from([0])),
      box('minf', box('stbl',
        box('stsd', u32(0), u32(1), u32(16), Buffer.from(handler === 'vide' ? 'avc1' : 'mp4a', 'latin1'), Buffer.alloc(8)),
        box('stts', u32(0), u32(1), u32(frames), u32(delta))))))
  const moov = box('moov', box('mvhd', u32(0), u32(0), u32(0), u32(ts), u32(dur), Buffer.alloc(80)), track('vide'), ...(audio ? [track('soun')] : []))
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512))
  const mdat = box('mdat', Buffer.alloc(64))
  return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'video-viewer-test-'))
  const put = (rel, data, mtimeMs) => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    if (mtimeMs) utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
  }
  return { dir, put, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('probe reads frames, rate, size and sound wherever moov sits', () => {
  const ws = workspace()
  ws.put('a.mp4', mp4({ frames: 295, fps: 15 }))
  ws.put('b.mp4', mp4({ frames: 120, fps: 60, width: 1920, height: 1080, audio: true, moovFirst: true }))
  const a = probe(join(ws.dir, 'a.mp4'))
  assert.equal(a.complete, true); assert.equal(a.frames, 295); assert.equal(a.fps, 15); assert.equal(a.width, 854); assert.equal(a.height, 480)
  assert.ok(Math.abs(a.duration - 295 / 15) < 1e-9); assert.equal(a.audio, false); assert.equal(a.codec, 'avc1')
  const b = probe(join(ws.dir, 'b.mp4'))
  assert.equal(b.frames, 120); assert.equal(b.fps, 60); assert.equal(b.width, 1920); assert.equal(b.audio, true)
  const whole = mp4({ frames: 10 })
  ws.put('half.mp4', whole.subarray(0, whole.length - 20))
  assert.equal(probe(join(ws.dir, 'half.mp4')).complete, false, 'a movie still being written is not offered')
  ws.done()
})

test('Manim paths name the scene, its quality and the key its qualities share', () => {
  assert.deepEqual(manimParts('out/videos/proof/480p15/Proof.mp4'), { media: 'out', module: 'proof', quality: '480p15', scene: 'Proof', file: 'Proof', key: 'out/videos/proof/Proof', qdir: 'out/videos/proof/480p15' })
  assert.equal(manimParts('out/videos/proof/1080p60/Proof.mp4').key, 'out/videos/proof/Proof')
  assert.equal(manimParts('media/videos/x/480p15/X_ManimCE_v0.21.0.gif').scene, 'X')
  assert.equal(manimParts('renders/clip.mp4'), null)
})

test('a render has chapters, beats from the sidecar, and what changed since the render before', () => {
  const ws = workspace()
  const t = Date.now() - 60_000
  const q = 'out/videos/proof/480p15'
  ws.put(`${q}/partial_movie_files/Proof/111_a.mp4`, mp4({ frames: 20 }), t - 5000)
  ws.put(`${q}/partial_movie_files/Proof/222_b.mp4`, mp4({ frames: 25 }), t - 4000)
  ws.put(`${q}/partial_movie_files/Proof/partial_movie_file_list.txt`, "# ffmpeg\nfile 'file:/elsewhere/222_b.mp4'\n", t)
  ws.put(`${q}/Proof.mp4`, mp4({ frames: 45 }), t)
  ws.put(`${q}/sections/Proof.json`, JSON.stringify([{ name: 'Setup', nb_frames: '20', duration: '1.33' }, { name: 'Squares', nb_frames: '25', duration: '1.67' }]), t + 50)
  ws.put(`.harness/renders/${q}/Proof.mp4.json`, JSON.stringify({
    spec: 1, video: `${q}/Proof.mp4`, clipsDir: `${q}/partial_movie_files/Proof`, duration: 3, renderedAtMs: t + 60,
    clips: [{ name: '111_a.mp4', size: 1 }, { name: '222_b.mp4', size: 1 }],
    animations: [{ index: 0, label: 'Create(Square)', runTime: 1.33, clip: '111_a.mp4', section: 0 }, { index: 1, label: 'Write(Text)', runTime: 1.67, clip: '222_b.mp4', section: 1 }],
    sections: [{ name: 'Setup', animation: 0 }, { name: 'Squares', animation: 1 }],
    previous: { duration: 2.5, clips: [{ name: '111_a.mp4', size: 1 }, { name: '999_old.mp4', size: 1 }], sections: [{ name: 'Setup', animation: 0 }] },
  }), t + 60)
  const lib = createLibrary(ws.dir).scan()
  assert.equal(lib.renders.length, 1, 'clips and section cuts are not renders')
  const r = lib.renders[0]
  assert.equal(r.key, 'out/videos/proof/Proof'); assert.equal(r.frames, 45); assert.equal(r.fps, 15)
  assert.deepEqual(r.sections.map((s) => [s.name, s.start, s.frames]), [['Setup', 0, 20], ['Squares', 20, 25]])
  assert.deepEqual(r.beats.map((b) => [b.start, b.frames, b.label]), [[0, 20, 'Create(Square)'], [20, 25, 'Write(Text)']])
  assert.deepEqual(r.changes.ranges, [[20, 45]])
  assert.deepEqual(r.changes.sections.added, ['Squares'])
  assert.ok(Math.abs(r.changes.durationDelta - 0.5) < 1e-9)
  assert.deepEqual(lib.live, [])
  ws.done()
})

test('clips newer than their movie are a render in progress; the status file adds the error when it fails', () => {
  const ws = workspace()
  const now = Date.now()
  const q = 'out/videos/proof/480p15'
  ws.put(`${q}/Proof.mp4`, mp4({ frames: 45 }), now - 120_000)
  ws.put(`${q}/partial_movie_files/Proof/uncached_00000.mp4`, mp4({ frames: 20 }), now - 3000)
  ws.put(`${q}/partial_movie_files/Proof/uncached_00001.mp4`, mp4({ frames: 10 }), now - 2000)
  let lib = createLibrary(ws.dir).scan()
  assert.equal(lib.live.length, 1)
  assert.equal(lib.live[0].state, 'rendering'); assert.equal(lib.live[0].animation, 2); assert.equal(lib.live[0].source, 'files')
  assert.deepEqual(lib.live[0].clips.map((c) => c.frames), [20, 10])
  lib = createLibrary(ws.dir, { now: () => now + 60_000 }).scan()
  assert.equal(lib.live[0].state, 'stalled', 'no new clip for a while and no movie: stalled')

  ws.put('.harness/render.json', JSON.stringify({ state: 'failed', scene: 'Proof', output: `${q}/Proof.mp4`, updatedAtMs: now - 1000, finishedAtMs: now - 1000, animation: 3, clips: [`${q}/partial_movie_files/Proof/uncached_00000.mp4`, `${q}/partial_movie_files/Proof/uncached_00001.mp4`], error: { type: 'NameError', message: "name 'Sqaure' is not defined", file: 'scenes/proof.py', line: 42 } }))
  lib = createLibrary(ws.dir).scan()
  assert.equal(lib.live.length, 1)
  assert.equal(lib.live[0].state, 'failed'); assert.equal(lib.live[0].error.line, 42); assert.equal(lib.live[0].source, 'status')

  ws.put('.harness/render.json', JSON.stringify({ state: 'rendering', pid: 999_999_999, scene: 'Proof', output: `${q}/Proof.mp4`, updatedAtMs: now }))
  lib = createLibrary(ws.dir).scan()
  assert.equal(lib.live[0].state, 'stopped', 'a status whose process is gone is not rendering')
  ws.done()
})

test('diffRenders compares hashed clips by identity and uncached ones by place and size', () => {
  const beats = (list) => { let s = 0; return list.map(([name, fp, frames]) => { const b = { name, fp, start: s, frames }; s += frames; return b }) }
  const prev = { duration: 2, frames: 30, beats: beats([['h1.mp4', 'h1.mp4', 10], ['h2.mp4', 'h2.mp4', 20]]), sections: null }
  const same = diffRenders(prev, { ...prev, mtimeMs: 1 })
  assert.equal(same.same, true); assert.deepEqual(same.ranges, [])
  const moved = diffRenders(prev, { duration: 2.5, frames: 38, mtimeMs: 2, beats: beats([['h0.mp4', 'h0.mp4', 8], ['h1.mp4', 'h1.mp4', 10], ['h2.mp4', 'h2.mp4', 20]]), sections: null })
  assert.deepEqual(moved.ranges, [[0, 8]], 'an inserted animation is the only change')
  const unc = diffRenders({ ...prev, beats: beats([['uncached_00000.mp4', 'uncached_00000.mp4:100', 10]]) }, { duration: 2, frames: 10, mtimeMs: 3, beats: beats([['uncached_00000.mp4', 'uncached_00000.mp4:140', 10]]), sections: null })
  assert.deepEqual(unc.ranges, [[0, 10]])
})

test('Manim’s clip list is read by basename (its paths may be absolute and from elsewhere)', () => {
  const ws = workspace()
  ws.put('list.txt', "# This file is used internally by FFMPEG.\nfile 'file:/Users/x/out/videos/a/480p15/partial_movie_files/A/1_2_3.mp4'\nfile 'file:/Users/x/out/videos/a/480p15/partial_movie_files/A/uncached_00001.mp4'\n")
  assert.deepEqual(readClipList(join(ws.dir, 'list.txt')), ['1_2_3.mp4', 'uncached_00001.mp4'])
  ws.done()
})
