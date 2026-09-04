'use strict';

const { types } = require('node:util');

const { archiveError, isProjectArchiveError } = require('./errors');
const {
  ARCHIVE_KIND,
  RECORD_NAMES,
  RECORD_SPECS,
  parseProjectManifest,
} = require('./manifest');
const { ARCHIVE_V20, ARCHIVE_V21 } = require('./archiveVersionRouter');
const {
  STRUCTURED_RECORD_SPECS,
  validateProjectStructuredRecords,
} = require('./projectArchiveV21StructuredData');
const {
  LEGACY_RECORD_SPECS,
  validateProjectLegacyRecords,
} = require('../compat/projectArchiveV21LegacyData');
const {
  PORTABLE_BINDING_MARKER,
  validateProjectArchiveV21PortableField,
} = require('./projectArchiveV21PortableBindings');
const {
  MEDIA_LIMITS,
  validateProjectArchiveV21Media,
} = require('./projectArchiveV21MediaClosure');
const {
  assertProjectArchiveV21CharacterCandidateExecutionBase,
} = require('./projectArchiveV21CharacterCandidateExecutionEvidence');

const SCHEMA_VERSION = ARCHIVE_V21;
const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'archiveKind', 'legacyProjectVersion', 'exportedAt', 'project',
  'records', 'structuredRecords', 'legacyRecords', 'mediaBindings', 'portableBindings',
]);
const PORTABLE_ENTRY_FIELDS = Object.freeze([
  'table', 'row_uid', 'column', 'portable_field',
]);
const MEDIA_BINDING_FIELDS = Object.freeze([
  'asset_version_uid', 'binding_state', 'archive_path', 'byte_length', 'sha256',
]);
const NARRATIVE_RESULT_TYPE_BY_NODE_TYPE = Object.freeze({
  'story.facts': 'extraction',
  'episode.adaptation': 'adaptation',
  'script.structured': 'script',
  'shot.plan': 'shot',
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_PATH = /^v2\/media\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 4_000_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_STRING_BYTES = 128 * 1024 * 1024;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const DATE_TO_ISO = Date.prototype.toISOString;
const IS_PROXY = types.isProxy;
const JSON_STRINGIFY = JSON.stringify;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_SLICE = String.prototype.slice;
const STRING_TO_LOWER = String.prototype.toLowerCase;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function apply(method, receiver, args) {
  return Reflect.apply(method, receiver, args);
}

function safeHasOwn(value, key) {
  return apply(OBJECT_HAS_OWN, Object, [value, key]);
}

function sortStrings(values) {
  apply(ARRAY_SORT, values, []);
  return values;
}

function regexTest(expression, value) {
  return apply(REGEXP_EXEC, expression, [value]) !== null;
}

function mapHas(value, key) {
  return apply(MAP_HAS, value, [key]);
}

function mapGet(value, key) {
  return apply(MAP_GET, value, [key]);
}

function mapSet(value, key, item) {
  return apply(MAP_SET, value, [key, item]);
}

function setHas(value, key) {
  return apply(SET_HAS, value, [key]);
}

function setAdd(value, key) {
  return apply(SET_ADD, value, [key]);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || apply(ARRAY_IS_ARRAY, Array, [value])) {
    invalidManifest();
  }
  const actual = sortStrings(apply(REFLECT_OWN_KEYS, Reflect, [value]));
  const wanted = sortStrings(apply(ARRAY_SLICE, expected, []));
  if (actual.length !== wanted.length) invalidManifest();
  for (let index = 0; index < actual.length; index += 1) {
    if (typeof actual[index] !== 'string' || actual[index] !== wanted[index]) invalidManifest();
  }
  return value;
}

function snapshotJson(value) {
  const state = {
    entries: 0,
    totalStringBytes: 0,
    seen: new WeakSet(),
  };

  function accountString(text) {
    const bytes = apply(BUFFER_BYTE_LENGTH, Buffer, [text, 'utf8']);
    if (bytes > MAX_STRING_BYTES) invalidManifest();
    state.totalStringBytes += bytes;
    if (state.totalStringBytes > MAX_TOTAL_STRING_BYTES) invalidManifest();
    return text;
  }

  function visit(candidate, depth) {
    if (depth > MAX_DEPTH) invalidManifest();
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'string') return accountString(candidate);
    if (typeof candidate === 'number') {
      if (!apply(NUMBER_IS_FINITE, Number, [candidate])) invalidManifest();
      return candidate;
    }
    if (typeof candidate !== 'object' || IS_PROXY(candidate)) invalidManifest();
    if (apply(WEAK_SET_HAS, state.seen, [candidate])) invalidManifest();
    apply(WEAK_SET_ADD, state.seen, [candidate]);

    let prototype;
    let descriptors;
    let isArray;
    try {
      prototype = apply(OBJECT_GET_PROTOTYPE, Object, [candidate]);
      descriptors = apply(OBJECT_GET_DESCRIPTORS, Object, [candidate]);
      isArray = apply(ARRAY_IS_ARRAY, Array, [candidate]);
    } catch {
      return invalidManifest();
    }
    const keys = apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    if (isArray) {
      if (prototype !== Array.prototype) invalidManifest();
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !safeHasOwn(lengthDescriptor, 'value')
        || !apply(NUMBER_IS_SAFE_INTEGER, Number, [lengthDescriptor.value])
        || lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) {
        invalidManifest();
      }
      const output = new Array(lengthDescriptor.value);
      for (let index = 0; index < output.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
          invalidManifest();
        }
        state.entries += 1;
        if (state.entries > MAX_ENTRIES) invalidManifest();
        output[index] = visit(descriptor.value, depth + 1);
      }
      return apply(OBJECT_FREEZE, Object, [output]);
    }

    if (prototype !== Object.prototype && prototype !== null) invalidManifest();
    const sorted = sortStrings(keys);
    const output = apply(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < sorted.length; index += 1) {
      const key = sorted[index];
      if (typeof key !== 'string') invalidManifest();
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
        invalidManifest();
      }
      state.entries += 1;
      if (state.entries > MAX_ENTRIES) invalidManifest();
      accountString(key);
      output[key] = visit(descriptor.value, depth + 1);
    }
    return apply(OBJECT_FREEZE, Object, [output]);
  }

  return visit(value, 0);
}

function canonicalJson(value) {
  const parts = [];
  function write(candidate) {
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number'
      || typeof candidate === 'string') {
      parts[parts.length] = apply(JSON_STRINGIFY, JSON, [candidate]);
      return;
    }
    if (apply(ARRAY_IS_ARRAY, Array, [candidate])) {
      parts[parts.length] = '[';
      for (let index = 0; index < candidate.length; index += 1) {
        if (index > 0) parts[parts.length] = ',';
        write(candidate[index]);
      }
      parts[parts.length] = ']';
      return;
    }
    const keys = sortStrings(apply(REFLECT_OWN_KEYS, Reflect, [candidate]));
    parts[parts.length] = '{';
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) parts[parts.length] = ',';
      parts[parts.length] = apply(JSON_STRINGIFY, JSON, [keys[index]]);
      parts[parts.length] = ':';
      write(candidate[keys[index]]);
    }
    parts[parts.length] = '}';
  }
  write(value);
  return apply(ARRAY_JOIN, parts, ['']);
}

function normalizedKey(value) {
  const lower = apply(STRING_TO_LOWER, value, []);
  let output = '';
  for (let index = 0; index < lower.length; index += 1) {
    const code = apply(STRING_CHAR_CODE_AT, lower, [index]);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) output += lower[index];
  }
  return output;
}

function isPortableMarker(value) {
  if (value === null || typeof value !== 'object'
    || apply(ARRAY_IS_ARRAY, Array, [value])) return false;
  const keys = apply(REFLECT_OWN_KEYS, Reflect, [value]);
  return keys.length === 1 && keys[0] === 'bindingState'
    && value.bindingState === PORTABLE_BINDING_MARKER.bindingState;
}

function stripPortableMarkers(value) {
  if (value === null || typeof value !== 'object') return value;
  if (apply(ARRAY_IS_ARRAY, Array, [value])) {
    const output = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      output[index] = stripPortableMarkers(value[index]);
    }
    return output;
  }
  const output = apply(OBJECT_CREATE, Object, [null]);
  const keys = sortStrings(apply(REFLECT_OWN_KEYS, Reflect, [value]));
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (normalizedKey(key) === 'credentialref' && isPortableMarker(value[key])) continue;
    output[key] = stripPortableMarkers(value[key]);
  }
  return output;
}

function portableIdentity(table, rowUid, column) {
  return `${table}\u0000${rowUid}\u0000${column}`;
}

function assertPortableBindings(manifest) {
  const actual = manifest.portableBindings;
  const expected = [];
  const replacements = new Map();

  function expect(table, column, row, rawValue) {
    expected[expected.length] = { table, rowUid: row.uid, column, rawValue };
  }

  for (let index = 0; index < manifest.records.canvasNodes.length; index += 1) {
    const row = manifest.records.canvasNodes[index];
    expect('canvas_nodes', 'config_json', row, row.config_json);
  }
  for (let index = 0; index < manifest.records.workflowRuns.length; index += 1) {
    const row = manifest.records.workflowRuns[index];
    expect('workflow_runs', 'graph_snapshot_json', row, row.graph_snapshot_json);
  }
  for (let index = 0; index < manifest.records.nodeRuns.length; index += 1) {
    const row = manifest.records.nodeRuns[index];
    expect('node_runs', 'input_snapshot_json', row, row.input_snapshot_json);
    if (row.output_json !== null) expect('node_runs', 'output_json', row, row.output_json);
  }
  for (let index = 0; index < manifest.structuredRecords.voiceProfiles.length; index += 1) {
    const row = manifest.structuredRecords.voiceProfiles[index];
    expected[expected.length] = {
      table: 'voice_profiles', rowUid: row.uid, column: 'credential_ref', rawValue: null,
    };
  }
  apply(ARRAY_SORT, expected, [(left, right) => {
    const leftKey = portableIdentity(left.table, left.rowUid, left.column);
    const rightKey = portableIdentity(right.table, right.rowUid, right.column);
    return leftKey < rightKey ? -1 : (leftKey > rightKey ? 1 : 0);
  }]);
  if (actual.length !== expected.length) invalidManifest();

  for (let index = 0; index < actual.length; index += 1) {
    const entry = exactKeys(actual[index], PORTABLE_ENTRY_FIELDS);
    const wanted = expected[index];
    if (entry.table !== wanted.table || entry.row_uid !== wanted.rowUid
      || entry.column !== wanted.column || !regexTest(UUID_V4, entry.row_uid)) invalidManifest();
    const normalized = validateProjectArchiveV21PortableField(
      entry.table,
      entry.column,
      entry.portable_field,
    );
    if (entry.table === 'voice_profiles') {
      let profile = null;
      for (let profileIndex = 0;
        profileIndex < manifest.structuredRecords.voiceProfiles.length;
        profileIndex += 1) {
        const candidate = manifest.structuredRecords.voiceProfiles[profileIndex];
        if (candidate.uid === entry.row_uid) { profile = candidate; break; }
      }
      if (!profile || profile.credential_binding_state !== 'needs_rebind') invalidManifest();
      continue;
    }
    if (typeof wanted.rawValue !== 'string'
      || wanted.rawValue !== canonicalJson(normalized.portable_value)) invalidManifest();
    mapSet(
      replacements,
      portableIdentity(entry.table, entry.row_uid, entry.column),
      canonicalJson(stripPortableMarkers(normalized.portable_value)),
    );
  }
  return replacements;
}

function cloneCompatRecords(records, replacements) {
  const output = apply(OBJECT_CREATE, Object, [null]);
  for (let nameIndex = 0; nameIndex < RECORD_NAMES.length; nameIndex += 1) {
    const name = RECORD_NAMES[nameIndex];
    const spec = RECORD_SPECS[name];
    const rows = records[name];
    const clonedRows = new Array(rows.length);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const clone = apply(OBJECT_CREATE, Object, [null]);
      for (let columnIndex = 0; columnIndex < spec.columns.length; columnIndex += 1) {
        const column = spec.columns[columnIndex];
        const identity = portableIdentity(spec.table, row.uid, column);
        const narrativeCompatibilityProjection = name === 'canvasNodes'
          && row.domain_ref_type === 'narrative_result'
          && (column === 'domain_ref_type' || column === 'domain_ref_uid');
        clone[column] = narrativeCompatibilityProjection
          ? null
          : (mapHas(replacements, identity) ? mapGet(replacements, identity) : row[column]);
      }
      clonedRows[rowIndex] = clone;
    }
    output[name] = clonedRows;
  }
  return output;
}

function assertMediaBindings(manifest) {
  const versions = manifest.records.assetVersions;
  const bindings = manifest.mediaBindings;
  if (versions.length !== bindings.length || bindings.length > MEDIA_LIMITS.bindings) invalidManifest();
  const sortedVersions = apply(ARRAY_SLICE, versions, []);
  apply(ARRAY_SORT, sortedVersions, [(left, right) => (
    left.uid < right.uid ? -1 : (left.uid > right.uid ? 1 : 0)
  )]);
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = exactKeys(bindings[index], MEDIA_BINDING_FIELDS);
    const version = sortedVersions[index];
    if (!version || binding.asset_version_uid !== version.uid
      || !regexTest(UUID_V4, binding.asset_version_uid) || binding.sha256 !== version.sha256) {
      invalidManifest();
    }
    const expectedState = version.storage_provider === 'local' && version.status === 'ready'
      ? 'content_addressed'
      : (version.storage_provider !== 'local' && version.status === 'ready'
        ? 'needs_rebind' : 'not_required');
    if (binding.binding_state !== expectedState) invalidManifest();
    if (binding.sha256 !== null
      && (typeof binding.sha256 !== 'string' || !regexTest(SHA256, binding.sha256))) {
      invalidManifest();
    }
    if (expectedState === 'content_addressed') {
      const match = typeof binding.archive_path === 'string'
        ? apply(REGEXP_EXEC, CONTENT_PATH, [binding.archive_path]) : null;
      if (!match || binding.sha256 === null
        || match[1] !== apply(STRING_SLICE, binding.sha256, [0, 2])
        || match[2] !== binding.sha256 || !apply(NUMBER_IS_SAFE_INTEGER, Number, [binding.byte_length])
        || binding.byte_length < 1 || binding.byte_length > MEDIA_LIMITS.fileBytes) {
        invalidManifest();
      }
    } else if (binding.archive_path !== null || binding.byte_length !== null) invalidManifest();
  }
}

function indexByUid(rows) {
  const result = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    mapSet(result, rows[index].uid, rows[index]);
  }
  return result;
}

function assertMediaEvidence(records, structured) {
  const assets = indexByUid(records.assets);
  const versions = indexByUid(records.assetVersions);

  function assertSnapshot(row, prefix = '') {
    const assetUid = row[`${prefix}asset_uid`];
    const versionUid = row[`${prefix}asset_version_uid`];
    const asset = mapGet(assets, assetUid);
    const version = mapGet(versions, versionUid);
    if (!asset || !version || version.asset_uid !== asset.uid) invalidManifest();
    const fields = [
      [`${prefix}storage_provider`, version.storage_provider],
      [`${prefix}relative_path`, version.relative_path],
      [`${prefix}duration_ms`, version.duration_ms],
      [`${prefix}parent_uid`, version.parent_uid],
      [`${prefix}created_at`, version.created_at],
      [`${prefix}logical_uri`, version.logical_uri],
      [`${prefix}media_type`, version.mime_type],
      [`${prefix}width`, version.width],
      [`${prefix}height`, version.height],
      [`${prefix}content_sha256`, version.sha256],
    ];
    for (let index = 0; index < fields.length; index += 1) {
      const [field, expected] = fields[index];
      if (safeHasOwn(row, field) && row[field] !== expected) invalidManifest();
    }
    if (safeHasOwn(row, 'asset_version_parent_uid')
      && row.asset_version_parent_uid !== version.parent_uid) invalidManifest();
    if (safeHasOwn(row, 'asset_version_created_at')
      && row.asset_version_created_at !== version.created_at) invalidManifest();
    if (safeHasOwn(row, 'asset_created_at') && row.asset_created_at !== asset.created_at) invalidManifest();
    if (safeHasOwn(row, 'asset_updated_at') && row.asset_updated_at !== asset.updated_at) invalidManifest();
  }

  for (let index = 0; index < structured.characterCandidateResults.length; index += 1) {
    assertSnapshot(structured.characterCandidateResults[index]);
  }
  for (let index = 0; index < structured.characterReferencePackageItems.length; index += 1) {
    assertSnapshot(structured.characterReferencePackageItems[index]);
  }
  for (let index = 0; index < structured.bgmTracks.length; index += 1) {
    const row = structured.bgmTracks[index];
    const asset = mapGet(assets, row.asset_uid);
    const version = mapGet(versions, row.asset_version_uid);
    if (!asset || !version || version.asset_uid !== asset.uid
      || row.version_storage_provider !== version.storage_provider
      || row.version_logical_uri !== version.logical_uri
      || row.version_relative_path !== version.relative_path
      || row.version_sha256 !== version.sha256
      || row.version_mime_type !== version.mime_type
      || row.version_width !== version.width
      || row.version_height !== version.height
      || row.version_duration_ms !== version.duration_ms
      || row.version_parent_uid !== version.parent_uid
      || row.version_status !== version.status
      || row.version_created_at !== version.created_at) invalidManifest();
  }
}

function uidSet(rows) {
  const result = new Set();
  for (let index = 0; index < rows.length; index += 1) setAdd(result, rows[index].uid);
  return result;
}

function assertStructuredBaseReferences(records, structured, legacyRecords) {
  const characterUids = uidSet(legacyRecords.characters);
  const sceneUids = uidSet(legacyRecords.scenes);
  const propUids = uidSet(legacyRecords.props);
  const selectionUids = uidSet(records.sourceSelections);
  const narrativeResults = indexByUid(structured.narrativeResults);

  for (let index = 0; index < records.canvasNodes.length; index += 1) {
    const row = records.canvasNodes[index];
    if (row.domain_ref_type !== 'narrative_result') continue;
    const expectedType = safeHasOwn(NARRATIVE_RESULT_TYPE_BY_NODE_TYPE, row.node_type)
      ? NARRATIVE_RESULT_TYPE_BY_NODE_TYPE[row.node_type]
      : null;
    const narrativeResult = mapGet(narrativeResults, row.domain_ref_uid);
    if (expectedType === null || !narrativeResult
      || narrativeResult.result_type !== expectedType) invalidManifest();
  }

  const characterGroups = [
    structured.characterIdentityVersions,
    structured.characterAppearanceVersions,
    structured.characterCostumeVersions,
    structured.characterVoiceVersions,
    structured.characterCandidateBatches,
    structured.characterCandidateResults,
    structured.characterCandidateExecutions,
    structured.characterIdentityLockEvents,
    structured.characterReferencePackages,
    structured.characterReferencePackageItems,
    structured.characterReferencePackageExecutions,
    structured.shotContinuityCharacterRefs,
    structured.voiceProfiles,
    structured.voiceProfileSelectionEvents,
  ];
  for (let groupIndex = 0; groupIndex < characterGroups.length; groupIndex += 1) {
    const rows = characterGroups[groupIndex];
    for (let index = 0; index < rows.length; index += 1) {
      if (!setHas(characterUids, rows[index].character_uid)) invalidManifest();
    }
  }
  for (let index = 0; index < structured.sceneVersions.length; index += 1) {
    if (!setHas(sceneUids, structured.sceneVersions[index].scene_uid)) invalidManifest();
  }
  for (let index = 0; index < structured.shotContinuitySnapshots.length; index += 1) {
    if (!setHas(sceneUids, structured.shotContinuitySnapshots[index].scene_uid)) invalidManifest();
  }
  for (let index = 0; index < structured.propVersions.length; index += 1) {
    if (!setHas(propUids, structured.propVersions[index].prop_uid)) invalidManifest();
  }
  for (let index = 0; index < structured.shotContinuityPropRefs.length; index += 1) {
    if (!setHas(propUids, structured.shotContinuityPropRefs[index].prop_uid)) invalidManifest();
  }
  for (let index = 0; index < structured.narrativeResults.length; index += 1) {
    if (!setHas(selectionUids, structured.narrativeResults[index].source_selection_uid)) {
      invalidManifest();
    }
  }
}

function normalizeCharacterCandidateExecutionGroups(root) {
  const structured = root.structuredRecords;
  if (structured === null || typeof structured !== 'object'
    || apply(ARRAY_IS_ARRAY, Array, [structured])) return root;
  const descriptors = apply(OBJECT_GET_DESCRIPTORS, Object, [structured]);
  const hasExecutions = safeHasOwn(descriptors, 'characterCandidateExecutions');
  const hasItems = safeHasOwn(descriptors, 'characterCandidateExecutionItems');
  const hasReferenceExecutions = safeHasOwn(
    descriptors,
    'characterReferencePackageExecutions',
  );
  if (hasExecutions !== hasItems) return root;
  if (hasExecutions && hasReferenceExecutions) return root;

  const names = apply(REFLECT_OWN_KEYS, Reflect, [STRUCTURED_RECORD_SPECS]);
  const actual = apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
  const missingCount = (hasExecutions ? 0 : 2) + (hasReferenceExecutions ? 0 : 1);
  if (actual.length !== names.length - missingCount) return root;
  const normalized = apply(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (name === 'characterCandidateExecutions'
      || name === 'characterCandidateExecutionItems'
      || name === 'characterReferencePackageExecutions') {
      if ((name === 'characterCandidateExecutions' || name === 'characterCandidateExecutionItems')
        && hasExecutions) {
        normalized[name] = descriptors[name].value;
        continue;
      }
      if (name === 'characterReferencePackageExecutions' && hasReferenceExecutions) {
        normalized[name] = descriptors[name].value;
        continue;
      }
      normalized[name] = apply(OBJECT_FREEZE, Object, [new Array(0)]);
      continue;
    }
    const descriptor = descriptors[name];
    if (!descriptor || descriptor.enumerable !== true || !safeHasOwn(descriptor, 'value')) {
      return root;
    }
    normalized[name] = descriptor.value;
  }
  apply(OBJECT_FREEZE, Object, [normalized]);
  const output = apply(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < MANIFEST_FIELDS.length; index += 1) {
    const field = MANIFEST_FIELDS[index];
    output[field] = field === 'structuredRecords' ? normalized : root[field];
  }
  return apply(OBJECT_FREEZE, Object, [output]);
}

function assertCoreClosure(project, legacyRecords) {
  if (legacyRecords.dramas.length !== 1 || legacyRecords.dramas[0].uid !== project.dramaUid) {
    invalidManifest();
  }
  const groups = [
    [project.characters, legacyRecords.characters],
    [project.scenes, legacyRecords.scenes],
    [project.props, legacyRecords.props],
    [[], legacyRecords.episodes],
    [[], legacyRecords.storyboards],
  ];
  for (let index = 0; index < project.episodes.length; index += 1) {
    groups[3][0][groups[3][0].length] = project.episodes[index].uid;
    for (let boardIndex = 0; boardIndex < project.episodes[index].storyboards.length; boardIndex += 1) {
      groups[4][0][groups[4][0].length] = project.episodes[index].storyboards[boardIndex];
    }
  }
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const expected = new Set();
    for (let rowIndex = 0; rowIndex < groups[groupIndex][1].length; rowIndex += 1) {
      setAdd(expected, groups[groupIndex][1][rowIndex].uid);
    }
    if (groups[groupIndex][0].length !== groups[groupIndex][1].length) invalidManifest();
    for (let index = 0; index < groups[groupIndex][0].length; index += 1) {
      if (!setHas(expected, groups[groupIndex][0][index])) invalidManifest();
    }
  }
}

function validateSnapshot(manifest) {
  const root = exactKeys(manifest, MANIFEST_FIELDS);
  if (root.schemaVersion !== SCHEMA_VERSION || root.archiveKind !== ARCHIVE_KIND
    || typeof root.legacyProjectVersion !== 'string'
    || root.legacyProjectVersion.length < 1 || root.legacyProjectVersion.length > 32
    || typeof root.exportedAt !== 'string') invalidManifest();
  try {
    const timestamp = new Date(root.exportedAt);
    if (apply(DATE_TO_ISO, timestamp, []) !== root.exportedAt) invalidManifest();
  } catch {
    invalidManifest();
  }
  if (!apply(ARRAY_IS_ARRAY, Array, [root.mediaBindings])
    || !apply(ARRAY_IS_ARRAY, Array, [root.portableBindings])) invalidManifest();

  validateProjectStructuredRecords(root.structuredRecords, root.project.dramaUid);
  validateProjectLegacyRecords(root.legacyRecords, root.project.dramaUid);
  const replacements = assertPortableBindings(root);
  const compatRecords = cloneCompatRecords(root.records, replacements);
  parseProjectManifest({
    schemaVersion: ARCHIVE_V20,
    archiveKind: ARCHIVE_KIND,
    legacyProjectVersion: root.legacyProjectVersion,
    exportedAt: root.exportedAt,
    project: root.project,
    records: compatRecords,
  });
  assertCoreClosure(root.project, root.legacyRecords);
  assertStructuredBaseReferences(root.records, root.structuredRecords, root.legacyRecords);
  assertProjectArchiveV21CharacterCandidateExecutionBase(
    root.records,
    root.structuredRecords,
    root.legacyRecords,
    root.mediaBindings,
    invalidManifest,
  );
  assertMediaEvidence(root.records, root.structuredRecords);
  assertMediaBindings(root);
  return root;
}

function parseProjectManifestV21(value) {
  try {
    return validateSnapshot(normalizeCharacterCandidateExecutionGroups(snapshotJson(value)));
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidManifest();
  }
}

function createProjectManifestV21({
  legacyProjectVersion,
  exportedAt,
  project,
  records,
  structuredRecords,
  legacyRecords,
  mediaBindings,
  portableBindings,
} = {}) {
  return parseProjectManifestV21({
    schemaVersion: SCHEMA_VERSION,
    archiveKind: ARCHIVE_KIND,
    legacyProjectVersion,
    exportedAt,
    project,
    records,
    structuredRecords,
    legacyRecords,
    mediaBindings,
    portableBindings,
  });
}

function validateProjectArchiveV21Bundle({ manifest, files } = {}) {
  try {
    const parsed = parseProjectManifestV21(manifest);
    validateProjectArchiveV21Media({
      assetVersions: parsed.records.assetVersions,
      bindings: parsed.mediaBindings,
      files,
    });
    return parsed;
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    return invalidManifest();
  }
}

module.exports = Object.freeze({
  ARCHIVE_KIND,
  SCHEMA_VERSION,
  createProjectManifestV21,
  parseProjectManifestV21,
  validateProjectArchiveV21Bundle,
});
