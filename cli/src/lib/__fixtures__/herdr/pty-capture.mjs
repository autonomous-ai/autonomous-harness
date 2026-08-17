import { writeFileSync, writeSync } from 'node:fs'

const [outputPath, readyPath] = process.argv.slice(2)
if (!outputPath || !readyPath || !process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.exit(2)
}

process.stdin.setRawMode(true)
process.stdin.resume()
writeSync(1, '\u001b[?2004h')
writeFileSync(readyPath, 'ready', { mode: 0o600 })

const chunks = []
const deadline = setTimeout(() => process.exit(3), 10_000)

process.stdin.on('data', (chunk) => {
  chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks)
  const bracketedEnd = bytes.indexOf(Buffer.from('\u001b[201~'))
  if (bracketedEnd < 0 || bytes.indexOf(0x0d, bracketedEnd + 6) < 0) return
  clearTimeout(deadline)
  writeFileSync(outputPath, JSON.stringify({
    base64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
    bracketedStarts: bytes.toString('binary').split('\u001b[200~').length - 1,
    bracketedEnds: bytes.toString('binary').split('\u001b[201~').length - 1,
    carriageReturnsAfterPaste: [...bytes.subarray(bracketedEnd + 6)].filter((byte) => byte === 0x0d).length,
  }), { mode: 0o600 })
  writeSync(1, '\u001b[?2004l')
  process.exit(0)
})
