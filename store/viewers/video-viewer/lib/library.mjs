// The library: every render in the workspace, newest first, with what the pane needs to be an editor
// rather than a <video> — frame rate and frame count (for frame stepping), Manim's sections (chapters),
// the animations a render is made of (beats), what changed since the last render of the same file, and
// the renders still in progress.
//
// Manim's layout is understood when it is there and never required:
//
//   <media>/videos/<module>/<quality>/<Scene>.mp4                       the render
//   <media>/videos/<module>/<quality>/sections/<Scene>.json             --save_sections: the chapters
//   <media>/videos/<module>/<quality>/partial_movie_files/<Scene>/*.mp4 one clip per animation
//   <media>/videos/<module>/<quality>/partial_movie_files/<Scene>/partial_movie_file_list.txt
//   .harness/render.json                                                a render in progress (optional)
//   .harness/renders/<video path>.json                                  how a render was made (optional)
//
// The last two are written by a render wrapper (the Manim harness's toolchain/render.py); without
// them the pane still finds chapters, animations and renders in progress from Manim's own files.
//
// Any other video under the workspace is listed as itself.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { probe, probeGif, probePng } from './mp4.mjs'

const VIDEO = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const IGNORED = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.claude', '.agents', '.codex', 'dist', 'build', '.cache', 'texts', 'Tex'])
const MAX_DEPTH = 9
const MAX_ENTRIES = 30_000
export const STALL_MS = 45_000
const FORGET_STALLED_MS = 20 * 60_000

const ext = (p) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase() }
const posix = (p) => p.split(sep).join('/')

/** Manim's path shape: …/videos/<module>/<quality>/<Scene>.<ext>. */
export function manimParts(rel) {
  const m = /^(?:(.*)\/)?videos\/([^/]+)\/(\d+p\d+)\/([^/]+)\.(mp4|mov|webm|gif|m4v)$/i.exec(rel)
  if (!m) return null
  const media = m[1] ?? ''
  const scene = m[4].replace(/_ManimCE_v[\d.]+$/, '') // --format gif names carry the version
  return { media, module: m[2], quality: m[3], scene, file: m[4], key: `${media ? media + '/' : ''}videos/${m[2]}/${scene}`, qdir: `${media ? media + '/' : ''}videos/${m[2]}/${m[3]}` }
}

/** "480p15" → { height: 480, fps: 15 }. */
export function qualityParts(q) {
  const m = /^(\d+)p(\d+)$/.exec(q ?? '')
  return m ? { height: Number(m[1]), fps: Number(m[2]) } : null
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function statOrNull(path) {
  try { return statSync(path) } catch { return null }
}

/** Clip basenames in the order a partial_movie_file_list.txt names them (its paths may be absolute and stale). */
export function readClipList(path) {
  try {
    return readFileSync(path, 'utf8').split('\n')
      .map((line) => /^file\s+'(?:file:)?(.*)'\s*$/.exec(line.trim()))
      .filter(Boolean)
      .map((m) => m[1].split(/[\\/]/).pop())
  } catch {
    return null
  }
}

/** Fingerprint of a clip: Manim's hashed names are content hashes; uncached_NNNNN names are not, so their size joins in. */
const fingerprint = (name, size) => (/^uncached_/.test(name) ? `${name}:${size}` : name)

/**
 * Where a render differs from the one before it: frame ranges of animations whose clip is new, sections
 * added / removed / retimed, and the change in length. Hashed clip names compare by identity (Manim's
 * hash covers the animation and the scene state), uncached ones by position and size.
 */
export function diffRenders(prev, next) {
  const out = { at: next.mtimeMs, durationDelta: (next.duration ?? 0) - (prev.duration ?? 0), framesDelta: (next.frames ?? 0) - (prev.frames ?? 0), ranges: null, sections: null, same: false }
  if (prev.beats && next.beats) {
    const prevSet = new Set(prev.beats.map((b) => b.fp))
    const ranges = []
    next.beats.forEach((b, i) => {
      const hashed = !/^uncached_/.test(b.name)
      const same = hashed ? prevSet.has(b.fp) : prev.beats[i]?.fp === b.fp
      if (same) return
      const last = ranges[ranges.length - 1]
      if (last && last[1] === b.start) last[1] = b.start + b.frames
      else ranges.push([b.start, b.start + b.frames])
    })
    out.ranges = ranges
  }
  if (prev.sections || next.sections) {
    const before = new Map((prev.sections ?? []).map((s) => [s.name, s]))
    const after = new Map((next.sections ?? []).map((s) => [s.name, s]))
    const touched = (s) => (out.ranges ?? []).some(([a, b]) => a < s.start + s.frames && b > s.start)
    out.sections = {
      added: [...after.keys()].filter((n) => !before.has(n)),
      removed: [...before.keys()].filter((n) => !after.has(n)),
      changed: [...after.values()].filter((s) => before.has(s.name) && (before.get(s.name).frames !== s.frames || touched(s))).map((s) => s.name),
    }
  }
  const noSectionChange = !out.sections || (!out.sections.added.length && !out.sections.removed.length && !out.sections.changed.length)
  out.same = out.framesDelta === 0 && (out.ranges ? out.ranges.length === 0 : false) && noSectionChange
  return out
}

export function createLibrary(workspace, options = {}) {
  const now = options.now ?? Date.now
  const probes = new Map() // abs path → { mtimeMs, size, info }
  const snapshots = new Map() // rel path → { mtimeMs, duration, frames, beats, sections }
  const changes = new Map() // rel path → diff

  function probed(abs, st, kind) {
    const hit = probes.get(abs)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info
    const info = kind === 'gif' ? probeGif(abs) : kind === 'image' ? probePng(abs) : probe(abs)
    probes.set(abs, { mtimeMs: st.mtimeMs, size: st.size, info })
    return info
  }

  function walk() {
    const media = [] // { rel, abs, st }
    const partialRoots = [] // { qdirRel, scene, abs }
    let entries = 0
    const visit = (dir, depth) => {
      if (depth > MAX_DEPTH || entries > MAX_ENTRIES) return
      let names
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        if (++entries > MAX_ENTRIES) return
        if (name.startsWith('.')) continue
        const abs = join(dir, name)
        const st = statOrNull(abs)
        if (!st) continue
        if (st.isDirectory()) {
          if (IGNORED.has(name)) continue
          if (name === 'partial_movie_files') {
            let scenes = []
            try { scenes = readdirSync(abs) } catch {}
            for (const scene of scenes) {
              const sceneAbs = join(abs, scene)
              if (statOrNull(sceneAbs)?.isDirectory()) partialRoots.push({ qdirRel: posix(relative(workspace, dir)), scene, abs: sceneAbs })
            }
            continue
          }
          if (name === 'sections') continue // chapters of the render beside it, read on demand
          visit(abs, depth + 1)
          continue
        }
        if (!st.isFile()) continue
        const e = ext(name)
        const rel = posix(relative(workspace, abs))
        if (VIDEO.has(e) || e === '.gif') media.push({ rel, abs, st, kind: e === '.gif' ? 'gif' : 'video' })
        else if (e === '.png' && /(^|\/)images\//.test(rel)) media.push({ rel, abs, st, kind: 'image' })
      }
    }
    visit(workspace, 0)
    return { media, partialRoots }
  }

  /** .harness/renders/<video>.json, when it describes this very render (written just after it). */
  function sidecarFor(rel, videoSt) {
    const abs = join(workspace, '.harness', 'renders', `${rel}.json`)
    const st = statOrNull(abs)
    if (!st || st.mtimeMs < videoSt.mtimeMs - 1000) return null
    const raw = readJson(abs)
    return raw && typeof raw === 'object' && Array.isArray(raw.clips) ? raw : null
  }

  /** Beats from the sidecar: one per animation that wrote a clip, with its label and section. */
  function beatsFromSidecar(sidecar, fps, frames) {
    const dirAbs = sidecar.clipsDir ? join(workspace, sidecar.clipsDir) : null
    const byClip = new Map((sidecar.animations ?? []).filter((a) => a && a.clip).map((a) => [a.clip, a]))
    let start = 0
    const beats = []
    for (const clip of sidecar.clips) {
      const name = typeof clip === 'string' ? clip : clip?.name
      if (!name) return null
      const anim = byClip.get(name)
      let n = null
      if (dirAbs) {
        const cst = statOrNull(join(dirAbs, name))
        if (cst) { const info = probed(join(dirAbs, name), cst, 'video'); if (info.complete) n = info.frames }
      }
      if (!n && anim?.runTime && fps) n = Math.max(1, Math.round(anim.runTime * fps))
      if (!n) return null
      beats.push({ name, fp: fingerprint(name, clip?.size ?? ''), start, frames: n, label: anim?.label ?? null, section: anim?.section ?? null, index: anim?.index ?? beats.length })
      start += n
    }
    if (frames && Math.abs(start - frames) > 2) return null
    return beats
  }

  function sectionsFor(parts, videoSt, fps) {
    if (!parts) return null
    const jsonAbs = join(workspace, parts.qdir, 'sections', `${parts.scene}.json`)
    const st = statOrNull(jsonAbs)
    // Written after the movie; one older than the movie belongs to an earlier render.
    if (!st || st.mtimeMs < videoSt.mtimeMs - 2000) return null
    const raw = readJson(jsonAbs)
    if (!Array.isArray(raw) || !raw.length) return null
    let start = 0
    return raw.map((s, i) => {
      const frames = Number(s.nb_frames) || Math.round((Number(s.duration) || 0) * (fps || 15))
      const out = { index: i, name: String(s.name ?? `Section ${i + 1}`), type: s.type ?? null, start, frames, video: s.video ? `${parts.qdir}/sections/${s.video}` : null }
      start += frames
      return out
    })
  }

  function beatsFor(parts, videoSt, frames) {
    if (!parts) return null
    const dirAbs = join(workspace, parts.qdir, 'partial_movie_files', parts.scene)
    const listAbs = join(dirAbs, 'partial_movie_file_list.txt')
    const st = statOrNull(listAbs)
    // The list is written just before the clips are joined into the movie.
    if (!st || st.mtimeMs > videoSt.mtimeMs + 2000 || st.mtimeMs < videoSt.mtimeMs - 30 * 60_000) return null
    const names = readClipList(listAbs)
    if (!names?.length) return null
    let start = 0
    const beats = []
    for (const name of names) {
      const abs = join(dirAbs, name)
      const cst = statOrNull(abs)
      if (!cst) return null
      const info = probed(abs, cst, 'video')
      if (!info.complete || !info.frames) return null
      beats.push({ name, fp: fingerprint(name, cst.size), start, frames: info.frames })
      start += info.frames
    }
    if (frames && Math.abs(start - frames) > 2) return null
    return beats
  }

  function renderEntry(item) {
    const { rel, abs, st, kind } = item
    const info = probed(abs, st, kind)
    const parts = kind === 'image' ? null : manimParts(rel)
    const imageScene = kind === 'image' ? /(?:^|\/)images\/([^/]+)\/([^/]+)\.png$/i.exec(rel) : null
    const q = qualityParts(parts?.quality)
    const fps = info.fps ?? q?.fps ?? null
    const entry = {
      path: rel,
      kind,
      key: parts?.key ?? rel,
      title: parts?.scene ?? imageScene?.[2]?.replace(/_ManimCE_v[\d.]+$/, '') ?? basename(rel).replace(/\.[^.]+$/, ''),
      module: parts?.module ?? imageScene?.[1] ?? null,
      quality: parts?.quality ?? null,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      complete: info.complete !== false,
      width: info.width ?? null,
      height: info.height ?? q?.height ?? null,
      fps,
      frames: info.frames ?? null,
      duration: info.duration ?? null,
      audio: Boolean(info.audio),
      sections: null,
      beats: null,
      changes: null,
    }
    if (kind === 'video' && entry.complete) {
      const sidecar = sidecarFor(rel, st)
      const beats = (sidecar && beatsFromSidecar(sidecar, fps, entry.frames)) || beatsFor(parts, st, entry.frames)
      let sections = sectionsFor(parts, st, fps)
      if (!sections && sidecar && beats && Array.isArray(sidecar.sections) && sidecar.sections.length > 1) {
        // Chapters the wrapper saw, placed by the animations they begin at.
        sections = sidecar.sections.map((sec, i) => {
          const first = beats.find((b) => b.index >= sec.animation)
          return { index: i, name: String(sec.name), type: null, start: first ? first.start : entry.frames ?? 0, frames: 0, video: null }
        })
        sections.forEach((sec, i) => { sec.frames = (sections[i + 1]?.start ?? entry.frames ?? sec.start) - sec.start })
      }
      entry.sections = sections
      entry.beats = beats ? beats.map(({ name, start, frames, label }) => ({ name, start, frames, label: label ?? null })) : null
      entry.tool = sidecar?.tool ?? null
      entry.source = sidecar?.source ?? null
      entry.tookMs = sidecar?.tookMs ?? null
      const snap = { mtimeMs: entry.mtimeMs, duration: entry.duration, frames: entry.frames, beats, sections }
      const prev = snapshots.get(rel)
      if (sidecar?.previous?.clips?.length && beats) {
        // The wrapper remembered the render before this one, so the change survives a restart.
        const prevBeats = sidecar.previous.clips.map((c) => ({ name: c.name, fp: fingerprint(c.name, c.size ?? '') }))
        const prevSections = (sidecar.previous.sections ?? []).map((x) => ({ name: x.name, start: -1, frames: -1 }))
        const diff = diffRenders({ duration: null, frames: null, beats: prevBeats, sections: prevSections.length ? prevSections : null }, snap)
        diff.durationDelta = typeof sidecar.previous.duration === 'number' && typeof sidecar.duration === 'number'
          ? sidecar.duration - sidecar.previous.duration
          : prev && prev.mtimeMs !== snap.mtimeMs ? (snap.duration ?? 0) - (prev.duration ?? 0) : null
        diff.framesDelta = null
        if (diff.sections) diff.sections.changed = (sections ?? []).filter((x) => diff.ranges?.some(([a, b]) => a < x.start + x.frames && b > x.start) && !diff.sections.added.includes(x.name)).map((x) => x.name)
        diff.same = diff.ranges?.length === 0 && (!diff.sections || (!diff.sections.added.length && !diff.sections.removed.length))
        diff.at = sidecar.renderedAtMs ?? entry.mtimeMs
        changes.set(rel, diff)
      } else if (prev && prev.mtimeMs !== snap.mtimeMs) changes.set(rel, diffRenders(prev, snap))
      snapshots.set(rel, snap)
      entry.changes = changes.get(rel) ?? null
    }
    return entry
  }

  function clipInfo(relPath) {
    const abs = join(workspace, relPath)
    const st = statOrNull(abs)
    if (!st) return { path: relPath, ready: false }
    const info = probed(abs, st, 'video')
    return { path: relPath, ready: Boolean(info.complete && info.frames), frames: info.frames ?? null, fps: info.fps ?? null, duration: info.duration ?? null, width: info.width ?? null, height: info.height ?? null, mtimeMs: Math.round(st.mtimeMs) }
  }

  /** Renders in progress judged from the clips on disk alone: clips newer than the movie they will become. */
  function liveFromFiles(partialRoots, renders) {
    const out = []
    const t = now()
    for (const root of partialRoots) {
      const finalRel = [...VIDEO, '.gif'].map((e) => `${root.qdirRel}/${root.scene}${e}`).find((p) => statOrNull(join(workspace, p)))
      const finalSt = finalRel ? statOrNull(join(workspace, finalRel)) : null
      const since = finalSt ? finalSt.mtimeMs + 1 : 0
      let names = []
      try { names = readdirSync(root.abs).filter((n) => VIDEO.has(ext(n))) } catch {}
      const fresh = []
      for (const name of names) {
        const st = statOrNull(join(root.abs, name))
        if (st && st.mtimeMs > since) fresh.push({ name, st })
      }
      if (!fresh.length) continue
      const latest = Math.max(...fresh.map((f) => f.st.mtimeMs))
      if (t - latest > FORGET_STALLED_MS) continue
      fresh.sort((a, b) => {
        const ua = /^uncached_(\d+)/.exec(a.name), ub = /^uncached_(\d+)/.exec(b.name)
        if (ua && ub) return Number(ua[1]) - Number(ub[1])
        return (a.st.birthtimeMs || a.st.mtimeMs) - (b.st.birthtimeMs || b.st.mtimeMs)
      })
      const parts = manimParts(`${root.qdirRel}/${root.scene}.mp4`)
      // How many animations to expect: the wrapper's record of the last render, else Manim's clip
      // list — which --save_sections overwrites with the last section's, so only without sections.
      const sidecar = finalRel ? readJson(join(workspace, '.harness', 'renders', `${finalRel}.json`)) : null
      const hasSections = statOrNull(join(workspace, root.qdirRel, 'sections', `${root.scene}.json`))
      const previous = Array.isArray(sidecar?.animations) ? sidecar.animations : hasSections ? null : readClipList(join(root.abs, 'partial_movie_file_list.txt'))
      const clips = fresh.map((f) => clipInfo(posix(relative(workspace, join(root.abs, f.name)))))
      const uncachedMax = Math.max(-1, ...fresh.map((f) => Number(/^uncached_(\d+)/.exec(f.name)?.[1] ?? -1)))
      out.push({
        key: parts?.key ?? `${root.qdirRel}/${root.scene}`,
        title: root.scene,
        module: parts?.module ?? null,
        quality: parts?.quality ?? null,
        output: finalRel ?? `${root.qdirRel}/${root.scene}.mp4`,
        source: 'files',
        state: t - latest < STALL_MS ? 'rendering' : 'stalled',
        startedAtMs: Math.round(Math.min(...fresh.map((f) => f.st.birthtimeMs || f.st.mtimeMs))),
        updatedAtMs: Math.round(latest),
        animation: uncachedMax >= 0 ? uncachedMax + 1 : fresh.length,
        expected: previous?.length ?? null,
        current: null,
        sections: [],
        animations: [],
        clips,
        contiguous: uncachedMax >= 0 && uncachedMax + 1 === fresh.length,
        error: null,
      })
    }
    return out
  }

  /** The render a wrapper reports in .harness/render.json, when it has one. */
  function liveFromStatus(renders) {
    const abs = join(workspace, '.harness', 'render.json')
    const st = statOrNull(abs)
    if (!st) return null
    const r = readJson(abs)
    if (!r || typeof r !== 'object' || !r.state) return null
    const t = now()
    let state = r.state
    if (state === 'rendering' && r.pid && !isPidAlive(r.pid)) state = 'stopped'
    if (state === 'rendering' && !r.pid && t - (r.updatedAtMs ?? st.mtimeMs) > STALL_MS) state = 'stalled'
    const output = typeof r.output === 'string' ? r.output : null
    const parts = output ? manimParts(output) : null
    const key = parts?.key ?? output ?? r.scene ?? 'render'
    const finished = r.finishedAtMs ?? r.updatedAtMs ?? st.mtimeMs
    if (state === 'done') return { key, done: true }
    if (state !== 'rendering') {
      // A failure stays on screen until a newer render of the same thing lands, or for a while.
      const rendered = renders.find((x) => x.key === key)
      if (rendered && rendered.mtimeMs > finished) return { key, done: true }
      if (t - finished > FORGET_STALLED_MS) return { key, done: true }
    }
    const clips = (Array.isArray(r.clips) ? r.clips : []).filter((c) => typeof c === 'string').map(clipInfo)
    return {
      key,
      title: r.scene ?? parts?.scene ?? 'Render',
      module: parts?.module ?? null,
      quality: r.quality ?? parts?.quality ?? null,
      output,
      sourceFile: r.source ?? null,
      source: 'status',
      state,
      startedAtMs: r.startedAtMs ?? null,
      updatedAtMs: r.updatedAtMs ?? Math.round(st.mtimeMs),
      finishedAtMs: r.finishedAtMs ?? null,
      animation: Number(r.animation) || clips.length,
      expected: Number(r.expected) || null,
      current: r.current ?? null,
      sections: Array.isArray(r.sections) ? r.sections.filter((s) => s && typeof s.name === 'string' && !s.skipped).map((s) => ({ name: s.name, animation: Number(s.animation) || 0 })) : [],
      animations: Array.isArray(r.animations) ? r.animations.filter((a) => a && typeof a === 'object').map((a) => ({ index: a.index, label: a.label ?? null, runTime: a.runTime ?? null, clip: a.clip ?? null, section: a.section ?? null })) : [],
      clips,
      contiguous: true,
      error: r.error ?? null,
    }
  }

  function scan() {
    const { media, partialRoots } = walk()
    const renders = media.map(renderEntry).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const live = liveFromFiles(partialRoots, renders)
    const status = liveFromStatus(renders)
    if (status) {
      const i = live.findIndex((l) => l.key === status.key)
      // A plain `manim render` after the wrapper's last run is newer news than its status file.
      const filesNewer = i >= 0 && (live[i].updatedAtMs ?? 0) > (status.updatedAtMs ?? 0) + 1000 && status.state !== 'rendering'
      if (status.done) { if (i >= 0 && live[i].state !== 'rendering') live.splice(i, 1) } else if (i >= 0) { if (!filesNewer) live[i] = status }
      else live.push(status)
    }
    let scenes = 0
    try { scenes = readdirSync(join(workspace, 'scenes')).filter((n) => n.endsWith('.py')).length } catch {}
    const verdict = readJson(join(workspace, '.harness', 'verdict.json'))
    return {
      workspace: { name: basename(workspace), path: workspace },
      renders,
      live: live.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)),
      scenes,
      verdict: verdict && typeof verdict === 'object' ? { ready: Boolean(verdict.ready), summary: verdict.summary ?? '', artifact: verdict.artifact ?? null, updatedAt: verdict.updatedAt ?? null } : null,
    }
  }

  return { scan, probe: (rel) => { const abs = join(workspace, rel); const st = statOrNull(abs); return st ? probed(abs, st, ext(rel) === '.gif' ? 'gif' : 'video') : null } }
}

