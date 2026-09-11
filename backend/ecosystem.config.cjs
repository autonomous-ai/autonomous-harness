module.exports = {
  apps: [
    {
      name: 'backend-worker',
      script: 'dist/worker.js',
      exec_mode: 'fork',
      instances: 1,
      wait_ready: true,
      listen_timeout: 120000,
      kill_timeout: 6000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'backend',
      script: 'dist/server.js',
      exec_mode: 'cluster',
      instances: 'max',
      env: { NODE_ENV: 'production' },
    },
  ],
}
