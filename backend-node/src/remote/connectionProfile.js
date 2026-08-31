const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL_REF = /^credential:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/u;
const WORK_DIR_SEGMENT = /^[A-Za-z0-9._-]{1,96}$/u;
const CONNECTION_STATUSES = new Set(['unverified', 'ready', 'changed', 'disabled', 'error']);
const JSON_STRINGIFY = JSON.stringify;
const REFLECT_APPLY = Reflect.apply;

function jsonString(value) {
  return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
}

function fail() {
  throw new TypeError('Remote connection value is invalid');
}

function ownDataSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactObject(value, required, optional = []) {
  const snapshot = ownDataSnapshot(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(snapshot);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(snapshot, key))) fail();
  return snapshot;
}

function codePointLength(value) {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function boundedTrimmedString(value, maxLength) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail();
  const length = codePointLength(value);
  if (length < 1 || length > maxLength) fail();
  return value;
}

function canonicalUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail();
  return value;
}

function credentialRef(value) {
  if (typeof value !== 'string' || !CREDENTIAL_REF.test(value)) fail();
  return value;
}

function host(value) {
  const candidate = boundedTrimmedString(value, 253).toLowerCase();
  if (/[\s\0/@\\?#\[\]]/u.test(candidate) || candidate.includes('://')) fail();
  const ipKind = isIP(candidate);
  if (ipKind === 4) return candidate;
  const labels = candidate.split('.');
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) fail();
  return candidate;
}

function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail();
  return value;
}

function username(value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) fail();
  return value;
}

function authMethod(value) {
  if (value !== 'password') fail();
  return value;
}

function secret(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail();
  const length = codePointLength(value);
  if (length < 1 || length > 1024) fail();
  return value;
}

function comfyHost(value) {
  if (value !== '127.0.0.1') fail();
  return value;
}

function remoteWorkDir(value) {
  const candidate = boundedTrimmedString(value, 256);
  if (candidate.startsWith('/') || candidate.endsWith('/') || candidate.includes('\\') || candidate.includes(':')) fail();
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !WORK_DIR_SEGMENT.test(segment))) fail();
  return candidate;
}

function stateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) fail();
  return value;
}

function optionalFingerprint(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !HOST_FINGERPRINT.test(value)) fail();
  return value;
}

function parseRemoteHostFingerprint(value) {
  return optionalFingerprint(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') fail();
  let normalized;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    fail();
  }
  if (normalized !== value) fail();
  return value;
}

function optionalEpoch(value) {
  if (value === null) return null;
  fail();
}

function optionalEnvironmentReport(value) {
  if (value === null) return null;
  fail();
}

function createRemoteConnectionRequest(value) {
  const input = exactObject(value, [
    'name',
    'host',
    'port',
    'username',
    'authMethod',
    'secret',
    'comfyHost',
    'comfyPort',
    'remoteWorkDir',
  ]);
  return Object.freeze({
    name: boundedTrimmedString(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    authMethod: authMethod(input.authMethod),
    secret: secret(input.secret),
    comfyHost: comfyHost(input.comfyHost),
    comfyPort: port(input.comfyPort),
    remoteWorkDir: remoteWorkDir(input.remoteWorkDir),
  });
}

function parseRemoteConnectionUid(value) {
  return canonicalUid(value);
}

function createRemoteConnectionUpdateRequest(value) {
  const input = exactObject(value, [
    'expectedStateVersion',
    'name',
    'host',
    'port',
    'username',
    'comfyHost',
    'comfyPort',
    'remoteWorkDir',
  ]);
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    name: boundedTrimmedString(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    comfyHost: comfyHost(input.comfyHost),
    comfyPort: port(input.comfyPort),
    remoteWorkDir: remoteWorkDir(input.remoteWorkDir),
  });
}

function createRemoteCredentialReplacementRequest(value) {
  const input = exactObject(value, ['expectedStateVersion', 'secret']);
  return Object.freeze({
    expectedStateVersion: stateVersion(input.expectedStateVersion),
    secret: secret(input.secret),
  });
}

function createRemoteConnectionRecord(value) {
  const input = exactObject(value, [
    'uid', 'name', 'host', 'port', 'username', 'hostFingerprint', 'credentialRef', 'status',
    'createdAt', 'updatedAt', 'authMethod', 'comfyHost', 'comfyPort', 'remoteWorkDir',
    'environmentReport', 'environmentCheckedAtEpochMs', 'stateVersion',
  ]);
  if (!CONNECTION_STATUSES.has(input.status)) fail();
  return Object.freeze({
    uid: canonicalUid(input.uid),
    name: boundedTrimmedString(input.name, 120),
    host: host(input.host),
    port: port(input.port),
    username: username(input.username),
    hostFingerprint: optionalFingerprint(input.hostFingerprint),
    credentialRef: credentialRef(input.credentialRef),
    status: input.status,
    createdAt: canonicalTimestamp(input.createdAt),
    updatedAt: canonicalTimestamp(input.updatedAt),
    authMethod: authMethod(input.authMethod),
    comfyHost: comfyHost(input.comfyHost),
    comfyPort: port(input.comfyPort),
    remoteWorkDir: remoteWorkDir(input.remoteWorkDir),
    environmentReport: optionalEnvironmentReport(input.environmentReport),
    environmentCheckedAtEpochMs: optionalEpoch(input.environmentCheckedAtEpochMs),
    stateVersion: stateVersion(input.stateVersion),
  });
}

function remoteConnectionEvidenceSha256(value) {
  const persisted = createRemoteConnectionRecord(value);
  const evidence = '{'
    + `"contractVersion":"remote-connection-evidence.v1",`
    + `"uid":${jsonString(persisted.uid)},`
    + `"stateVersion":${persisted.stateVersion},`
    + `"status":${jsonString(persisted.status)},`
    + `"host":${jsonString(persisted.host)},`
    + `"port":${persisted.port},`
    + `"username":${jsonString(persisted.username)},`
    + `"hostFingerprint":${persisted.hostFingerprint === null ? 'null' : jsonString(persisted.hostFingerprint)},`
    + `"authMethod":${jsonString(persisted.authMethod)},`
    + `"comfyHost":${jsonString(persisted.comfyHost)},`
    + `"comfyPort":${persisted.comfyPort},`
    + `"remoteWorkDir":${jsonString(persisted.remoteWorkDir)},`
    + `"credentialRef":${jsonString(persisted.credentialRef)}`
    + '}';
  return crypto.createHash('sha256').update(evidence, 'utf8').digest('hex');
}

function publicRemoteConnection(record, credentialDescriptor) {
  const persisted = createRemoteConnectionRecord(record);
  const descriptor = exactObject(credentialDescriptor, ['kind', 'configured']);
  if (descriptor.kind !== 'ssh_password' || typeof descriptor.configured !== 'boolean') fail();
  const { credentialRef: _credentialRef, ...publicFields } = persisted;
  return Object.freeze({
    ...publicFields,
    connectionEvidenceSha256: remoteConnectionEvidenceSha256(persisted),
    credentialKind: descriptor.kind,
    credentialConfigured: descriptor.configured,
  });
}

module.exports = {
  createRemoteConnectionRecord,
  createRemoteConnectionRequest,
  createRemoteConnectionUpdateRequest,
  createRemoteCredentialReplacementRequest,
  parseRemoteConnectionUid,
  parseRemoteHostFingerprint,
  publicRemoteConnection,
  remoteConnectionEvidenceSha256,
};
