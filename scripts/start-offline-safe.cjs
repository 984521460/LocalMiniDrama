'use strict';
const path = require('node:path');
const { startupFromEnvironment, resolveStartup } = require('../backend-node/src/startup/startupPolicy');
const startup = startupFromEnvironment({ ...process.env, LMD_STARTUP_MODE: 'offline-safe' });
const policy = resolveStartup(startup);
// Explicit validation precedes application loading, config fallback and DB selection.
const { createApp } = require('../backend-node/src/app');
const { closeDb } = require('../backend-node/src/db');
const application = createApp({ startup });
const server = application.app.listen(policy.config.server.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ mode: 'offline-safe', pid: process.pid, host: '127.0.0.1', port: server.address().port }));
});
server.on('error', (error) => { closeDb(); console.error(error.code || 'SAFE_LISTEN_FAILED'); process.exitCode = 1; });
function close() { server.close(() => { closeDb(); process.exit(0); }); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
