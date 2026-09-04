'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  RECORD_NAMES,
  createProjectManifest,
} = require('../src/adapters/v2/zip/manifest');
const {
  STRUCTURED_RECORD_SPECS,
} = require('../src/adapters/v2/zip/projectArchiveV21StructuredData');
const {
  LEGACY_RECORD_SPECS,
} = require('../src/adapters/v2/compat/projectArchiveV21LegacyData');
const {
  projectProjectArchiveV21PortableField,
} = require('../src/adapters/v2/zip/projectArchiveV21PortableBindings');
const {
  ARCHIVE_KIND,
  SCHEMA_VERSION,
  createProjectManifestV21,
  parseProjectManifestV21,
  validateProjectArchiveV21Bundle,
} = require('../src/adapters/v2/zip/manifestV21');

const IDS = Object.freeze({
  drama: '91000000-0000-4000-8000-000000000001',
  workflow: '91000000-0000-4000-8000-000000000002',
  node: '91000000-0000-4000-8000-000000000003',
  asset: '91000000-0000-4000-8000-000000000004',
  version: '91000000-0000-4000-8000-000000000005',
});
const EXPORTED_AT = '2026-08-30T00:00:00.000Z';
const CREDENTIAL_REF = 'credential:v1:91000000-0000-4000-8000-000000000006';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function emptyRecordSet(names) {
  return Object.fromEntries(names.map((name) => [name, []]));
}

function legacyRecords(dramaUid = IDS.drama) {
  const records = emptyRecordSet(Object.keys(LEGACY_RECORD_SPECS));
  records.dramas.push({
    id: 1,
    uid: dramaUid,
    title: 'Archive 2.1 fixture',
    description: null,
    genre: null,
    style: null,
    tags: null,
    thumbnail: null,
    total_episodes: 0,
    total_duration: 0,
    status: 'draft',
    metadata: {},
    created_at: EXPORTED_AT,
    updated_at: EXPORTED_AT,
    deleted_at: null,
  });
  return records;
}

function fixture({ portableNode = false, mediaBytes = null } = {}) {
  const records = emptyRecordSet(RECORD_NAMES);
  const structuredRecords = emptyRecordSet(Object.keys(STRUCTURED_RECORD_SPECS));
  const portableBindings = [];
  const mediaBindings = [];

  if (portableNode) {
    const binding = projectProjectArchiveV21PortableField(
      'canvas_nodes',
      'config_json',
      { credentialRef: CREDENTIAL_REF },
    );
    records.workflowDefinitions.push({
      uid: IDS.workflow,
      drama_uid: IDS.drama,
      name: 'Portable workflow',
      version: 1,
      status: 'active',
      description: null,
      created_at: EXPORTED_AT,
      updated_at: EXPORTED_AT,
    });
    records.canvasNodes.push({
      uid: IDS.node,
      workflow_uid: IDS.workflow,
      node_type: 'story.facts',
      position_json: '{"x":0,"y":0}',
      config_json: JSON.stringify(binding.portable_value),
      domain_ref_type: null,
      domain_ref_uid: null,
      status: 'active',
      created_at: EXPORTED_AT,
      updated_at: EXPORTED_AT,
    });
    portableBindings.push({
      table: 'canvas_nodes',
      row_uid: IDS.node,
      column: 'config_json',
      portable_field: binding,
    });
  }

  let files = new Map();
  if (mediaBytes !== null) {
    const contentHash = sha256(mediaBytes);
    const archivePath = `v2/media/sha256/${contentHash.slice(0, 2)}/${contentHash}`;
    records.assets.push({
      uid: IDS.asset,
      owner_type: 'drama',
      owner_uid: IDS.drama,
      asset_type: 'video',
      current_version_uid: IDS.version,
      status: 'active',
      created_at: EXPORTED_AT,
      updated_at: EXPORTED_AT,
    });
    records.assetVersions.push({
      uid: IDS.version,
      asset_uid: IDS.asset,
      storage_provider: 'local',
      logical_uri: 'asset://projects/archive-21/final.mp4',
      relative_path: 'projects/archive-21/final.mp4',
      sha256: contentHash,
      mime_type: 'video/mp4',
      width: 608,
      height: 352,
      duration_ms: 1625,
      parent_uid: null,
      status: 'ready',
      created_at: EXPORTED_AT,
    });
    mediaBindings.push({
      asset_version_uid: IDS.version,
      binding_state: 'content_addressed',
      archive_path: archivePath,
      byte_length: mediaBytes.length,
      sha256: contentHash,
    });
    files = new Map([[archivePath, Buffer.from(mediaBytes)]]);
  }

  return {
    parts: {
      legacyProjectVersion: '1.0.0',
      exportedAt: EXPORTED_AT,
      project: {
        dramaUid: IDS.drama,
        characters: [],
        scenes: [],
        props: [],
        episodes: [],
      },
      records,
      structuredRecords,
      legacyRecords: legacyRecords(),
      mediaBindings,
      portableBindings,
    },
    files,
  };
}

function expectInvalid(run) {
  assert.throws(run, (error) => (
    error && error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
  ));
}

function expectInvalidWithout(run, secret) {
  assert.throws(run, (error) => (
    error
    && error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
    && !String(error).includes(secret)
    && !JSON.stringify(error).includes(secret)
    && !String(error.stack).includes(secret)
  ));
}

test('creates and parses an exact deeply frozen 2.1 manifest without activating 2.0 behavior', () => {
  assert.equal(SCHEMA_VERSION, '2.1.0');
  assert.equal(ARCHIVE_KIND, 'local-mini-drama-project');
  const { parts } = fixture();
  const manifest = createProjectManifestV21(parts);

  assert.equal(manifest.schemaVersion, '2.1.0');
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.records), true);
  assert.equal(Object.isFrozen(manifest.legacyRecords.dramas[0]), true);
  assert.deepEqual(parseProjectManifestV21(structuredClone(manifest)), manifest);

  const v20 = createProjectManifest({
    legacyProjectVersion: parts.legacyProjectVersion,
    exportedAt: parts.exportedAt,
    project: parts.project,
    records: parts.records,
  });
  assert.equal(v20.schemaVersion, '2.0.0');
});

test('normalizes older 2.1 manifests with no production execution groups to empty evidence', () => {
  const { parts } = fixture();
  const preE3 = structuredClone(createProjectManifestV21(parts));
  delete preE3.structuredRecords.characterCandidateExecutions;
  delete preE3.structuredRecords.characterCandidateExecutionItems;
  delete preE3.structuredRecords.characterReferencePackageExecutions;

  const parsed = parseProjectManifestV21(preE3);
  assert.deepEqual(parsed.structuredRecords.characterCandidateExecutions, []);
  assert.deepEqual(parsed.structuredRecords.characterCandidateExecutionItems, []);
  assert.deepEqual(parsed.structuredRecords.characterReferencePackageExecutions, []);
  assert.equal(Object.isFrozen(parsed.structuredRecords.characterCandidateExecutions), true);
  assert.equal(Object.isFrozen(parsed.structuredRecords.characterCandidateExecutionItems), true);
  assert.equal(Object.isFrozen(parsed.structuredRecords.characterReferencePackageExecutions), true);

  const partialE3 = structuredClone(createProjectManifestV21(parts));
  delete partialE3.structuredRecords.characterCandidateExecutionItems;
  assert.throws(
    () => parseProjectManifestV21(partialE3),
    (error) => error.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
  );
});

test('binds every portable carrier exactly once and rejects coordinated or raw credential drift', () => {
  const { parts } = fixture({ portableNode: true });
  const manifest = createProjectManifestV21(parts);
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(CREDENTIAL_REF), false);
  assert.equal(manifest.portableBindings.length, 1);
  assert.equal(manifest.portableBindings[0].portable_field.marker_count, 1);

  const missing = structuredClone(manifest);
  missing.portableBindings = [];
  expectInvalid(() => parseProjectManifestV21(missing));

  const drifted = structuredClone(manifest);
  drifted.records.canvasNodes[0].config_json = '{"credentialRef":{"bindingState":"needs_rebind"},"seed":7}';
  expectInvalid(() => parseProjectManifestV21(drifted));

  const raw = structuredClone(manifest);
  raw.records.canvasNodes[0].config_json = JSON.stringify({ credentialRef: CREDENTIAL_REF });
  expectInvalidWithout(() => parseProjectManifestV21(raw), CREDENTIAL_REF);

  const extra = structuredClone(manifest);
  extra.portableBindings[0].unexpected = true;
  expectInvalid(() => parseProjectManifestV21(extra));
});

test('validates the content-addressed media bundle and rejects missing, extra, or changed bytes', () => {
  const mediaBytes = Buffer.from('archive-2.1-media-content');
  const { parts, files } = fixture({ mediaBytes });
  const manifest = createProjectManifestV21(parts);
  assert.deepEqual(validateProjectArchiveV21Bundle({ manifest, files }), manifest);

  expectInvalid(() => validateProjectArchiveV21Bundle({ manifest, files: new Map() }));
  const extra = new Map(files);
  extra.set(`v2/media/sha256/${'a'.repeat(2)}/${'a'.repeat(64)}`, Buffer.from('extra'));
  expectInvalid(() => validateProjectArchiveV21Bundle({ manifest, files: extra }));
  const changed = new Map(files);
  changed.set(manifest.mediaBindings[0].archive_path, Buffer.from('changed'));
  expectInvalid(() => validateProjectArchiveV21Bundle({ manifest, files: changed }));
});

test('rejects cross-section identity drift, non-canonical order, and exact-envelope extras', () => {
  const manifest = createProjectManifestV21(fixture({ portableNode: true }).parts);

  const legacyDrift = structuredClone(manifest);
  legacyDrift.legacyRecords.dramas[0].uid = '92000000-0000-4000-8000-000000000001';
  expectInvalid(() => parseProjectManifestV21(legacyDrift));

  const rowDrift = structuredClone(manifest);
  rowDrift.portableBindings[0].row_uid = '92000000-0000-4000-8000-000000000002';
  expectInvalid(() => parseProjectManifestV21(rowDrift));

  const twoBindings = structuredClone(manifest);
  const secondNodeUid = '91000000-0000-4000-8000-000000000007';
  twoBindings.records.canvasNodes.push({
    ...twoBindings.records.canvasNodes[0],
    uid: secondNodeUid,
  });
  twoBindings.portableBindings.push({
    ...twoBindings.portableBindings[0],
    row_uid: secondNodeUid,
    portable_field: structuredClone(twoBindings.portableBindings[0].portable_field),
  });
  assert.equal(parseProjectManifestV21(twoBindings).portableBindings.length, 2);
  twoBindings.portableBindings.reverse();
  expectInvalid(() => parseProjectManifestV21(twoBindings));

  const topExtra = structuredClone(manifest);
  topExtra.unexpected = true;
  expectInvalid(() => parseProjectManifestV21(topExtra));
});

test('fails closed on Proxy and accessor inputs without executing their traps', () => {
  const manifest = createProjectManifestV21(fixture().parts);
  let proxyReads = 0;
  const proxy = new Proxy(manifest, {
    ownKeys() { proxyReads += 1; return []; },
    getOwnPropertyDescriptor() { proxyReads += 1; return undefined; },
  });
  expectInvalid(() => parseProjectManifestV21(proxy));
  assert.equal(proxyReads, 0);

  let getterReads = 0;
  const hostile = structuredClone(manifest);
  Object.defineProperty(hostile, 'records', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('synthetic accessor sentinel'); },
  });
  expectInvalid(() => parseProjectManifestV21(hostile));
  assert.equal(getterReads, 0);
});
