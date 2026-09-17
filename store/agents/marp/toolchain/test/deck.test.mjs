// `node --test toolchain/test` — the lint and the phases, on decks small enough to read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintDeck, deckPhases, renderDeck, imageRefs, writeVerdict, WORDS_PER_SLIDE, THEMES_DIR } from '../lib/deck.mjs'
import { wallpaper, chart, frame } from '../art.mjs'
import { readdirSync } from 'node:fs'

const fm = '---\nmarp: true\n---\n'

test('renders one html string per slide and counts only the words a person reads', () => {
  const { html, slides } = renderDeck(fm + '# Title\n\nOne line.\n\n---\n\n## Two\n\n- a\n- b\n')
  assert.equal(html.length, 2)
  assert.equal(slides[0].title, 'Title')
  assert.equal(slides[0].words, 3)
  assert.equal(slides[1].words, 3)
})

test('an outline is headings; a draft has bodies; polish is a deck the check has nothing to say about', () => {
  const outline = fm + '# T\n\n---\n\n## A\n\n---\n\n## B\n\n---\n\n## C\n'
  assert.deepEqual(deckPhases(lintDeck(outline, { dir: '.' })).map((p) => p.state), ['done', 'active', 'pending'])
  const twoSlides = fm + '# T\n\nA body with several words in it.\n\n---\n\n## A\n\nA body with several words in it.\n'
  assert.deepEqual(deckPhases(lintDeck(twoSlides, { dir: '.' })).map((p) => p.state), ['active', 'pending', 'pending'])
  const body = 'A body with several words in it.'
  const dir = mkdtempSync(join(tmpdir(), 'marp-art-'))
  try {
    writeFileSync(join(dir, 'bg.svg'), wallpaper({ seed: 1 }))
    const full = fm + `# T\n\n![bg](bg.svg)\n\n${body}\n\n---\n\n## A\n\n${body}\n\n---\n\n## B\n\n${body}\n`
    const lint = lintDeck(full, { dir })
    assert.equal(lint.ready, true)
    assert.deepEqual(deckPhases(lint).map((p) => p.state), ['done', 'done', 'done'])
    // the same deck without its picture is ready but not polished
    const bare = lintDeck(full.replace('![bg](bg.svg)\n\n', ''), { dir })
    assert.equal(bare.ready, true)
    assert.ok(bare.findings.some((f) => f.kind === 'imagery' && f.severity === 'warning'))
    assert.deepEqual(deckPhases(bare).map((p) => p.state), ['done', 'done', 'active'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the keynote themes are registered for the renderer and each declares its class set', () => {
  const themes = readdirSync(THEMES_DIR).filter((n) => n.endsWith('.css'))
  assert.deepEqual(themes.sort(), ['keynote-dark.css', 'keynote-light.css'])
  for (const theme of ['keynote-dark', 'keynote-light']) {
    const { css, html } = renderDeck(`---\nmarp: true\ntheme: ${theme}\n---\n\n<!-- _class: hero -->\n# Hi\n`)
    for (const cls of ['hero', 'statement', 'section', 'pillars', 'image', 'number', 'chart', 'quote', 'closing', 'omt']) {
      assert.ok(css.includes(`section.${cls}`), `${theme} lacks .${cls}`)
    }
    assert.ok(html[0].includes('class="hero"'), 'the class reaches the slide')
  }
  // a workspace can bring its own theme beside the deck
  const dir = mkdtempSync(join(tmpdir(), 'marp-theme-'))
  try {
    mkdirSync(join(dir, 'themes'))
    writeFileSync(join(dir, 'themes', 'mine.css'), '/* @theme mine */\nsection { background: rebeccapurple; }\n')
    const { css } = renderDeck('---\nmarp: true\ntheme: mine\n---\n\n# Hi\n', { dir })
    assert.ok(css.includes('rebeccapurple'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('art is deterministic svg: a wallpaper per seed, a chart from data, a frame around a picture', () => {
  const a = wallpaper({ palette: 'aurora', seed: 7 }), b = wallpaper({ palette: 'aurora', seed: 7 }), c = wallpaper({ palette: 'aurora', seed: 8 })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(a.startsWith('<svg') && a.includes('feGaussianBlur'))
  assert.ok(wallpaper({ palette: 'nope', seed: 1 }).includes('#5e5ce6'), 'an unknown palette is aurora')
  const bar = chart({ data: '2023:12, 2024:31,2025:64', label: 'Teams' })
  assert.equal((bar.match(/<rect/g) ?? []).length, 3)
  assert.ok(bar.includes('TEAMS') && bar.includes('>64<'))
  const line = chart({ data: 'a:1,b:2', type: 'line' })
  assert.ok(line.includes('<path') && (line.match(/<circle/g) ?? []).length === 2)
  assert.throws(() => chart({ data: '' }), /--data/)
  const dir = mkdtempSync(join(tmpdir(), 'marp-frame-'))
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    for (const kind of ['phone', 'laptop', 'window']) {
      const svg = frame({ image: join(dir, 'shot.png'), kind })
      assert.ok(svg.includes('data:image/png;base64,iVBORw==') && svg.includes('clip-path="url(#screen)"'), kind)
    }
    assert.throws(() => frame({ image: join(dir, 'missing.png') }), /--image/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the template deck is a polished keynote out of the box', () => {
  const dir = join(THEMES_DIR, '..', 'template')
  const lint = lintDeck(readFileSync(join(dir, 'deck.md'), 'utf8'), { dir })
  assert.equal(lint.ready, true, JSON.stringify(lint.findings))
  assert.deepEqual(deckPhases(lint).map((p) => p.state), ['done', 'done', 'done'])
  assert.ok(lint.slides.every((s) => s.words <= 30), 'a keynote slide is short')
})

test('errors are what stops a deck being a deck; warnings are craft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marp-deck-'))
  try {
    writeFileSync(join(dir, 'here.png'), 'x')
    const md = fm + '# T\n\n![w:100](here.png)\n\n---\n\n## Gone\n\n![](missing.png)\n\n---\n\n' +
      '## Dense\n\n' + Array.from({ length: WORDS_PER_SLIDE + 5 }, (_, i) => `w${i}`).join(' ') + '\n\n---\n\n\n'
    const lint = lintDeck(md, { dir })
    const kinds = lint.findings.map((f) => `${f.severity}:${f.kind}`)
    assert.ok(kinds.includes('error:image'), kinds.join(','))
    assert.ok(kinds.includes('warning:dense'), kinds.join(','))
    assert.ok(kinds.includes('error:empty'), kinds.join(','))
    assert.equal(lint.ready, false)
    assert.deepEqual(imageRefs(md), ['here.png', 'missing.png'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no front matter is a warning, not an error, and http images are not checked', () => {
  const lint = lintDeck('# T\n\nBody.\n\n---\n\n## A\n\n![](https://example.com/x.png)\n\n---\n\n## B\n\nBody.\n', { dir: '.' })
  assert.ok(lint.findings.some((f) => f.kind === 'front-matter' && f.severity === 'warning'))
  assert.ok(!lint.findings.some((f) => f.kind === 'image'))
})

test('the verdict is spec 1 with the deck as its artifact and the phases in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marp-ws-'))
  try {
    const body = 'A body with several words in it.'
    const lint = lintDeck(fm + `# T\n\n${body}\n\n---\n\n## A\n\n${body}\n\n---\n\n## B\n\n${body}\n`, { dir })
    const verdict = writeVerdict(dir, 'deck.md', lint)
    assert.equal(verdict.spec, 1)
    assert.equal(verdict.ready, true)
    assert.equal(verdict.artifact, 'deck.md')
    assert.deepEqual(verdict.phases.map((p) => p.id), ['outline', 'draft', 'polish'])
    assert.match(verdict.summary, /3 slides, ready/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
