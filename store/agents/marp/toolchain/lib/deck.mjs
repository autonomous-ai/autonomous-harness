// The one place a deck is read, rendered and judged. The viewer and the check script both use it,
// so the pane and the agent's own check never disagree about what the deck is.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', 'package.json'))
const { Marp } = require('@marp-team/marp-core')

/** The harness's own themes, `themes/*.css`, each declaring `@theme <name>` on its first line. */
export const THEMES_DIR = resolve(here, '..', '..', 'themes')

/** A keynote slide carries one idea. Past this many words it is a page, not a slide. */
export const WORDS_PER_SLIDE = 40
export const MIN_SLIDES = 3

function themeSources(extraDirs = []) {
  const sources = []
  for (const dir of [THEMES_DIR, ...extraDirs]) {
    let names = []
    try { names = readdirSync(dir).filter((n) => n.endsWith('.css')) } catch { continue }
    for (const name of names) {
      try { sources.push(readFileSync(join(dir, name), 'utf8')) } catch { /* a theme that cannot be read is no theme */ }
    }
  }
  return sources
}

function stripTags(html) {
  // marp-core appends its WebKit polyfill <script> to the last slide, and a theme may inline a
  // <style>: neither is a word the audience reads.
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
}

function frontMatter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  return m ? m[1] : null
}

/**
 * Render a deck: html (array, one string per slide), css, and per-slide facts the lint reads.
 * The harness's keynote themes are registered, plus any `themes/*.css` beside the deck.
 */
export function renderDeck(markdown, { dir } = {}) {
  const marp = new Marp({ html: true, markdown: { breaks: true } })
  for (const css of themeSources(dir ? [join(dir, 'themes')] : [])) {
    try { marp.themeSet.add(css) } catch { /* a theme without an @theme line is skipped */ }
  }
  const { html, css, comments } = marp.render(markdown, { htmlAsArray: true })
  const slides = html.map((slideHtml, index) => {
    // marp-core appends its browser script to the last slide; it is not content, and its CSS
    // strings would otherwise read as images.
    const markup = slideHtml.replace(/<script[\s\S]*?<\/script>/g, '')
    const text = stripTags(markup).replace(/\s+/g, ' ').trim()
    const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(markup)
    return {
      index: index + 1,
      words: text ? text.split(' ').length : 0,
      title: heading ? stripTags(heading[1]).trim() : null,
      images: [...markup.matchAll(/(?:src|url\()=?["'(]?([^"')\s]+)/g)].map((m) => m[1]),
      notes: (comments[index] ?? []).join('\n'),
    }
  })
  return { html, css, slides }
}

/** Every local image the markdown refers to, as written. */
export function imageRefs(markdown) {
  const refs = new Set()
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) refs.add(m[1])
  for (const m of markdown.matchAll(/<img[^>]+src=["']([^"']+)["']/g)) refs.add(m[1])
  for (const m of markdown.matchAll(/backgroundImage:\s*url\(["']?([^"')]+)/g)) refs.add(m[1])
  return [...refs].filter((ref) => !/^(https?:|data:|\/\/)/i.test(ref))
}

/**
 * Judge a deck. Errors are what stops the deck being a deck (it does not render, an image is
 * missing, a slide is empty); warnings are craft (too much text, no title, too few slides).
 */
export function lintDeck(markdown, { dir }) {
  const findings = []
  const fm = frontMatter(markdown)
  if (!fm || !/^\s*marp:\s*true\s*$/m.test(fm)) {
    findings.push({ severity: 'warning', kind: 'front-matter', message: 'deck.md has no `marp: true` front matter; other Marp tools will treat it as plain Markdown' })
  }
  let rendered
  try {
    rendered = renderDeck(markdown, { dir })
  } catch (error) {
    findings.push({ severity: 'error', kind: 'render', message: `the deck does not render: ${error instanceof Error ? error.message : error}` })
    return { ready: false, findings, slides: [], html: [], css: '' }
  }
  const { slides, html, css } = rendered
  if (slides.length < MIN_SLIDES) {
    findings.push({ severity: 'warning', kind: 'length', message: `${slides.length} slide${slides.length === 1 ? '' : 's'} so far; a deck usually has at least ${MIN_SLIDES}` })
  }
  if (slides.length && !slides[0].title) {
    findings.push({ severity: 'warning', kind: 'title', message: 'the first slide has no heading; open with the talk\'s title', ref: 'slide 1' })
  }
  for (const slide of slides) {
    if (slide.words === 0 && slide.images.length === 0) {
      findings.push({ severity: 'error', kind: 'empty', message: `slide ${slide.index} is empty`, ref: `slide ${slide.index}` })
    } else if (slide.words > WORDS_PER_SLIDE) {
      findings.push({ severity: 'warning', kind: 'dense', message: `slide ${slide.index} carries ${slide.words} words; over ${WORDS_PER_SLIDE} reads as a page, not a slide`, ref: `slide ${slide.index}` })
    }
  }
  const refs = imageRefs(markdown)
  for (const ref of refs) {
    const file = resolve(dir, decodeURIComponent(ref.split('#')[0].split('?')[0]))
    if (!existsSync(file) || !statSync(file).isFile()) {
      findings.push({ severity: 'error', kind: 'image', message: `image ${ref} is not in the workspace`, ref })
    }
  }
  const remoteImages = (markdown.match(/!\[[^\]]*\]\(\s*<?https?:/g) ?? []).length
  if (slides.length >= MIN_SLIDES && refs.length + remoteImages === 0) {
    findings.push({ severity: 'warning', kind: 'imagery', message: 'no images in the deck; a keynote shows, it does not only tell — `art.mjs` makes wallpapers, charts and device frames offline' })
  }
  const errors = findings.filter((f) => f.severity === 'error').length
  return { ready: errors === 0 && slides.length >= MIN_SLIDES, findings, slides, html, css }
}

/**
 * Where a deck is, read off the deck itself: an outline is headings; a draft is bodies under them;
 * polish is a deck the check has nothing left to say about. Three phases the pane header can show.
 */
export function deckPhases(lint) {
  const n = lint.slides.length
  const drafted = lint.slides.filter((s) => s.words > (s.title ? s.title.split(' ').length : 0) + 2 || s.images.length).length
  const outlined = n >= MIN_SLIDES
  const drafting = outlined && drafted < n
  const drafted_all = outlined && drafted >= n
  const warnings = lint.findings.filter((f) => f.severity === 'warning').length
  const errors = lint.findings.filter((f) => f.severity === 'error').length
  return [
    { id: 'outline', name: 'Outline', state: outlined ? 'done' : 'active' },
    { id: 'draft', name: 'Draft', state: !outlined ? 'pending' : drafting ? 'active' : 'done' },
    { id: 'polish', name: 'Polish', state: !drafted_all ? 'pending' : errors ? 'failed' : warnings ? 'active' : 'done' },
  ]
}

/** The spec-1 verdict for a deck file, and write it beside the workspace's other state. */
export function writeVerdict(workspace, deckFile, lint) {
  const errors = lint.findings.filter((f) => f.severity === 'error').length
  const warnings = lint.findings.filter((f) => f.severity === 'warning').length
  const n = lint.slides.length
  const summary = lint.ready
    ? `${n} slides, ready to present${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
    : errors
      ? `${errors} error${errors === 1 ? '' : 's'} · ${n} slide${n === 1 ? '' : 's'}`
      : `${n} slide${n === 1 ? '' : 's'} so far${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
  const verdict = {
    spec: 1,
    ready: lint.ready,
    summary,
    findings: lint.findings,
    artifact: deckFile,
    phases: deckPhases(lint),
    slides: n,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  writeFileSync(join(workspace, '.harness', 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n')
  return verdict
}

export function readDeck(workspace, deckFile) {
  return readFileSync(join(workspace, deckFile), 'utf8')
}
