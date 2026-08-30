const {
  boundedPrimitiveText,
  boundedRedactedStringify,
} = require('./utils/redactSecrets');
const {
  DEFAULT_MAX_LINE_BYTES,
  boundedUtf8Line,
  createBoundedLogWriter,
} = require('./utils/boundedLogFile');

let cachedLogFile = null;
let cachedWriter = null;
const MAX_LOG_ARGUMENTS = 16;

function writerFor(logFile) {
  if (cachedLogFile === logFile) return cachedWriter;
  cachedLogFile = logFile;
  try {
    cachedWriter = createBoundedLogWriter({ filePath: logFile });
  } catch (_) {
    cachedWriter = null;
  }
  return cachedWriter;
}

// 简单 logger，和 Go 端行为接近；若设置 LOG_FILE 则同时追加到该文件（便于打包 exe 双击时查日志）
function log(level, msg, ...args) {
  const time = new Date().toISOString();
  let rest = '';
  if (args.length && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
    rest = ' ' + boundedRedactedStringify(args[0]);
  } else if (args.length) {
    const count = Math.min(args.length, MAX_LOG_ARGUMENTS);
    for (let index = 0; index < count; index += 1) {
      const arg = args[index];
      rest += ` ${typeof arg === 'object'
        ? boundedRedactedStringify(arg)
        : boundedPrimitiveText(arg)}`;
    }
    if (count < args.length) rest += ' [truncated]';
  }
  const line = `${time} [${level}] ${boundedPrimitiveText(msg)}${rest}`;
  const consoleLine = boundedUtf8Line(line, DEFAULT_MAX_LINE_BYTES).trimEnd();
  try {
    console.log(consoleLine);
  } catch (_) {}
  const logFile = process.env.LOG_FILE;
  if (logFile) {
    try {
      writerFor(logFile)?.write(line);
    } catch (_) {}
  }
}

module.exports = {
  info(msg, ...args) {
    log('INFO', msg, ...args);
  },
  infow(msg, ...args) {
    log('INFO', msg, ...args);
  },
  warn(msg, ...args) {
    log('WARN', msg, ...args);
  },
  warnw(msg, ...args) {
    log('WARN', msg, ...args);
  },
  error(msg, ...args) {
    log('ERROR', msg, ...args);
  },
  errorw(msg, ...args) {
    log('ERROR', msg, ...args);
  },
};
