import { defineConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// `node_modules` here is a symlink to the Harness package's one shared install, so Vite resolves
// Phaser to a real path outside this folder. Allow that folder, or the dev server 403s on it.
const allow = [resolve('.')];
try { allow.push(dirname(realpathSync('node_modules'))); } catch { /* standalone npm install */ }

export default defineConfig({
    base: './',
    // The prebundle cache belongs to the workspace: node_modules is shared with every other one.
    cacheDir: '.vite',
    server: {
        host: '127.0.0.1',
        // Harness passes --port; this is only the standalone `npm run dev` default.
        port: Number(process.env.HARNESS_VIEWER_PORT) || 8080,
        fs: { allow }
    },
    build: {
        outDir: 'out/dist',
        emptyOutDir: true,
        minify: 'terser',
        terserOptions: { compress: { passes: 2 }, mangle: true, format: { comments: false } },
        rollupOptions: { output: { manualChunks: { phaser: ['phaser'] } } }
    }
});
