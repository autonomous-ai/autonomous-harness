import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/** The forwarding implementation has a per-file 100% coverage gate, including failure paths. */
export default defineConfig({
  test: {
    ...base.test,
    include: [
      'src/lib/viewerWire.spec.ts',
      'src/lib/viewerForwarder.spec.ts',
      'src/lib/remoteViewerProxy.spec.ts',
      'src/lib/remoteViewerProxy.faults.spec.ts',
      'src/lib/remoteViewerRelay.spec.ts',
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/lib/viewerWire.ts', 'src/lib/viewerForwarder.ts', 'src/lib/remoteViewerProxy.ts'],
      reporter: ['text', 'json-summary', 'json', 'html'],
      reportsDirectory: 'coverage/remote-viewers',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
