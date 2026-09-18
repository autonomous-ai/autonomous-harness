/** Check the new feature's line coverage without disguising whole-app coverage.
 * Run flutter test --coverage test/orchestrator_test.dart test/orchestrator_controls_test.dart first. */
import { readFileSync } from 'node:fs'
const expected = new Set(['orchestrator_controller.dart', 'orchestrator_launcher.dart', 'orchestrator_workspace.dart'])
let covered = 0, total = 0
for (const record of readFileSync(process.argv[2] ?? 'coverage/lcov.info', 'utf8').split('end_of_record')) {
  const path = record.match(/SF:(.*)/)?.[1]
  if (!path?.includes('/orchestrator/')) continue
  const name = path.split('/').at(-1)
  if (!expected.delete(name)) continue
  const found = Number(record.match(/LF:(\d+)/)?.[1]), hit = Number(record.match(/LH:(\d+)/)?.[1])
  if (!found || hit !== found) throw new Error(`${name}: ${hit}/${found} lines, expected 100%`)
  total += found; covered += hit
}
if (expected.size) throw new Error(`Missing feature coverage: ${[...expected].join(', ')}`)
console.log(`Orchestrator desktop: ${covered}/${total} lines (100%) across 3 feature files. This is not whole-app coverage.`)
