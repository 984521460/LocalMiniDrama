'use strict';

const { parseStrictJson } = require('../../../security/strictJson');
const { archiveError, isProjectArchiveError } = require('./errors');
const {
  PORTABLE_BINDING_LIMITS,
  projectProjectArchiveV21PortableField,
} = require('./projectArchiveV21PortableBindings');

const JSON_STRINGIFY = JSON.stringify;
const OBJECT_GET_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SORT = Array.prototype.sort;
const NUMBER_IS_FINITE = Number.isFinite;

const CARRIERS = Object.freeze([
  Object.freeze({ name: 'canvasNodes', table: 'canvas_nodes', columns: Object.freeze(['config_json']) }),
  Object.freeze({ name: 'workflowRuns', table: 'workflow_runs', columns: Object.freeze(['graph_snapshot_json']) }),
  Object.freeze({ name: 'nodeRuns', table: 'node_runs', columns: Object.freeze(['input_snapshot_json', 'output_json']) }),
]);

function invalid() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function canonicalJson(value) {
  const parts = [];
  function write(candidate, depth) {
    if (depth > PORTABLE_BINDING_LIMITS.depth + 1) invalid();
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      parts[parts.length] = Reflect.apply(JSON_STRINGIFY, JSON, [candidate]);
      return;
    }
    if (typeof candidate === 'number') {
      if (!Reflect.apply(NUMBER_IS_FINITE, Number, [candidate])) invalid();
      parts[parts.length] = Reflect.apply(JSON_STRINGIFY, JSON, [candidate]);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') invalid();
    const descriptors = Reflect.apply(OBJECT_GET_DESCRIPTORS, Object, [candidate]);
    const prototype = Reflect.apply(OBJECT_GET_PROTOTYPE, Object, [candidate]);
    const isArray = Reflect.apply(ARRAY_IS_ARRAY, Array, [candidate]);
    const keys = Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    if (isArray) {
      const length = descriptors.length?.value;
      if (prototype !== Array.prototype || !Number.isSafeInteger(length)
        || length < 0 || keys.length !== length + 1) invalid();
      parts[parts.length] = '[';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true
          || !Reflect.apply(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) invalid();
        if (index > 0) parts[parts.length] = ',';
        write(descriptor.value, depth + 1);
      }
      parts[parts.length] = ']';
      return;
    }
    if (prototype !== Object.prototype && prototype !== null) invalid();
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') invalid();
    }
    Reflect.apply(ARRAY_SORT, keys, []);
    parts[parts.length] = '{';
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (!descriptor || descriptor.enumerable !== true
        || !Reflect.apply(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) invalid();
      if (index > 0) parts[parts.length] = ',';
      parts[parts.length] = Reflect.apply(JSON_STRINGIFY, JSON, [keys[index]]);
      parts[parts.length] = ':';
      write(descriptor.value, depth + 1);
    }
    parts[parts.length] = '}';
  }
  write(value, 0);
  return Reflect.apply(ARRAY_JOIN, parts, ['']);
}

function bindingIdentity(binding) {
  return `${binding.table}\u0000${binding.row_uid}\u0000${binding.column}`;
}

function projectJsonCarrier(table, column, row, rawValue) {
  if (typeof rawValue !== 'string') invalid();
  let parsed;
  try {
    parsed = parseStrictJson(rawValue, PORTABLE_BINDING_LIMITS.totalBytes);
  } catch {
    return invalid();
  }
  const portable = projectProjectArchiveV21PortableField(table, column, parsed);
  return Object.freeze({
    binding: Object.freeze({
      table,
      row_uid: row.uid,
      column,
      portable_field: portable,
    }),
    storedValue: canonicalJson(portable.portable_value),
  });
}

function createProjectArchiveV21PortableSnapshot(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('Project archive portable snapshot database is invalid');
  }
  const voiceProfiles = database.prepare(`
    SELECT uid,credential_ref
    FROM voice_profiles
    WHERE drama_uid=?
    ORDER BY uid
  `);

  return Object.freeze({
    project({ dramaUid, records, structuredRecords } = {}) {
      try {
        if (typeof dramaUid !== 'string' || !records || typeof records !== 'object'
          || !structuredRecords || typeof structuredRecords !== 'object') invalid();
        const projectedRecords = { ...records };
        const bindings = [];
        for (let carrierIndex = 0; carrierIndex < CARRIERS.length; carrierIndex += 1) {
          const carrier = CARRIERS[carrierIndex];
          const rows = records[carrier.name];
          if (!Array.isArray(rows)) invalid();
          projectedRecords[carrier.name] = rows.map((row) => {
            const projected = { ...row };
            for (let columnIndex = 0; columnIndex < carrier.columns.length; columnIndex += 1) {
              const column = carrier.columns[columnIndex];
              if (row[column] === null && column === 'output_json') continue;
              const result = projectJsonCarrier(carrier.table, column, row, row[column]);
              projected[column] = result.storedValue;
              bindings[bindings.length] = result.binding;
            }
            return projected;
          });
        }

        const liveProfiles = voiceProfiles.all(dramaUid);
        const archivedProfiles = structuredRecords.voiceProfiles;
        if (!Array.isArray(archivedProfiles) || liveProfiles.length !== archivedProfiles.length) invalid();
        for (let index = 0; index < archivedProfiles.length; index += 1) {
          const archived = archivedProfiles[index];
          const live = liveProfiles[index];
          if (!live || live.uid !== archived.uid
            || archived.credential_binding_state !== 'needs_rebind') invalid();
          bindings[bindings.length] = Object.freeze({
            table: 'voice_profiles',
            row_uid: archived.uid,
            column: 'credential_ref',
            portable_field: projectProjectArchiveV21PortableField(
              'voice_profiles',
              'credential_ref',
              live.credential_ref,
            ),
          });
        }
        Reflect.apply(ARRAY_SORT, bindings, [(left, right) => {
          const leftIdentity = bindingIdentity(left);
          const rightIdentity = bindingIdentity(right);
          return leftIdentity < rightIdentity ? -1 : (leftIdentity > rightIdentity ? 1 : 0);
        }]);
        return Object.freeze({
          records: Object.freeze(projectedRecords),
          portableBindings: Object.freeze(bindings),
        });
      } catch (error) {
        if (isProjectArchiveError(error)) throw error;
        return invalid();
      }
    },
  });
}

module.exports = Object.freeze({ createProjectArchiveV21PortableSnapshot });
