// Merge ONE key into the GCS metadata.json (download-merge-reupload), leaving other keys (e.g. the
// device `commander` entry) untouched. Paths/values come via argv so no stdin/pipe is claimed.
import { readFileSync, writeFileSync } from 'fs'

const [src, dst, key, version, cliUrl, cliSha, cliSize, notifyUrl, notifySha, notifySize] =
  process.argv.slice(2)

let data = {}
try {
  const raw = readFileSync(src, 'utf8')
  data = raw.trim() ? JSON.parse(raw) : {}
} catch {
  data = {}
}
if (typeof data !== 'object' || data === null || Array.isArray(data)) data = {}

data[key] = {
  version,
  cli: { url: cliUrl, sha256: cliSha, size: Number(cliSize) },
  notify: { url: notifyUrl, sha256: notifySha, size: Number(notifySize) },
}

writeFileSync(dst, JSON.stringify(data, null, 2) + '\n')
