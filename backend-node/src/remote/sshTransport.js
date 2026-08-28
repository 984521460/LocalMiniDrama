const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { Client, utils } = require('ssh2');

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/u;
const ALGORITHMS = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'rsa-sha2-256',
  'rsa-sha2-512',
  'ssh-rsa',
]);
const MESSAGES = Object.freeze({
  SSH_TRANSPORT_INPUT_INVALID: 'SSH transport input is invalid',
  SSH_HOST_KEY_INVALID: 'SSH host key is invalid',
  SSH_HOST_FINGERPRINT_MISMATCH: 'SSH host fingerprint does not match the confirmed identity',
  SSH_CONNECTION_FAILED: 'SSH connection failed',
  SSH_CONNECTION_TIMEOUT: 'SSH connection timed out',
  SSH_FORWARD_FAILED: 'SSH port forwarding failed',
  SSH_SFTP_FAILED: 'SSH SFTP session failed',
  SSH_EXEC_FAILED: 'SSH command failed',
});
const trustedErrors = new WeakSet();

class SshTransportError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.SSH_CONNECTION_FAILED);
    this.name = 'SshTransportError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'SSH_CONNECTION_FAILED';
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function createError(code) {
  return new SshTransportError(code);
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw createError('SSH_TRANSPORT_INPUT_INVALID');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function parseEndpoint(value) {
  const input = exactObject(value, ['host', 'port', 'username']);
  if (typeof input.host !== 'string' || input.host !== input.host.trim()
    || input.host.length > 253 || /[\s\0/@\\?#\[\]]/u.test(input.host)
    || input.host.includes('://') || typeof input.username !== 'string'
    || !USERNAME.test(input.username) || !Number.isInteger(input.port)
    || input.port < 1 || input.port > 65535) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  const host = input.host.toLowerCase();
  const ipv4 = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/u.test(host);
  const labels = host.split('.');
  if (!ipv4 && (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label)))) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  return Object.freeze({ host, port: input.port, username: input.username });
}

function parseExpectedFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  return value;
}

function hostIdentity(rawKey, parseHostKey) {
  if (!Buffer.isBuffer(rawKey) || rawKey.length < 1 || rawKey.length > 65536) {
    throw createError('SSH_HOST_KEY_INVALID');
  }
  let parsed;
  try {
    parsed = parseHostKey(rawKey);
  } catch {
    throw createError('SSH_HOST_KEY_INVALID');
  }
  if (!parsed || parsed instanceof Error || typeof parsed.type !== 'string'
    || !ALGORITHMS.has(parsed.type)) {
    throw createError('SSH_HOST_KEY_INVALID');
  }
  const digest = createHash('sha256').update(rawKey).digest('base64').replace(/=+$/u, '');
  return Object.freeze({ algorithm: parsed.type, fingerprint: `SHA256:${digest}` });
}

function validateOptions(options) {
  const input = exactObject(options, ['createClient', 'parseHostKey', 'timeoutMs']);
  if (typeof input.createClient !== 'function' || typeof input.parseHostKey !== 'function'
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120000) {
    throw createError('SSH_TRANSPORT_INPUT_INVALID');
  }
  return input;
}

function createSshSession(client) {
  let closed = false;
  return Object.freeze({
    exec(command) {
      if (closed || typeof command !== 'string' || command.length < 1 || command.length > 8192
        || command.includes('\0')) return Promise.reject(createError('SSH_TRANSPORT_INPUT_INVALID'));
      return new Promise((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error || !stream) reject(createError('SSH_EXEC_FAILED'));
          else resolve(stream);
        });
      });
    },

    forwardOut(sourceHost, sourcePort, destinationHost, destinationPort) {
      if (closed || sourceHost !== '127.0.0.1' || destinationHost !== '127.0.0.1'
        || !Number.isInteger(sourcePort) || sourcePort < 0 || sourcePort > 65535
        || !Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
        return Promise.reject(createError('SSH_TRANSPORT_INPUT_INVALID'));
      }
      return new Promise((resolve, reject) => {
        client.forwardOut(sourceHost, sourcePort, destinationHost, destinationPort, (error, stream) => {
          if (error || !stream) reject(createError('SSH_FORWARD_FAILED'));
          else resolve(stream);
        });
      });
    },

    sftp() {
      if (closed) return Promise.reject(createError('SSH_TRANSPORT_INPUT_INVALID'));
      return new Promise((resolve, reject) => {
        client.sftp((error, session) => {
          if (error || !session) reject(createError('SSH_SFTP_FAILED'));
          else resolve(session);
        });
      });
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        client.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          client.end();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    },
  });
}

function createSshTransport(options = {}) {
  const resolved = validateOptions({
    createClient: options.createClient || (() => new Client()),
    parseHostKey: options.parseHostKey || utils.parseKey,
    timeoutMs: options.timeoutMs || 15000,
  });

  async function probeHostIdentity(value) {
    const endpoint = parseEndpoint(value);
    const client = resolved.createClient();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { client.end(); } catch { /* bounded cleanup */ }
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(createError('SSH_CONNECTION_TIMEOUT')),
        resolved.timeoutMs,
      );
      timer.unref?.();
      client.once('error', () => finish(createError('SSH_CONNECTION_FAILED')));
      client.once('close', () => {
        if (!settled) finish(createError('SSH_CONNECTION_FAILED'));
      });
      try {
        client.connect({
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          readyTimeout: resolved.timeoutMs,
          hostVerifier(rawKey) {
            try {
              finish(null, hostIdentity(rawKey, resolved.parseHostKey));
            } catch (error) {
              finish(trustedErrors.has(error) ? error : createError('SSH_HOST_KEY_INVALID'));
            }
            return false;
          },
        });
      } catch {
        finish(createError('SSH_CONNECTION_FAILED'));
      }
    });
  }

  async function connect(value) {
    const input = exactObject(value, ['endpoint', 'expectedFingerprint', 'secret']);
    const endpoint = parseEndpoint(input.endpoint);
    const expectedFingerprint = parseExpectedFingerprint(input.expectedFingerprint);
    if (!Buffer.isBuffer(input.secret) || input.secret.length < 1 || input.secret.length > 2560) {
      throw createError('SSH_TRANSPORT_INPUT_INVALID');
    }
    const secret = input.secret;
    const client = resolved.createClient();
    return new Promise((resolve, reject) => {
      let settled = false;
      let fingerprintMismatch = false;
      let attemptedPassword = false;
      const finish = (error, session) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        secret.fill(0);
        if (error) {
          try { client.end(); } catch { /* bounded cleanup */ }
          reject(error);
        } else {
          resolve(session);
        }
      };
      const timer = setTimeout(
        () => finish(createError('SSH_CONNECTION_TIMEOUT')),
        resolved.timeoutMs,
      );
      timer.unref?.();
      client.once('ready', () => finish(null, createSshSession(client)));
      client.once('error', () => finish(createError(
        fingerprintMismatch ? 'SSH_HOST_FINGERPRINT_MISMATCH' : 'SSH_CONNECTION_FAILED',
      )));
      client.once('close', () => {
        if (!settled) finish(createError(
          fingerprintMismatch ? 'SSH_HOST_FINGERPRINT_MISMATCH' : 'SSH_CONNECTION_FAILED',
        ));
      });
      try {
        client.connect({
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          readyTimeout: resolved.timeoutMs,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          hostVerifier(rawKey) {
            try {
              fingerprintMismatch = hostIdentity(rawKey, resolved.parseHostKey).fingerprint
                !== expectedFingerprint;
              return !fingerprintMismatch;
            } catch {
              fingerprintMismatch = true;
              return false;
            }
          },
          authHandler(_methodsLeft, _partialSuccess, callback) {
            if (attemptedPassword) return callback(false);
            attemptedPassword = true;
            return callback({
              type: 'password',
              username: endpoint.username,
              password: secret,
            });
          },
        });
      } catch {
        finish(createError('SSH_CONNECTION_FAILED'));
      }
    });
  }

  return Object.freeze({ connect, probeHostIdentity });
}

module.exports = { SshTransportError, createSshTransport };
