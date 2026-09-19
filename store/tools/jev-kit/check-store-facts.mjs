#!/usr/bin/env node
// check-store-facts.mjs — a dependency-free mirror of the store's strict rules for a Jev harness's
// harness.json and store.json (cli/src/dsh/registry.ts, StoreFactsSchema), plus the README and
// LICENSE rules from cli/src/dsh/store.spec.ts. Run it before committing:
//
//   node store/tools/jev-kit/check-store-facts.mjs            every store/agents/jev-* folder
//   node store/tools/jev-kit/check-store-facts.mjs jev-fps    just these
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const agents = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'agents')
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(agents).filter((n) => n.startsWith('jev-'))
const isUrl = (s) => { try { new URL(s); return true } catch { return false } }
let bad = 0

for (const name of names.sort()) {
  const dir = join(agents, name), problems = []
  const need = (ok, msg) => { if (!ok) problems.push(msg) }
  try {
    const m = JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8'))
    need(m.id === `autonomous/${name}`, `harness.json id must be autonomous/${name}`)
    need(typeof m.name === 'string' && m.name.length >= 1 && m.name.length <= 40, 'harness.json name must be 1..40 chars')
    need(typeof m.description === 'string' && m.description.length <= 300, `harness.json description is ${m.description?.length} chars (max 300)`)
    need(typeof m.category === 'string' && m.category.length <= 24, 'harness.json category must be <= 24 chars')
    const f = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
    const allowed = ['homepage', 'upstream', 'license', 'tagline', 'screenshots', 'examples']
    for (const k of Object.keys(f)) need(allowed.includes(k), `store.json has an unknown key "${k}"`)
    for (const k of ['homepage', 'upstream']) if (f[k] !== undefined) need(isUrl(f[k]), `store.json ${k} must be a URL`)
    need(f.tagline === undefined || (f.tagline.length >= 1 && f.tagline.length <= 80), `store.json tagline is ${f.tagline?.length} chars (max 80)`)
    need(f.screenshots === undefined || (Array.isArray(f.screenshots) && f.screenshots.length <= 8 && f.screenshots.every(isUrl)), 'store.json screenshots must be up to 8 URLs')
    need(f.examples === undefined || (Array.isArray(f.examples) && f.examples.length <= 8), 'store.json examples must be a list of up to 8')
    for (const [i, e] of (f.examples ?? []).entries()) {
      for (const k of Object.keys(e)) need(['prompt', 'image', 'caption'].includes(k), `examples[${i}] has an unknown key "${k}"`)
      need(typeof e.prompt === 'string' && e.prompt.trim().length >= 1 && e.prompt.trim().length <= 600, `examples[${i}].prompt is ${e.prompt?.length} chars (1..600)`)
      need(e.caption === undefined || (e.caption.trim().length >= 1 && e.caption.trim().length <= 120), `examples[${i}].caption is ${e.caption?.length} chars (max 120)`)
      if (e.image !== undefined) {
        need(isUrl(e.image) && e.image.startsWith('https://'), `examples[${i}].image must be an https URL`)
        const local = e.image.match(/\/store\/showcase\/(.+)$/)
        if (local) need(existsSync(join(agents, '..', 'showcase', local[1])), `examples[${i}].image points at store/showcase/${local[1]}, which does not exist`)
      }
    }
    need(existsSync(join(dir, 'LICENSE')), 'LICENSE is missing')
    need(/Credit and stewardship/.test(readFileSync(join(dir, 'README.md'), 'utf8')), 'README.md needs the heading "Credit and stewardship"')
  } catch (e) { problems.push(e.message) }
  if (problems.length) { bad++; console.log(`FAIL ${name}`); for (const p of problems) console.log(`     ${p}`) } else console.log(`ok   ${name}`)
}
console.log(bad ? `${bad} harness(es) would fail the store's tests` : 'every harness passes the store-facts rules')
process.exit(bad ? 1 : 0)
