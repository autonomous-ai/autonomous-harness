import * as esbuild from 'esbuild'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

function getAllTsFiles(dir, fileList = []) {
  for (const file of readdirSync(dir)) {
    const filePath = join(dir, file)
    if (statSync(filePath).isDirectory()) {
      getAllTsFiles(filePath, fileList)
    } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
      fileList.push(filePath)
    }
  }
  return fileList
}

try {
  await esbuild.build({
    entryPoints: getAllTsFiles('src'),
    outdir: 'dist',
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    outExtension: { '.js': '.js' },
    logLevel: 'info',
  })
  console.log('✓ Build completed successfully')
} catch (error) {
  console.error('✗ Build failed:', error)
  process.exit(1)
}
