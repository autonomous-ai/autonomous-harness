#!/usr/bin/env node
// Keep every Jev harness's copy of the shared Jev kit identical to store/tools/jev-kit/.
//
// A package installs alone (a sparse checkout of its own folder), so a Jev harness cannot import a
// file outside itself: each one carries its own copy of the kit files it uses.
//
//   node store/tools/sync-jev-kit.mjs            rewrite every copy from the canonical files
//   node store/tools/sync-jev-kit.mjs --check    exit 1, naming each copy that differs
//
// Which files a harness carries:
//   viewer/jev-hud.js      every Jev harness that has one (the "Jev live mind" panel)
//   viewer/kit.mjs, viewer/base.css, toolchain/jev.mjs
//                          only harnesses built on the kit, recognised by viewer/kit.mjs.
//                          (Older Jev harnesses keep their own jev.mjs, which carries their
//                          domain readers; they are not overwritten.)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const store = dirname(dirname(fileURLToPath(import.meta.url)))
const KIT = join(store, 'tools', 'jev-kit')
const ALWAYS = [['jev-hud.js', 'viewer/jev-hud.js']]
const KIT_BUILT = [['kit.mjs', 'viewer/kit.mjs'], ['base.css', 'viewer/base.css'], ['jev.mjs', 'toolchain/jev.mjs']]

export function plan(root = store) {
  const out = []
  const agents = join(root, 'agents')
  for (const e of readdirSync(agents, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('jev-')) continue
    const dir = join(agents, e.name)
    const files = existsSync(join(dir, 'viewer/kit.mjs')) ? [...ALWAYS, ...KIT_BUILT] : ALWAYS
    for (const [from, to] of files) if (existsSync(join(dir, to))) out.push({ from: join(KIT, from), to: join(dir, to) })
  }
  return out
}

export function check(root = store) {
  return plan(root).filter(({ from, to }) => readFileSync(from, 'utf8') !== readFileSync(to, 'utf8'))
    .map(({ from, to }) => `${relative(root, to)} differs from ${relative(root, from)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = check()
    for (const p of problems) console.log(p)
    console.log(problems.length ? `${problems.length} copies drifted. Run: node store/tools/sync-jev-kit.mjs` : 'every Jev kit copy is current')
    process.exit(problems.length ? 1 : 0)
  }
  let n = 0
  for (const { from, to } of plan()) {
    const want = readFileSync(from, 'utf8')
    if (readFileSync(to, 'utf8') !== want) { writeFileSync(to, want); n++; console.log('updated', relative(store, to)) }
  }
  console.log(n ? `${n} copies updated` : 'every Jev kit copy was already current')
}
