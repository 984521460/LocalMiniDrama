'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { PROJECT_ARCHIVE_CATALOG } = require('../src/adapters/v2/zip/projectArchiveCatalog');
const {
  PORTABLE_BINDING_LIMITS,
  PORTABLE_BINDING_SCHEMA_VERSION,
  projectProjectArchiveV21PortableField,
  validateProjectArchiveV21PortableField,
} = require('../src/adapters/v2/zip/projectArchiveV21PortableBindings');
const { normalizeWorkflowNodeConfig } = require('../src/workflows/nodeConfig');

const CREDENTIAL_REF = 'credential:v1:00000000-0000-4000-8000-000000009420';
const MARKER = Object.freeze({ bindingState: 'needs_rebind' });

function expectCode(code, callback, forbidden = []) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    const surfaces = [error?.message, error?.stack, JSON.stringify(error)].join('\n');
    for (let index = 0; index < forbidden.length; index += 1) {
      assert.equal(surfaces.includes(forbidden[index]), false);
    }
    return true;
  });
}

function projection(table, column, value) {
  return projectProjectArchiveV21PortableField(table, column, value);
}

test('projects every catalogued direct or nested credential field without retaining reference values', () => {
  const audio = normalizeWorkflowNodeConfig('audio.tts', {
    credentialRef: CREDENTIAL_REF,
    profileUid: '00000000-0000-4000-8000-000000009421',
    speed: 1,
  });
  const video = normalizeWorkflowNodeConfig('shot.video', {
    connectionEvidenceSha256: 'a'.repeat(64),
    connectionUid: '00000000-0000-4000-8000-000000009422',
    credentialRef: CREDENTIAL_REF,
    durationMs: 15000,
    fps: 24,
    height: 1080,
    manifestUid: '00000000-0000-4000-8000-000000009423',
    profileUid: '00000000-0000-4000-8000-000000009424',
    seed: 42,
    width: 1920,
  });
  const nestedValues = {
    'canvas_nodes.config_json': audio,
    'workflow_runs.graph_snapshot_json': {
      nodes: [
        { config: video, nodeType: 'shot.video', uid: '00000000-0000-4000-8000-000000009425' },
        { config: audio, nodeType: 'audio.tts', uid: '00000000-0000-4000-8000-000000009426' },
      ],
      revision: 7,
    },
    'node_runs.input_snapshot_json': { request: { config: audio }, retry: 0 },
    'node_runs.output_json': { provider: { binding: { credential_ref: CREDENTIAL_REF } } },
  };

  const covered = [];
  for (let index = 0; index < PROJECT_ARCHIVE_CATALOG.needsRebindFields.length; index += 1) {
    const field = PROJECT_ARCHIVE_CATALOG.needsRebindFields[index];
    const identity = `${field.table}.${field.column}`;
    const value = field.kind === 'direct-credential-ref' ? CREDENTIAL_REF : nestedValues[identity];
    const result = projection(field.table, field.column, value);
    assert.equal(result.schema_version, PORTABLE_BINDING_SCHEMA_VERSION);
    assert.equal(result.binding_state, 'needs_rebind');
    assert.equal(result.marker_count >= 1, true);
    assert.equal(Object.isFrozen(result), true);
    if (result.portable_value !== null) assert.equal(Object.isFrozen(result.portable_value), true);
    assert.deepEqual(validateProjectArchiveV21PortableField(field.table, field.column, result), result);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(CREDENTIAL_REF), false);
    assert.equal(serialized.includes('credential:v1:'), false);
    covered.push(identity);
  }

  assert.deepEqual(covered, PROJECT_ARCHIVE_CATALOG.needsRebindFields.map(
    ({ table, column }) => `${table}.${column}`,
  ));
  assert.deepEqual(
    projection('canvas_nodes', 'config_json', audio).portable_value.credentialRef,
    MARKER,
  );
  assert.deepEqual(
    projection('workflow_runs', 'graph_snapshot_json', nestedValues['workflow_runs.graph_snapshot_json'])
      .portable_value.nodes.map((node) => node.config.credentialRef),
    [MARKER, MARKER],
  );
  assert.throws(() => normalizeWorkflowNodeConfig(
    'audio.tts', projection('canvas_nodes', 'config_json', audio).portable_value,
  ));
  assert.equal(audio.credentialRef, CREDENTIAL_REF);
  assert.equal(video.credentialRef, CREDENTIAL_REF);
});

test('preserves ordinary portable JSON and rejects raw, misplaced, or malformed secret-shaped data', () => {
  const ordinary = {
    authorizationRoute: '/oauth/callback',
    endpointPath: '/v1/images',
    monkey: 'curious',
    passwordlessLogin: true,
    prompt: 'A token of friendship shown in a cinematic close-up.',
    settings: { steps: 20, width: 1024 },
    tokenizerMode: 'cinematic-natural-language',
  };
  const projected = projection('canvas_nodes', 'config_json', ordinary);
  assert.equal(projected.binding_state, 'not_required');
  assert.equal(projected.marker_count, 0);
  assert.deepEqual(projected.portable_value, ordinary);
  assert.deepEqual(validateProjectArchiveV21PortableField(
    'canvas_nodes', 'config_json', projected,
  ), projected);
  assert.equal(
    JSON.stringify(projection('canvas_nodes', 'config_json', { z: 1, a: 2 })),
    JSON.stringify(projection('canvas_nodes', 'config_json', { a: 2, z: 1 })),
  );

  const synthetic = 'synthetic-secret-must-not-export';
  for (const value of [
    { apiKey: synthetic },
    { openaiApiKey: synthetic },
    { awsAccessKey: synthetic },
    { providerClientSecret: synthetic },
    { servicePassword: synthetic },
    { sessionTokenValue: synthetic },
    { password: synthetic },
    { note: CREDENTIAL_REF },
    { credentialRef: 'plain-text-value' },
    { credentialRef: { bindingState: 'ready' } },
    { nested: JSON.stringify({ credentialRef: CREDENTIAL_REF }) },
    { note: `Bearer ${synthetic}` },
  ]) {
    expectCode('PROJECT_ARCHIVE_SECRET_DETECTED',
      () => projection('canvas_nodes', 'config_json', value), [synthetic, CREDENTIAL_REF]);
  }
  const secretSemantics = [
    'accesskey', 'accesssecret', 'apikey', 'apisecret', 'authorization', 'bearer',
    'clientkey', 'clientsecret', 'credential', 'password', 'passwd', 'privatekey',
    'refreshtoken', 'secret', 'secretkey', 'sessioncookie', 'sessiontoken', 'token',
  ];
  for (let index = 0; index < secretSemantics.length; index += 1) {
    const semantic = secretSemantics[index];
    for (const key of [`provider${semantic}`, `${semantic}value`]) {
      expectCode('PROJECT_ARCHIVE_SECRET_DETECTED',
        () => projection('canvas_nodes', 'config_json', { [key]: synthetic }), [synthetic]);
    }
  }
  const embeddedSecrets = [
    'https://local.invalid/v1?api_key=sk-syntheticvalue123',
    '{"api_key":"sk-syntheticvalue123"}',
    'Authorization:Bearer synthetic-token-value',
    'https://local.invalid/v1?access_key=AKIA0000000000000000',
    'payload=-----BEGIN PRIVATE KEY-----',
    '{"apiKey":"synthetic-local-secret-value"}',
    "{'provider_client_secret':'synthetic-local-secret-value'}",
    'awsAccessKey: synthetic-local-secret-value',
    'OPENAI_API_KEY=synthetic-local-secret-value',
    '"openai api key":"synthetic-local-secret-value"',
    'provider-client-secret = synthetic-local-secret-value',
    'mode=test; session_token_value=synthetic-local-secret-value',
    'payload={"apiKey":"synthetic-local-secret-value"}',
    '["apiKey=synthetic-local-secret-value"]',
    'https://local-user:synthetic-local-secret-value@local.invalid/v1',
    'custom://:synthetic-local-secret-value@local.invalid/v1',
  ];
  for (let index = 0; index < embeddedSecrets.length; index += 1) {
    const secret = embeddedSecrets[index];
    expectCode('PROJECT_ARCHIVE_SECRET_DETECTED',
      () => projection('canvas_nodes', 'config_json', { endpoint: secret }), [secret]);
  }
  for (const text of [
    'apiKey documentation',
    'https://local-user@local.invalid/v1',
    'scene ratio: 16:9',
    'Narrator says: keep moving',
    'https://local.invalid/v1?apiKey=',
  ]) {
    assert.equal(
      projection('canvas_nodes', 'config_json', { note: text }).portable_value.note,
      text,
    );
  }
  expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
    () => projection('remote_connections', 'credential_ref', CREDENTIAL_REF));
  expectCode('PROJECT_ARCHIVE_SECRET_DETECTED',
    () => validateProjectArchiveV21PortableField('canvas_nodes', 'config_json', {
      schema_version: PORTABLE_BINDING_SCHEMA_VERSION,
      binding_state: 'needs_rebind',
      marker_count: 1,
      portable_value: { credentialRef: CREDENTIAL_REF },
    }), [CREDENTIAL_REF]);
  const validMarker = projection('canvas_nodes', 'config_json', { credentialRef: CREDENTIAL_REF });
  for (const drifted of [
    { ...validMarker, binding_state: 'not_required' },
    { ...validMarker, marker_count: 0 },
    { ...validMarker, extra: true },
    { ...validMarker, portable_value: { note: MARKER } },
  ]) {
    expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
      () => validateProjectArchiveV21PortableField('canvas_nodes', 'config_json', drifted));
  }
  for (const portableValue of [
    { note: MARKER },
    { nested: [{ value: MARKER }] },
  ]) {
    expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
      () => validateProjectArchiveV21PortableField('canvas_nodes', 'config_json', {
        schema_version: PORTABLE_BINDING_SCHEMA_VERSION,
        binding_state: 'not_required',
        marker_count: 0,
        portable_value: portableValue,
      }));
    expectCode('PROJECT_ARCHIVE_SECRET_DETECTED',
      () => projection('canvas_nodes', 'config_json', portableValue));
  }
});

test('fails closed without executing Proxy or accessor input and enforces deterministic bounds', () => {
  let proxyReads = 0;
  const proxy = new Proxy({ credentialRef: CREDENTIAL_REF }, {
    getPrototypeOf() { proxyReads += 1; throw new Error('proxy-sentinel'); },
    ownKeys() { proxyReads += 1; throw new Error('proxy-sentinel'); },
  });
  expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
    () => projection('canvas_nodes', 'config_json', proxy), ['proxy-sentinel']);
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'credentialRef', {
    enumerable: true,
    get() { getterReads += 1; return CREDENTIAL_REF; },
  });
  expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
    () => projection('canvas_nodes', 'config_json', accessor));
  assert.equal(getterReads, 0);

  const circular = {};
  circular.self = circular;
  expectCode('PROJECT_ARCHIVE_MANIFEST_INVALID',
    () => projection('canvas_nodes', 'config_json', circular));

  let tooDeep = { credentialRef: CREDENTIAL_REF };
  for (let index = 0; index <= PORTABLE_BINDING_LIMITS.depth; index += 1) {
    tooDeep = { child: tooDeep };
  }
  expectCode('PROJECT_ARCHIVE_LIMIT_EXCEEDED',
    () => projection('canvas_nodes', 'config_json', tooDeep));
  expectCode('PROJECT_ARCHIVE_LIMIT_EXCEEDED',
    () => projection('canvas_nodes', 'config_json', {
      text: 'x'.repeat(PORTABLE_BINDING_LIMITS.stringBytes + 1),
    }));
});

test('does not execute polluted inherited transformation accessors', () => {
  const modulePath = path.resolve(
    __dirname,
    '../src/adapters/v2/zip/projectArchiveV21PortableBindings.js',
  );
  const script = String.raw`
    'use strict';
    const {
      projectProjectArchiveV21PortableField,
      validateProjectArchiveV21PortableField,
    } = require(process.argv[1]);
    const source = {
      credentialRef: 'credential:v1:00000000-0000-4000-8000-000000009420',
      nested: [{ prompt: 'cinematic portrait' }],
    };
    const reads = {
      iterator: 0, map: 0, slice: 0, some: 0, sort: 0,
      charCodeAt: 0, endsWith: 0, fromCharCode: 0, includes: 0, replace: 0, toLowerCase: 0,
      regexpExec: 0, regexpTest: 0, weakSetAdd: 0, weakSetHas: 0,
    };
    const targets = [
      [Array.prototype, Symbol.iterator, 'iterator'],
      [Array.prototype, 'map', 'map'],
      [Array.prototype, 'slice', 'slice'],
      [Array.prototype, 'some', 'some'],
      [Array.prototype, 'sort', 'sort'],
      [String.prototype, 'charCodeAt', 'charCodeAt'],
      [String.prototype, 'endsWith', 'endsWith'],
      [String, 'fromCharCode', 'fromCharCode'],
      [String.prototype, 'includes', 'includes'],
      [String.prototype, 'replace', 'replace'],
      [String.prototype, 'toLowerCase', 'toLowerCase'],
      [RegExp.prototype, 'exec', 'regexpExec'],
      [RegExp.prototype, 'test', 'regexpTest'],
      [WeakSet.prototype, 'add', 'weakSetAdd'],
      [WeakSet.prototype, 'has', 'weakSetHas'],
    ];
    const originals = new Array(targets.length);
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      originals[index] = Object.getOwnPropertyDescriptor(target[0], target[1]);
      const original = originals[index];
      Object.defineProperty(target[0], target[1], {
        configurable: true,
        get() { reads[target[2]] += 1; return original.value; },
      });
    }
    try {
      const projected = projectProjectArchiveV21PortableField(
        'canvas_nodes', 'config_json', source,
      );
      validateProjectArchiveV21PortableField('canvas_nodes', 'config_json', projected);
    } finally {
      for (let index = 0; index < targets.length; index += 1) {
        Object.defineProperty(targets[index][0], targets[index][1], originals[index]);
      }
    }
    process.stdout.write(JSON.stringify(reads));
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', script, modulePath], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    iterator: 0, map: 0, slice: 0, some: 0, sort: 0,
    charCodeAt: 0, endsWith: 0, fromCharCode: 0, includes: 0, replace: 0, toLowerCase: 0,
    regexpExec: 0, regexpTest: 0, weakSetAdd: 0, weakSetHas: 0,
  });
});
