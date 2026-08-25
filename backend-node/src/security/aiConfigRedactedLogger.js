'use strict';

const {
  isSensitiveKey,
  redactAiConfigErrorText,
} = require('./aiConfigSecrets');

const LOG_METHODS = ['info', 'infow', 'warn', 'warnw', 'error', 'errorw'];

function redactLogValue(value, config, seen = new WeakSet()) {
  if (typeof value === 'string') return redactAiConfigErrorText(value, config);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((child) => redactLogValue(child, config, seen));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? '[redacted]' : redactLogValue(child, config, seen);
  }
  return result;
}

function createAiConfigRedactedLogger(log, config) {
  const adapter = {};
  for (const method of LOG_METHODS) {
    if (typeof log?.[method] !== 'function') continue;
    adapter[method] = (message, ...args) => log[method](
      redactAiConfigErrorText(message, config),
      ...args.map((value) => redactLogValue(value, config)),
    );
  }
  return adapter;
}

module.exports = { createAiConfigRedactedLogger, redactLogValue };
