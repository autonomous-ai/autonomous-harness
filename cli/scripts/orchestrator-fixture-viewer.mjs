// A real loopback viewer process, with deliberately non-CAD fixture output.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
createServer(async (_req, res) => {
  const text = await readFile(join(process.env.HARNESS_WORKSPACE, 'deliverable.txt'), 'utf8').catch(() => 'Waiting for the fixture specialist…')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<html><body style="font:18px system-ui;padding:24px"><h1>Orchestrator fixture viewer</h1><pre style="white-space:pre-wrap">${escape(text)}</pre></body></html>`)
}).listen(Number(process.env.HARNESS_VIEWER_PORT), '127.0.0.1')
