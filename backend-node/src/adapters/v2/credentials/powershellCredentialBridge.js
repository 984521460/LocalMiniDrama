const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TARGET_PATTERN = /^LocalMiniDrama\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERNAME_PATTERN = /^(?:api_key|provider_token|ssh_password|ssh_key_passphrase)$/;
const MAX_OUTPUT_BYTES = 65536;

class CredentialBridgeError extends Error {
  constructor(code) {
    super('Windows credential bridge failed');
    this.name = 'CredentialBridgeError';
    this.code = code;
  }
}

function bridgeError(code = 'CREDENTIAL_BRIDGE_FAILED') {
  return new CredentialBridgeError(code);
}

function runPowerShell({ executable, args, input, timeoutMs, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationFailure = null;
    let timer = null;
    let terminationTimer = null;

    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearTimeout(terminationTimer);
        reject(error);
      }
    };

    const terminateAndWait = (code) => {
      if (terminationFailure || settled) return;
      terminationFailure = code;
      try {
        if (child.kill() === false) {
          rejectOnce(bridgeError('CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED'));
        } else {
          terminationTimer = setTimeout(() => {
            rejectOnce(bridgeError('CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED'));
          }, 2000);
        }
      } catch {
        rejectOnce(bridgeError('CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED'));
      }
    };

    timer = setTimeout(() => {
      terminateAndWait('CREDENTIAL_BRIDGE_TIMEOUT');
    }, timeoutMs);

    const collect = (chunks, limitKey, chunk) => {
      if (limitKey === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        terminateAndWait('CREDENTIAL_BRIDGE_OUTPUT_LIMIT');
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => collect(stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk) => collect(stderr, 'stderr', chunk));
    child.stdin.on('error', () => {
      // Process exit is handled through the stable close/error result below.
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (terminationFailure) {
        rejectOnce(bridgeError('CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED'));
      } else {
        rejectOnce(error);
      }
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (!settled) {
        settled = true;
        if (terminationFailure) {
          reject(bridgeError(terminationFailure));
          return;
        }
        resolve({
          code: Number.isInteger(code) ? code : -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      }
    });
    child.stdin.end(input, 'utf8');
  });
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  const snapshot = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    snapshot[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(snapshot, key))) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  return snapshot;
}

function validateTarget(target) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) throw bridgeError('CREDENTIAL_BRIDGE_VALUE_INVALID');
  return target;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) throw bridgeError('CREDENTIAL_BRIDGE_VALUE_INVALID');
  return username;
}

class PowerShellCredentialBridge {
  #platform;

  #scriptPath;

  #runProcess;

  #executable;

  constructor(options = {}) {
    const input = exactKeys(options, [], ['platform', 'scriptPath', 'runProcess', 'executable']);
    this.#platform = input.platform ?? process.platform;
    this.#scriptPath = input.scriptPath ?? path.join(__dirname, 'credential-bridge.ps1');
    this.#runProcess = input.runProcess ?? runPowerShell;
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    this.#executable = input.executable ?? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (
      typeof this.#platform !== 'string'
      || typeof this.#scriptPath !== 'string'
      || typeof this.#runProcess !== 'function'
      || typeof this.#executable !== 'string'
    ) {
      throw bridgeError('CREDENTIAL_BRIDGE_VALUE_INVALID');
    }
  }

  async #execute(payload) {
    if (this.#platform !== 'win32') throw bridgeError('CREDENTIAL_PLATFORM_UNSUPPORTED');
    if (this.#runProcess === runPowerShell && !fs.existsSync(this.#scriptPath)) {
      throw bridgeError('CREDENTIAL_BRIDGE_SCRIPT_MISSING');
    }
    let result;
    try {
      result = exactKeys(await this.#runProcess({
        executable: this.#executable,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#scriptPath],
        input: `${JSON.stringify(payload)}\n`,
        timeoutMs: 15000,
      }), ['code', 'stdout', 'stderr']);
    } catch (error) {
      if (error instanceof CredentialBridgeError) throw error;
      throw bridgeError();
    }
    if (
      !Number.isInteger(result.code)
      || typeof result.stdout !== 'string'
      || typeof result.stderr !== 'string'
      || result.code !== 0
      || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES
      || Buffer.byteLength(result.stderr, 'utf8') > MAX_OUTPUT_BYTES
    ) {
      throw bridgeError();
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    }
  }

  async write(target, username, secret) {
    validateTarget(target);
    validateUsername(username);
    if (!Buffer.isBuffer(secret) || secret.length === 0 || secret.length > 2560) {
      throw bridgeError('CREDENTIAL_BRIDGE_VALUE_INVALID');
    }
    const response = exactKeys(await this.#execute({
      action: 'write',
      target,
      username,
      secretBase64: secret.toString('base64'),
    }), ['ok']);
    if (response.ok !== true) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
  }

  async read(target) {
    validateTarget(target);
    const response = await this.#execute({ action: 'read', target });
    if (response?.found === false) {
      exactKeys(response, ['found']);
      return null;
    }
    const record = exactKeys(response, ['found', 'username', 'secretBase64']);
    if (record.found !== true) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    validateUsername(record.username);
    if (typeof record.secretBase64 !== 'string' || record.secretBase64.length > 3416) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    const secret = Buffer.from(record.secretBase64, 'base64');
    if (secret.length === 0 || secret.length > 2560 || secret.toString('base64') !== record.secretBase64) {
      secret.fill(0);
      throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    }
    return { username: record.username, secret };
  }

  async inspect(target) {
    validateTarget(target);
    const response = await this.#execute({ action: 'inspect', target });
    if (response?.found === false) {
      exactKeys(response, ['found']);
      return null;
    }
    const record = exactKeys(response, ['found', 'username']);
    if (record.found !== true) throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    return { username: validateUsername(record.username) };
  }

  async remove(target) {
    validateTarget(target);
    const response = exactKeys(await this.#execute({ action: 'remove', target }), ['removed']);
    if (typeof response.removed !== 'boolean') throw bridgeError('CREDENTIAL_BRIDGE_PROTOCOL_INVALID');
    return response.removed;
  }
}

module.exports = {
  CredentialBridgeError,
  PowerShellCredentialBridge,
  runPowerShell,
};
