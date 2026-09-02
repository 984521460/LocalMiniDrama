const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const {
  CredentialContractError,
  createCredentialRef,
  parseCredentialDescriptor,
  parseCredentialKind,
  parseCredentialRef,
} = require('@local-mini-drama/credential-vault');
const { CredentialBridgeError, PowerShellCredentialBridge } = require('./powershellCredentialBridge');

const MAX_SECRET_BYTES = 2560;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const trustedWindowsCredentialErrors = new WeakMap();
const WINDOWS_CREDENTIAL_MESSAGES = Object.freeze({
  CREDENTIAL_VALUE_INVALID: 'Credential vault input is invalid',
  CREDENTIAL_VAULT_IO_FAILED: 'Windows credential operation failed',
  CREDENTIAL_STORE_INDETERMINATE: 'Credential storage outcome requires cleanup by reference',
  CREDENTIAL_REFERENCE_CONFLICT: 'Credential reference already exists',
  CREDENTIAL_NOT_FOUND: 'Credential was not found',
});

class WindowsCredentialError extends Error {
  constructor(code, message, credentialRef) {
    super(message);
    this.name = 'WindowsCredentialError';
    this.code = code;
    if (credentialRef) this.credentialRef = credentialRef;
  }
}

function createWindowsCredentialError(code, credentialRef) {
  const safeCode = Object.hasOwn(WINDOWS_CREDENTIAL_MESSAGES, code)
    ? code
    : 'CREDENTIAL_VAULT_IO_FAILED';
  const message = WINDOWS_CREDENTIAL_MESSAGES[safeCode];
  const safeRef = credentialRef === undefined ? undefined : parseCredentialRef(credentialRef);
  const error = new WindowsCredentialError(safeCode, message, safeRef);
  trustedWindowsCredentialErrors.set(error, Object.freeze({ code: safeCode, credentialRef: safeRef }));
  return Object.freeze(error);
}

function getWindowsCredentialErrorCode(error) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return null;
  return trustedWindowsCredentialErrors.get(error)?.code ?? null;
}

function getWindowsCredentialErrorCredentialRef(error) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return null;
  return trustedWindowsCredentialErrors.get(error)?.credentialRef ?? null;
}

function invalidOptions(message = 'Credential vault input must be an exact data object') {
  void message;
  return createWindowsCredentialError('CREDENTIAL_VALUE_INVALID');
}

function readExactDataObject(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidOptions();
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw invalidOptions();
  }
  if (prototype !== Object.prototype && prototype !== null) throw invalidOptions();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw invalidOptions();

  const snapshot = Object.create(null);
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw invalidOptions();
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalidOptions();
    snapshot[key] = descriptor.value;
  }
  if (requiredKeys.some((key) => !Object.hasOwn(snapshot, key))) throw invalidOptions();
  return Object.freeze(snapshot);
}

function translateContractError(error) {
  const trusted = (
    (typeof error === 'object' || typeof error === 'function')
    && error !== null
  ) ? trustedWindowsCredentialErrors.get(error) : undefined;
  if (trusted) return createWindowsCredentialError(trusted.code, trusted.credentialRef);
  try {
    if (error instanceof CredentialContractError || error instanceof TypeError) return invalidOptions();
  } catch {
    return createWindowsCredentialError('CREDENTIAL_VAULT_IO_FAILED');
  }
  return createWindowsCredentialError('CREDENTIAL_VAULT_IO_FAILED');
}

function targetFromRef(ref) {
  const parsed = parseCredentialRef(ref);
  return `LocalMiniDrama/v1/${parsed.slice('credential:v1:'.length)}`;
}

function parseStoreInput(value) {
  const input = readExactDataObject(value, ['kind', 'secret']);
  const kind = parseCredentialKind(input.kind);
  if (typeof input.secret !== 'string' || input.secret.length === 0 || input.secret.includes('\0')) {
    throw invalidOptions('Credential secret must be non-empty text without NUL characters');
  }
  const secret = Buffer.from(input.secret, 'utf8');
  if (secret.byteLength === 0 || secret.byteLength > MAX_SECRET_BYTES) {
    secret.fill(0);
    throw invalidOptions('Credential secret exceeds the Windows credential size limit');
  }
  try {
    if (utf8Decoder.decode(secret) !== input.secret) {
      secret.fill(0);
      throw invalidOptions('Credential secret must be valid Unicode text');
    }
  } catch (error) {
    secret.fill(0);
    if (error instanceof WindowsCredentialError) throw error;
    throw invalidOptions('Credential secret must be valid Unicode text');
  }
  return { kind, secret };
}

function parseBridgeMetadata(value) {
  if (value === null) return null;
  const record = readExactDataObject(value, ['username']);
  return { kind: parseCredentialKind(record.username) };
}

function parseBridgeRecord(value) {
  if (value === null) return null;
  const record = readExactDataObject(value, ['username', 'secret']);
  const secretBuffer = record.secret;
  try {
    const kind = parseCredentialKind(record.username);
    if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length === 0 || secretBuffer.length > MAX_SECRET_BYTES) {
      throw invalidOptions('Credential bridge returned an invalid secret value');
    }
    const secret = utf8Decoder.decode(secretBuffer);
    if (secret.length === 0 || secret.includes('\0')) throw invalidOptions('Credential bridge returned an invalid secret value');
    return { kind, secret };
  } catch {
    throw invalidOptions('Credential bridge returned an invalid secret value');
  } finally {
    if (Buffer.isBuffer(secretBuffer)) secretBuffer.fill(0);
  }
}

async function verifyUncertainWriteRemoved(bridge, target) {
  const removed = await bridge.remove(target);
  if (removed !== true) return false;
  return parseBridgeMetadata(await bridge.inspect(target)) === null;
}

function isTerminationUnconfirmed(error) {
  try {
    return error instanceof CredentialBridgeError
      && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED';
  } catch {
    return false;
  }
}

class WindowsCredentialVault {
  #bridge;

  #createUuid;

  constructor(options) {
    const input = options === undefined
      ? Object.freeze({})
      : readExactDataObject(options, [], ['bridge', 'createUuid']);
    this.#bridge = input.bridge ?? new PowerShellCredentialBridge();
    this.#createUuid = input.createUuid ?? randomUUID;
    if (!this.#bridge || typeof this.#bridge !== 'object' || typeof this.#createUuid !== 'function') {
      throw invalidOptions('Credential vault dependencies are invalid');
    }
  }

  async store(value) {
    let parsed;
    let ref;
    let target;
    let writeAttempted = false;
    try {
      parsed = parseStoreInput(value);
      ref = createCredentialRef(this.#createUuid());
      target = targetFromRef(ref);
      const existing = parseBridgeMetadata(await this.#bridge.inspect(target));
      if (existing) {
        throw createWindowsCredentialError('CREDENTIAL_REFERENCE_CONFLICT');
      }
      writeAttempted = true;
      await this.#bridge.write(target, parsed.kind, parsed.secret);
      return parseCredentialDescriptor({ ref, kind: parsed.kind, configured: true });
    } catch (error) {
      if (writeAttempted && target && ref) {
        const terminationUnconfirmed = isTerminationUnconfirmed(error);
        let cleanupVerified = false;
        try {
          cleanupVerified = await verifyUncertainWriteRemoved(this.#bridge, target);
        } catch {
          cleanupVerified = false;
        }
        if (terminationUnconfirmed || !cleanupVerified) {
          throw createWindowsCredentialError('CREDENTIAL_STORE_INDETERMINATE', ref);
        }
      }
      throw translateContractError(error);
    } finally {
      parsed?.secret?.fill(0);
    }
  }

  async read(ref) {
    try {
      const parsedRef = parseCredentialRef(ref);
      const record = parseBridgeRecord(await this.#bridge.read(targetFromRef(parsedRef)));
      if (!record) throw createWindowsCredentialError('CREDENTIAL_NOT_FOUND');
      return record.secret;
    } catch (error) {
      throw translateContractError(error);
    }
  }

  async inspect(ref) {
    try {
      const parsedRef = parseCredentialRef(ref);
      const metadata = parseBridgeMetadata(await this.#bridge.inspect(targetFromRef(parsedRef)));
      if (!metadata) throw createWindowsCredentialError('CREDENTIAL_NOT_FOUND');
      return parseCredentialDescriptor({ ref: parsedRef, kind: metadata.kind, configured: true });
    } catch (error) {
      throw translateContractError(error);
    }
  }

  async remove(ref) {
    try {
      const parsedRef = parseCredentialRef(ref);
      const removed = await this.#bridge.remove(targetFromRef(parsedRef));
      if (typeof removed !== 'boolean') throw invalidOptions('Credential bridge returned an invalid removal result');
      return removed;
    } catch (error) {
      throw translateContractError(error);
    }
  }
}

module.exports = {
  getWindowsCredentialErrorCode,
  getWindowsCredentialErrorCredentialRef,
  WindowsCredentialError,
  WindowsCredentialVault,
};
