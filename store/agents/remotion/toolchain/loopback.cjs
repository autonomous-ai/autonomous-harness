// Preloaded into Remotion Studio's process by viewer.mjs (NODE_OPTIONS=--require). Remotion 4 binds
// Studio to every interface ('::' or '0.0.0.0') and has no option to say otherwise, and webpack's
// lazy-compilation server inside it listens on a wildcard too; Studio can write files, so the pane
// keeps all of it on loopback: a TCP listen() with no host, or a wildcard host, becomes a listen()
// on 127.0.0.1. Nothing else about Remotion changes; a named host or a socket path is left alone.
'use strict'
const net = require('node:net')
const WILDCARD = new Set(['::', '0.0.0.0', '', undefined, null])
const LOOPBACK = '127.0.0.1'

function loopbackArgs(args) {
  const first = args[0]
  if (first === undefined || first === null || typeof first === 'function') {
    return [0, LOOPBACK, ...args.slice(first === undefined || first === null ? 1 : 0)]
  }
  if (typeof first === 'object' && !Array.isArray(first)) {
    if (first.path !== undefined || first.fd !== undefined || first.handle !== undefined || first._handle !== undefined) return args
    return WILDCARD.has(first.host) ? [{ ...first, host: LOOPBACK }, ...args.slice(1)] : args
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof args[1] === 'string' && !WILDCARD.has(args[1])) return args
    return typeof args[1] === 'string' ? [first, LOOPBACK, ...args.slice(2)] : [first, LOOPBACK, ...args.slice(1)]
  }
  return args // a pipe path
}

const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  return listen.apply(this, loopbackArgs(args))
}
module.exports = { loopbackArgs }
