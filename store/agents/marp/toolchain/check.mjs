#!/usr/bin/env node
// `node toolchain/check.mjs [deck.md]` — judge the deck in the current workspace and write
// .harness/verdict.json. Prints the findings; exits 1 when the deck is not ready.
import { resolve, relative, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { lintDeck, readDeck, writeVerdict } from './lib/deck.mjs'

const workspace = process.env.HARNESS_WORKSPACE ? resolve(process.env.HARNESS_WORKSPACE) : process.cwd()
const arg = process.argv[2] ?? 'deck.md'
const deckFile = relative(workspace, resolve(workspace, arg)) || 'deck.md'
if (!existsSync(resolve(workspace, deckFile))) {
  console.error(`check: ${deckFile} is not in ${workspace}`)
  process.exit(2)
}
const lint = lintDeck(readDeck(workspace, deckFile), { dir: dirname(resolve(workspace, deckFile)) })
const verdict = writeVerdict(workspace, deckFile, lint)
console.log(`${verdict.ready ? 'ready' : 'not ready'} · ${verdict.summary}`)
for (const f of verdict.findings) console.log(`  ${f.severity.padEnd(7)} ${f.message}`)
process.exit(verdict.ready ? 0 : 1)
