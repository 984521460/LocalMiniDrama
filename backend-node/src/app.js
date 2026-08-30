const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getDb } = require('./db/index.js');
const { loadConfig } = require('./config/index.js');
const logger = require('./logger.js');
const { setupRouter } = require('./routes/index.js');
const { createProductionRemoteRuntime } = require('./remote/productionRuntime');
const { createProductionH3Runtime } = require('./h3/productionRuntime');
const { createProductionMediaExportRuntime } = require('./media/productionRuntime');
const { createH3ApiSubmissionStore } = require('./h3/apiSubmissionStore');
const { createV2Repositories } = require('./repositories/v2');
const { createWorkflowRunService } = require('./workflows');
const { createStartupRecoveryCoordinator } = require('./recovery/startupRecovery');

function createApp({
  remoteDependencies = {}, h3Dependencies = {}, mediaExportDependencies = {},
} = {}) {
  const config = loadConfig();
  const db = getDb(config.database);
  const { runMigrationsAndEnsure } = require('./db/migrate.js');
  runMigrationsAndEnsure(db);

  // 厂商锁定模式：在迁移完成后同步 vendor_lock 配置
  const { applyVendorLock } = require('./services/aiConfigService');
  applyVendorLock(db, logger, config);
  const log = logger;

  // 静态资源目录：统一转为绝对路径（打包 exe 下相对路径可能解析异常）
  const storageRoot = config.storage?.local_path
    ? (path.isAbsolute(config.storage.local_path)
        ? config.storage.local_path
        : path.join(process.cwd(), config.storage.local_path))
    : path.join(process.cwd(), 'data', 'storage');
  const mediaExportWorkspaceRoot = path.join(storageRoot, '.media-export-workspaces');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(mediaExportWorkspaceRoot, { recursive: true });
  const remoteRuntime = createProductionRemoteRuntime({
    database: db,
    localRoot: storageRoot,
    dependencies: remoteDependencies,
  });
  const h3Runtime = createProductionH3Runtime({
    database: db,
    storageBaseUrl: config.storage?.base_url || '',
    dependencies: h3Dependencies,
  });
  const mediaExportRuntime = createProductionMediaExportRuntime({
    database: db,
    localRoot: storageRoot,
    workspaceRoot: mediaExportWorkspaceRoot,
    dependencies: mediaExportDependencies,
  });
  const runtime = Object.freeze({
    ...remoteRuntime,
    h3: h3Runtime,
    ...mediaExportRuntime,
  });
  const taskService = require('./services/taskService');
  const { resumeProcessingVideoGenerations } = require('./services/videoService');
  const recoveryLog = Object.freeze({ info() {}, warn() {}, error() {} });
  const startupRecovery = createStartupRecoveryCoordinator({
    legacyAsyncTasks: Object.freeze({
      recover() {
        return Object.freeze({
          recoveredCount: taskService.failOrphanedAsyncTasksOnStartup(db, recoveryLog),
        });
      },
    }),
    legacyVideoGenerations: Object.freeze({
      recover() {
        const result = resumeProcessingVideoGenerations(db, recoveryLog);
        return Object.freeze({ recoveredCount: result.recoveredCount });
      },
    }),
    workflowRuns: createWorkflowRunService({ repositories: createV2Repositories(db) }),
    mediaExports: mediaExportRuntime.mediaExports.service,
    h3ApiSubmissions: createH3ApiSubmissionStore(db),
    remoteTasks: remoteRuntime.remoteExecution.remoteTasks,
    log,
  });
  const startupRecoveryPromise = startupRecovery.run();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    cors({
      origin: config.server.cors_origins && config.server.cors_origins.length
        ? config.server.cors_origins
        : '*',
    })
  );

  app.use((req, res, next) => {
    log.info(req.method, req.path);
    next();
  });

  try {
    if (!fs.existsSync(storageRoot)) fs.mkdirSync(storageRoot, { recursive: true });
    app.use('/static', express.static(storageRoot));
  } catch (e) {
    console.warn('Static storage mount skipped:', e.message);
  }

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      app: config.app.name,
      version: config.app.version,
    });
  });

  app.use('/api/v1', setupRouter(config, db, log, runtime));

  // 前端静态资源（sxy：web/dist）；Electron 打包时可设 WEB_DIST_PATH
  const webDist = process.env.WEB_DIST_PATH || path.join(process.cwd(), '..', 'frontweb', 'dist');
  console.log('webDist', webDist);
  if (fs.existsSync(webDist)) {
    app.use('/assets', express.static(path.join(webDist, 'assets')));
    // 服务 dist 根目录的静态文件（如 wx.jpg、favicon.ico 等）
    app.use(express.static(webDist, { index: false }));
    app.get('/favicon.ico', (req, res) => {
      const fav = path.join(webDist, 'favicon.ico');
      if (fs.existsSync(fav)) res.sendFile(fav);
      else res.status(404).end();
    });
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      const indexHtml = path.join(webDist, 'index.html');
      if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
      else next();
    });
  } else {
    app.get('/', (req, res) => {
      res.send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>LocalMiniDrama</title></head><body>' +
          '<h1>LocalMiniDrama API</h1><p>后端已启动。请先构建前端：</p>' +
          '<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>' +
          '<p>然后将 <code>web/dist</code> 放到与 backend-node 同级的 <code>web/dist</code>，或访问 <a href="/health">/health</a> 检查接口。</p></body></html>'
      );
    });
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.status(404).send('Not Found');
  });

  app.use((err, req, res, next) => {
    log.errorw('Unhandled error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      const isFileTooLarge = err.code === 'LIMIT_FILE_SIZE' || (err.message && err.message.includes('File too large'));
      const status = isFileTooLarge ? 413 : 500;
      const message = isFileTooLarge ? '图片大小不能超过 16MB，请压缩后重试' : (err.message || '服务器错误');
      res.status(status).json({ success: false, error: { code: isFileTooLarge ? 'FILE_TOO_LARGE' : 'INTERNAL_ERROR', message }, timestamp: new Date().toISOString() });
    }
  });

  return { app, config, db, runtime, startupRecovery, startupRecoveryPromise };
}

module.exports = { createApp };
