// netlistsvg in a worker thread: ELK's layout is synchronous and can take seconds on a big module,
// and the server must keep answering the page (and its event stream) meanwhile.
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

parentPort.on('message', async ({ id, skin, netlist }) => {
  try {
    const lib = require('netlistsvg')
    const svg = await lib.render(skin, netlist)
    parentPort.postMessage({ id, svg })
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) })
  }
})
