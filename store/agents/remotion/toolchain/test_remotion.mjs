// $REMOTION's progress parsing, against the lines Remotion 4.0.525's CLI prints: node --test toolchain/test_remotion.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLine, shouldPrint } from './remotion.mjs'

test('reads the stages of a render', () => {
  assert.deepEqual(parseLine('Bundling 50%'), { stage: 'bundling', progress: 0.05 })
  assert.deepEqual(parseLine('Getting composition'), { stage: 'preparing' })
  assert.deepEqual(parseLine('\x1b[90mComposition          Main\x1b[39m'), { composition: 'Main' })
  assert.deepEqual(parseLine('\x1b[90mOutput               out/main.mp4\x1b[39m'), { output: 'out/main.mp4' })
  assert.deepEqual(parseLine('Rendered 30/60, time remaining: 1s'), { stage: 'rendering', frame: 30, frames: 60, remaining: '1s', progress: 0.5 })
  assert.deepEqual(parseLine('Rendered 0/60'), { stage: 'rendering', frame: 0, frames: 60, remaining: null, progress: 0.1 })
  assert.deepEqual(parseLine('Encoded 60/60'), { stage: 'encoding', frame: 60, frames: 60, progress: 1 })
  assert.deepEqual(parseLine('\x1b[34m+                    out/main.mp4\x1b[39m \x1b[90m391.6 kB\x1b[39m'), { output: 'out/main.mp4', stage: 'finishing', progress: 1 })
  assert.equal(parseLine('Cached bundle. Subsequent renders will be faster.'), null)
})

test('prints progress every tenth, and everything else always', () => {
  const last = {}
  const printed = []
  for (let i = 0; i <= 60; i++) if (shouldPrint(`Rendered ${i}/60`, last)) printed.push(i)
  assert.deepEqual(printed, [0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60])
  assert.equal(shouldPrint('Getting composition', last), true)
  assert.equal(shouldPrint('Encoded 60/60', last), true)
})

test('loopback.cjs keeps TCP listeners on 127.0.0.1 and leaves named hosts and pipes alone', async () => {
  const { createRequire } = await import('node:module')
  const { loopbackArgs } = createRequire(import.meta.url)('./loopback.cjs')
  const f = () => {}
  assert.deepEqual(loopbackArgs([]), [0, '127.0.0.1'])
  assert.deepEqual(loopbackArgs([undefined]), [0, '127.0.0.1'])
  assert.deepEqual(loopbackArgs([f]), [0, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([3000, f]), [3000, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([3000, '::', f]), [3000, '127.0.0.1', f])
  assert.deepEqual(loopbackArgs([{ port: 0 }]), [{ port: 0, host: '127.0.0.1' }])
  assert.deepEqual(loopbackArgs([3000, 'localhost']), [3000, 'localhost'])
  assert.deepEqual(loopbackArgs(['/tmp/remotion.sock']), ['/tmp/remotion.sock'])
  assert.deepEqual(loopbackArgs([{ path: '/tmp/remotion.sock' }]), [{ path: '/tmp/remotion.sock' }])
})
