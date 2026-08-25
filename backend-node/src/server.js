const { loadConfig } = require('./config/index.js');
const { isInsecureTlsEnabled, resolveServerHost } = require('./config/serverSecurityDefaults');

const preConfig = loadConfig();
const insecureTlsOn = isInsecureTlsEnabled(preConfig.server);
if (insecureTlsOn) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[config] server.insecure_tls 已启用：全局跳过 TLS 证书校验，仅用于测试');
}

const { createApp } = require('./app.js');
const { closeDb } = require('./db/index.js');
const logger = require('./logger.js');

const { app, config } = createApp();
const port = Number(process.env.PORT) || config.server?.port || 5679;
const host = resolveServerHost(config.server);

const server = app.listen(port, host, () => {
  logger.info('Server starting', { port, host });
  logger.info('Frontend:  http://localhost:' + port);
  logger.info('API:       http://localhost:' + port + '/api/v1');
  logger.info('Health:    http://localhost:' + port + '/health');
  logger.info('Server is ready!');
});

function shutdown() {
  logger.info('Shutting down server...');
  server.close(() => {
    closeDb();
    logger.info('Server exited');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
