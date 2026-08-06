import * as esbuild from 'esbuild'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join } from 'path'

// Bake the version in so `node dist/cli.js version` works in the dev/per-file build too (parity with
// build-bundle.mjs). The bundle build overrides this from ADAPTER_VERSION at release time.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version

function getAllTsFiles(dir, fileList = []) {
  const files = readdirSync(dir)

  files.forEach((file) => {
    const filePath = join(dir, file)
    if (statSync(filePath).isDirectory()) {
      getAllTsFiles(filePath, fileList)
    } else if (file.endsWith('.ts')) {
      fileList.push(filePath)
    }
  })

  return fileList
}

const entryPoints = getAllTsFiles('src')

try {
  await esbuild.build({
    entryPoints,
    outdir: 'dist',
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    outExtension: { '.js': '.js' },
    define: { __ADAPTER_VERSION__: JSON.stringify(version) },
    logLevel: 'info',
  })

  console.log('✓ Build completed successfully')
} catch (error) {
  console.error('✗ Build failed:', error)
  process.exit(1)
}
