const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { PRODUCT_NAME } = require('./product-identity');
const { formatStartupError } = require('./startup-error');
const { resolveUserDataPath } = require('./user-data-path');
const { resolvePackagingSmokeAppData } = require('./windows-release-contract');
const { createBoundedLogWriter } = require('./bounded-log-file');

// 显式固定 userData 目录，使开发模式与打包 exe 路径完全一致，防止 productName 变更导致路径漂移
// 迁移必须早于日志目录创建，否则空的新目录会掩盖旧版数据。
const startupAppDataPath = resolvePackagingSmokeAppData({
  env: process.env,
  defaultPath: app.getPath('appData'),
});
const userDataResolution = resolveUserDataPath({ appDataPath: startupAppDataPath });
const USERDATA_DIR = userDataResolution.path;
app.setPath('userData', USERDATA_DIR);

const MAIN_STARTUP_LOG = path.join(USERDATA_DIR, 'main-startup.log');
const mainLogWriter = createBoundedLogWriter({
  filePath: MAIN_STARTUP_LOG,
  maxLineBytes: 16 * 1024,
  maxFileBytes: 1024 * 1024,
  maxBackups: 2,
});
function writeMainLog(msg) {
  const text = typeof msg === 'string' ? msg.slice(0, 8 * 1024) : 'invalid startup log event';
  try {
    mainLogWriter.write(`${new Date().toISOString()} ${text}`);
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  writeMainLog(`uncaughtException: ${formatStartupError(err).text}`);
});
process.on('unhandledRejection', (reason) => {
  writeMainLog(`unhandledRejection: ${formatStartupError(reason).text}`);
});

writeMainLog(`main.js loaded packaged=${app.isPackaged}`);
if (userDataResolution.migratedFrom) {
  writeMainLog('legacy user data migrated to the stable application directory');
}
if (userDataResolution.migrationError) {
  writeMainLog(`legacy user data migration deferred: ${formatStartupError(userDataResolution.migrationError).text}`);
}

const BACKEND_APP_PATH = path.join(__dirname, 'backend-app');
const BACKEND_NODE_PATH = path.join(__dirname, '..', 'backend-node');
const DEFAULT_PORT = 5679;

let serverInstance = null;

function isPackagingSmoke(env) {
  return env.LOCALMINIDRAMA_PACKAGING_SMOKE === '1';
}

function exitPackagingSmoke() {
  writeMainLog('packaging-smoke-ready');
  if (serverInstance) {
    try {
      if (typeof serverInstance.closeAllConnections === 'function') {
        serverInstance.closeAllConnections();
      }
      serverInstance.close();
    } catch (_) {}
    serverInstance = null;
  }
  app.exit(0);
}

/** 开发模式用 backend-node（改代码即生效）；打包后用 backend-app */
function getBackendModulePath() {
  if (app.isPackaged) return BACKEND_APP_PATH;
  // Electron 开发模式必须用 backend-app：require 会向上解析到 desktop/node_modules，
  // 其中 better-sqlite3 已由 postinstall 的 electron-builder install-app-deps 对准当前 Electron ABI。
  // 若直接用 backend-node，则会加载 backend-node/node_modules（多为本机 Node 编的 ABI，必炸）。
  if (process.versions.electron && fs.existsSync(path.join(BACKEND_APP_PATH, 'src', 'app.js'))) {
    return BACKEND_APP_PATH;
  }
  return fs.existsSync(BACKEND_NODE_PATH) ? BACKEND_NODE_PATH : BACKEND_APP_PATH;
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'backend');
  }
  return getBackendModulePath();
}

function ensureBackendCwd(backendCwd) {
  if (!fs.existsSync(backendCwd)) {
    fs.mkdirSync(backendCwd, { recursive: true });
  }
  const configsDir = path.join(backendCwd, 'configs');
  const dataDir = path.join(backendCwd, 'data');
  const logsDir = path.join(backendCwd, 'logs');
  const configPath = path.join(configsDir, 'config.yaml');

  if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  // 首次安装时，从打包内置的 config.yaml 复制到用户数据目录
  const bundledConfig = path.join(getBackendModulePath(), 'configs', 'config.yaml');
  if (!fs.existsSync(configPath) && fs.existsSync(bundledConfig)) {
    fs.copyFileSync(bundledConfig, configPath);
  }

  // 每次启动时，将内置 config.yaml 中的 vendor_lock 节强制同步到用户 config.yaml，
  // 确保打包时配置的锁定策略对所有用户生效，不受首次安装后遗留旧配置影响。
  if (fs.existsSync(bundledConfig) && fs.existsSync(configPath)) {
    try {
      const yaml = require('js-yaml');
      const userCfg = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      const bundledCfg = yaml.load(fs.readFileSync(bundledConfig, 'utf8')) || {};
      if (bundledCfg.vendor_lock !== undefined) {
        userCfg.vendor_lock = bundledCfg.vendor_lock;
        fs.writeFileSync(configPath, yaml.dump(userCfg, { lineWidth: -1 }), 'utf8');
      }
    } catch (e) {
      console.warn('[config] Failed to sync vendor_lock from bundled config:', e.message);
    }
  }
}

function getWebDistPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'frontweb', 'dist');
  }
  return path.join(__dirname, '..', 'frontweb', 'dist');
}

/**
 * 探测端口是否空闲：优先使用 preferredPort，被占用时让 OS 分配一个随机空闲端口。
 * 返回最终可用的端口号。
 */
function findFreePort(preferredPort) {
  const net = require('net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      // 首选端口被占，让 OS 随机分配
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferredPort, '127.0.0.1', () => {
      probe.close(() => resolve(preferredPort));
    });
  });
}

function createWindow(port) {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });
  win.once('ready-to-show', () => {
    win.show();
    writeMainLog('window ready-to-show');
  });
  // 若页面长期不触发 ready-to-show，避免用户误以为“点了没反应”
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      writeMainLog('window shown (fallback timeout, check page load)');
    }
  }, 8000);
  win.webContents.on('did-fail-load', (_e, code) => {
    writeMainLog(`did-fail-load code=${Number.isInteger(code) ? code : 'unknown'}`);
  });
  writeMainLog(`createWindow loadURL http://127.0.0.1:${port}`);
  win.loadURL(`http://127.0.0.1:${port}`);
  win.on('closed', () => app.quit());
  if (process.env.LOCALMINIDRAMA_DEVTOOLS === '1') {
    win.webContents.openDevTools();
  }
}

/** 后端始终在主进程内运行（打包用子进程会重复启动 exe 导致大量进程，故取消） */
async function startBackend() {
  const backendCwd = getBackendCwd();
  ensureBackendCwd(backendCwd);
  process.env.WEB_DIST_PATH = getWebDistPath();
  if (app.isPackaged) {
    process.env.LOG_FILE = path.join(backendCwd, 'logs', 'app.log');
  } else {
    process.env.EXAMPLE_DRAMA_PATH = path.join(__dirname, '..', 'example_drama');
  }
  process.chdir(backendCwd);

  const backendModulePath = getBackendModulePath();
  try {
    require(path.join(backendModulePath, 'src', 'db', 'migrate.js'));
  } catch (err) {
    console.warn('Migration warning:', err.message);
  }

  const { createApp } = require(path.join(backendModulePath, 'src', 'app.js'));
  const { createServer } = require('http');
  const { app: expressApp, config } = createApp();
  const preferredPort = config.server?.port || DEFAULT_PORT;

  // 自动探测空闲端口：优先默认端口，被占时由 OS 分配，支持多实例同时运行
  const port = await findFreePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} in use, using ${port}`);
  }

  return new Promise((resolve, reject) => {
    const server = createServer(expressApp);
    serverInstance = server;
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log('Backend listening on', port);
      resolve(port);
    });
  });
}

app.whenReady().then(async () => {
  writeMainLog('app.whenReady');
  let port;
  try {
    port = await startBackend();
    writeMainLog(`startBackend ok port=${port}`);
  } catch (err) {
    const safeError = formatStartupError(err);
    writeMainLog(`Failed to start backend\n${safeError.text}`);
    console.error('Failed to start backend', safeError.text);
    if (isPackagingSmoke(process.env)) {
      app.exit(1);
      return;
    }
    const { dialog } = require('electron');
    dialog.showErrorBox(
      `${PRODUCT_NAME}启动失败`,
      `后端服务未能启动，请查看应用用户数据目录中的 main-startup.log。\n\n${safeError.text}`
    );
    app.quit();
    return;
  }
  // startBackend 的 Promise 在 listen 回调中 resolve，服务器此时已就绪，直接建窗口
  if (isPackagingSmoke(process.env)) {
    exitPackagingSmoke();
    return;
  }
  createWindow(port);
});

app.on('before-quit', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});
