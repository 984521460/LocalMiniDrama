'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual, types } = require('node:util');

const { RECORD_NAMES, RECORD_SPECS } = require('../../adapters/v2/zip/manifest');
const {
  STRUCTURED_RECORD_SPECS,
  createProjectArchiveV21StructuredData,
} = require('../../adapters/v2/zip/projectArchiveV21StructuredData');
const {
  LEGACY_RECORD_SPECS,
  createProjectArchiveV21LegacyData,
} = require('../../adapters/v2/compat/projectArchiveV21LegacyData');
const { archiveError, isProjectArchiveError } = require('../../adapters/v2/zip/errors');
const { createProjectArchiveRepository } = require('./projectArchiveRepository');
const { projectArchiveRecordsForManifest } = require('../../services/projectArchiveSourceEvidence');
const { assertDatabase } = require('./repositorySupport');

const LEGACY_ORDER = Object.freeze([
  'dramas', 'characters', 'episodes', 'scenes', 'props', 'storyboards',
  'episodeCharacters', 'storyboardCharacters', 'storyboardProps',
  'characterLibraries', 'sceneLibraries', 'propLibraries', 'legacyAssets',
  'framePrompts', 'imageGenerations', 'videoGenerations', 'videoMerges',
]);
const STRUCTURED_ORDER = Object.freeze([
  'narrativeResults', 'narrativeReviewEvents', 'narrativeStaleEvents',
  'characterIdentityVersions', 'characterAppearanceVersions',
  'characterCostumeVersions', 'characterVoiceVersions', 'sceneVersions', 'propVersions',
  'characterCandidateResults', 'characterCandidateBatches', 'characterIdentityLockEvents',
  'characterReferencePackageItems', 'characterReferencePackages',
  'shotContinuityCharacterRefs', 'shotContinuityPropRefs', 'shotContinuitySnapshots',
  'voiceProfiles', 'voiceProfileSelectionEvents', 'bgmLicenses', 'bgmTracks',
]);
const PORTABLE_INSERT_COLUMNS = Object.freeze([
  'drama_uid', 'table_name', 'row_uid', 'column_name', 'schema_version',
  'binding_state', 'marker_count', 'portable_value_json',
]);
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SORT = Array.prototype.sort;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const HAS_OWN = Object.prototype.hasOwnProperty;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_IS = Object.is;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function dataSnapshotsEqual(left, right) {
  const pending = [[left, right]];
  const compared = new WeakMap();
  let cursor = 0;
  while (cursor < pending.length) {
    const pair = pending[cursor];
    cursor += 1;
    const leftValue = pair[0];
    const rightValue = pair[1];
    if (REFLECT_APPLY(OBJECT_IS, Object, [leftValue, rightValue])) continue;
    if (leftValue === null || rightValue === null
      || typeof leftValue !== 'object' || typeof rightValue !== 'object'
      || types.isProxy(leftValue) || types.isProxy(rightValue)) return false;

    const leftIsArray = REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [leftValue]);
    const rightIsArray = REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [rightValue]);
    if (leftIsArray !== rightIsArray) return false;
    const leftPrototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [leftValue]);
    const rightPrototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [rightValue]);
    if (leftIsArray) {
      if (leftPrototype !== Array.prototype || rightPrototype !== Array.prototype) return false;
    } else if ((leftPrototype !== null && leftPrototype !== Object.prototype)
      || (rightPrototype !== null && rightPrototype !== Object.prototype)) return false;

    let rightPairs = REFLECT_APPLY(WEAK_MAP_GET, compared, [leftValue]);
    if (rightPairs === undefined) {
      rightPairs = new WeakSet();
      REFLECT_APPLY(WEAK_MAP_SET, compared, [leftValue, rightPairs]);
    } else if (REFLECT_APPLY(WEAK_SET_HAS, rightPairs, [rightValue])) continue;
    REFLECT_APPLY(WEAK_SET_ADD, rightPairs, [rightValue]);

    const leftDescriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [leftValue]);
    const rightDescriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [rightValue]);
    const leftKeys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [leftDescriptors]);
    const rightKeys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [rightDescriptors]);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index];
      if (typeof key !== 'string'
        || !REFLECT_APPLY(HAS_OWN, rightDescriptors, [key])) return false;
      const leftDescriptor = leftDescriptors[key];
      const rightDescriptor = rightDescriptors[key];
      if (!REFLECT_APPLY(HAS_OWN, leftDescriptor, ['value'])
        || !REFLECT_APPLY(HAS_OWN, rightDescriptor, ['value'])
        || leftDescriptor.enumerable !== rightDescriptor.enumerable) return false;
      pending[pending.length] = [leftDescriptor.value, rightDescriptor.value];
    }
  }
  return true;
}

function fail() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function canonicalJson(value) {
  const parts = [];
  function write(candidate, depth) {
    if (depth > 64) fail();
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      parts[parts.length] = REFLECT_APPLY(JSON_STRINGIFY, JSON, [candidate]);
      return;
    }
    if (typeof candidate === 'number') {
      if (!REFLECT_APPLY(NUMBER_IS_FINITE, Number, [candidate])) fail();
      parts[parts.length] = REFLECT_APPLY(JSON_STRINGIFY, JSON, [candidate]);
      return;
    }
    if (typeof candidate !== 'object' || types.isProxy(candidate)) fail();
    const descriptors = REFLECT_APPLY(GET_OWN_PROPERTY_DESCRIPTORS, Object, [candidate]);
    const array = REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [candidate]);
    if (array) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !REFLECT_APPLY(HAS_OWN, lengthDescriptor, ['value'])
        || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [lengthDescriptor.value])
        || lengthDescriptor.value < 0) fail();
      const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
      if (keys.length !== lengthDescriptor.value + 1) fail();
      parts[parts.length] = '[';
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true
          || !REFLECT_APPLY(HAS_OWN, descriptor, ['value'])) fail();
        if (index > 0) parts[parts.length] = ',';
        write(descriptor.value, depth + 1);
      }
      parts[parts.length] = ']';
      return;
    }
    const prototype = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [candidate]);
    if (prototype !== null && prototype !== Object.prototype) fail();
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail();
    }
    REFLECT_APPLY(ARRAY_SORT, keys, []);
    parts[parts.length] = '{';
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (!descriptor || descriptor.enumerable !== true
        || !REFLECT_APPLY(HAS_OWN, descriptor, ['value'])) fail();
      if (index > 0) parts[parts.length] = ',';
      parts[parts.length] = REFLECT_APPLY(JSON_STRINGIFY, JSON, [keys[index]]);
      parts[parts.length] = ':';
      write(descriptor.value, depth + 1);
    }
    parts[parts.length] = '}';
  }
  write(value, 0);
  return REFLECT_APPLY(ARRAY_JOIN, parts, ['']);
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail();
  return `"${value.replaceAll('"', '""')}"`;
}

function serializeRow(spec, row, extra = null) {
  const output = {};
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    if (column === 'credential_binding_state') continue;
    const value = row[column];
    output[column] = spec.json?.[column] && value !== null && typeof value !== 'string'
      ? canonicalJson(value) : value;
  }
  if (extra) Object.assign(output, extra);
  return output;
}

function createInsert(database, table, columns) {
  const quotedColumns = new Array(columns.length);
  const parameters = new Array(columns.length);
  for (let index = 0; index < columns.length; index += 1) {
    quotedColumns[index] = quoteIdentifier(columns[index]);
    parameters[index] = `@${columns[index]}`;
  }
  return database.prepare(`
    INSERT INTO ${quoteIdentifier(table)} (${REFLECT_APPLY(ARRAY_JOIN, quotedColumns, [','])})
    VALUES (${REFLECT_APPLY(ARRAY_JOIN, parameters, [','])})
  `);
}

function targetTables() {
  const seen = new Set();
  const tables = [];
  function add(table) {
    if (REFLECT_APPLY(SET_HAS, seen, [table])) return;
    REFLECT_APPLY(SET_ADD, seen, [table]);
    tables[tables.length] = table;
  }
  add('project_archive_v21_portable_bindings');
  for (let index = 0; index < LEGACY_ORDER.length; index += 1) {
    add(LEGACY_RECORD_SPECS[LEGACY_ORDER[index]].table);
  }
  for (let index = 0; index < RECORD_NAMES.length; index += 1) {
    add(RECORD_SPECS[RECORD_NAMES[index]].table);
  }
  for (let index = 0; index < STRUCTURED_ORDER.length; index += 1) {
    add(STRUCTURED_RECORD_SPECS[STRUCTURED_ORDER[index]].table);
  }
  REFLECT_APPLY(ARRAY_SORT, tables, []);
  return tables;
}

function createProjectArchiveV21ImportRepository(database) {
  assertDatabase(database);
  const tables = targetTables();
  const placeholderValues = new Array(tables.length);
  for (let index = 0; index < tables.length; index += 1) placeholderValues[index] = '?';
  const placeholders = REFLECT_APPLY(ARRAY_JOIN, placeholderValues, [',']);
  const triggerReader = database.prepare(`
    SELECT name,sql FROM sqlite_schema
    WHERE type='trigger' AND tbl_name IN (${placeholders})
    ORDER BY name
  `);
  const dramaByUid = database.prepare('SELECT id FROM dramas WHERE uid=? AND deleted_at IS NULL');
  const portableReader = database.prepare(`
    SELECT table_name,row_uid,column_name,schema_version,binding_state,marker_count,
           portable_value_json
    FROM project_archive_v21_portable_bindings
    WHERE drama_uid=?
    ORDER BY table_name,row_uid,column_name
  `);
  const legacyInserts = {};
  for (let index = 0; index < LEGACY_ORDER.length; index += 1) {
    const name = LEGACY_ORDER[index];
    const spec = LEGACY_RECORD_SPECS[name];
    legacyInserts[name] = createInsert(database, spec.table, spec.columns);
  }
  Object.freeze(legacyInserts);
  const currentInserts = {};
  for (let index = 0; index < RECORD_NAMES.length; index += 1) {
    const name = RECORD_NAMES[index];
    const spec = RECORD_SPECS[name];
    const columns = new Array(spec.columns.length);
    for (let columnIndex = 0; columnIndex < spec.columns.length; columnIndex += 1) {
      columns[columnIndex] = spec.columns[columnIndex];
    }
    if (name === 'sourceDocuments') columns[columns.length] = 'block_count';
    currentInserts[name] = createInsert(database, spec.table, columns);
  }
  Object.freeze(currentInserts);
  const structuredInserts = {};
  for (let index = 0; index < STRUCTURED_ORDER.length; index += 1) {
    const name = STRUCTURED_ORDER[index];
    const spec = STRUCTURED_RECORD_SPECS[name];
    const columns = [];
    for (let columnIndex = 0; columnIndex < spec.columns.length; columnIndex += 1) {
      if (spec.columns[columnIndex] !== 'credential_binding_state') {
        columns[columns.length] = spec.columns[columnIndex];
      }
    }
    if (name === 'voiceProfiles') {
      columns[columns.length] = 'credential_ref';
      columns[columns.length] = 'archive_binding_state';
    }
    structuredInserts[name] = createInsert(database, spec.table, columns);
  }
  Object.freeze(structuredInserts);
  const portableInsert = createInsert(
    database,
    'project_archive_v21_portable_bindings',
    PORTABLE_INSERT_COLUMNS,
  );
  let expectedTriggers = null;

  function captureTriggers() {
    const rows = triggerReader.all(...tables);
    for (let index = 0; index < rows.length; index += 1) {
      if (typeof rows[index].name !== 'string' || typeof rows[index].sql !== 'string'
        || rows[index].sql.length === 0) fail();
    }
    return rows;
  }

  function dropTriggers(rows) {
    for (let index = 0; index < rows.length; index += 1) {
      database.exec(`DROP TRIGGER ${quoteIdentifier(rows[index].name)}`);
    }
  }

  function restoreTriggers(rows) {
    for (let index = 0; index < rows.length; index += 1) database.exec(rows[index].sql);
    const restored = captureTriggers();
    if (!isDeepStrictEqual(restored, rows)) fail();
  }

  function insertLegacy(manifest) {
    for (let nameIndex = 0; nameIndex < LEGACY_ORDER.length; nameIndex += 1) {
      const name = LEGACY_ORDER[nameIndex];
      const spec = LEGACY_RECORD_SPECS[name];
      const rows = manifest.legacyRecords[name];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        legacyInserts[name].run(serializeRow(spec, rows[rowIndex]));
      }
    }
  }

  function insertCurrent(manifest) {
    const blockCounts = new Map();
    for (let index = 0; index < manifest.records.sourceDocuments.length; index += 1) {
      REFLECT_APPLY(MAP_SET, blockCounts, [manifest.records.sourceDocuments[index].uid, 0]);
    }
    for (let index = 0; index < manifest.records.sourceBlocks.length; index += 1) {
      const uid = manifest.records.sourceBlocks[index].document_uid;
      REFLECT_APPLY(MAP_SET, blockCounts, [uid, REFLECT_APPLY(MAP_GET, blockCounts, [uid]) + 1]);
    }
    for (let nameIndex = 0; nameIndex < RECORD_NAMES.length; nameIndex += 1) {
      const name = RECORD_NAMES[nameIndex];
      const spec = RECORD_SPECS[name];
      const rows = manifest.records[name];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const extra = name === 'sourceDocuments'
          ? { block_count: REFLECT_APPLY(MAP_GET, blockCounts, [row.uid]) } : null;
        currentInserts[name].run(serializeRow(spec, row, extra));
      }
    }
  }

  function insertStructured(manifest) {
    for (let nameIndex = 0; nameIndex < STRUCTURED_ORDER.length; nameIndex += 1) {
      const name = STRUCTURED_ORDER[nameIndex];
      const spec = STRUCTURED_RECORD_SPECS[name];
      const rows = manifest.structuredRecords[name];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const extra = name === 'voiceProfiles'
          ? {
            credential_ref: `credential:v1:${randomUUID()}`,
            archive_binding_state: 'needs_rebind',
          }
          : null;
        structuredInserts[name].run(serializeRow(spec, rows[rowIndex], extra));
      }
    }
  }

  function insertPortableBindings(manifest) {
    for (let index = 0; index < manifest.portableBindings.length; index += 1) {
      const binding = manifest.portableBindings[index];
      portableInsert.run({
        drama_uid: manifest.project.dramaUid,
        table_name: binding.table,
        row_uid: binding.row_uid,
        column_name: binding.column,
        schema_version: binding.portable_field.schema_version,
        binding_state: binding.portable_field.binding_state,
        marker_count: binding.portable_field.marker_count,
        portable_value_json: binding.portable_field.portable_value === null
          ? null
          : canonicalJson(binding.portable_field.portable_value),
      });
    }
  }

  function importedPortableBindings(dramaUid) {
    const rows = portableReader.all(dramaUid);
    const bindings = new Array(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      bindings[index] = {
        table: row.table_name,
        row_uid: row.row_uid,
        column: row.column_name,
        portable_field: {
          schema_version: row.schema_version,
          binding_state: row.binding_state,
          marker_count: row.marker_count,
          portable_value: row.portable_value_json === null
            ? null
            : JSON.parse(row.portable_value_json),
        },
      };
    }
    return bindings;
  }

  function assertSnapshot(manifest) {
    const drama = dramaByUid.get(manifest.project.dramaUid);
    if (!drama) fail();
    const current = createProjectArchiveRepository(database).exportSnapshot(drama.id);
    const checks = [
      Boolean(current),
      Boolean(current) && dataSnapshotsEqual(current.project, manifest.project),
      Boolean(current) && dataSnapshotsEqual(projectArchiveRecordsForManifest(current.records), manifest.records),
      dataSnapshotsEqual(
        createProjectArchiveV21StructuredData(database).exportForDrama(manifest.project.dramaUid),
        manifest.structuredRecords,
      ),
      dataSnapshotsEqual(
        createProjectArchiveV21LegacyData(database).exportForDrama(manifest.project.dramaUid),
        manifest.legacyRecords,
      ),
      dataSnapshotsEqual(
        importedPortableBindings(manifest.project.dramaUid),
        manifest.portableBindings,
      ),
    ];
    for (let index = 0; index < checks.length; index += 1) if (!checks[index]) fail();
  }

  function importInsideTransaction(manifest) {
    if (!database.inTransaction) fail();
    const triggers = captureTriggers();
    expectedTriggers = triggers;
    database.pragma('defer_foreign_keys = ON');
    dropTriggers(triggers);
    try {
      insertLegacy(manifest);
      insertCurrent(manifest);
      insertStructured(manifest);
      insertPortableBindings(manifest);
      restoreTriggers(triggers);
    } catch (error) {
      try {
        const current = captureTriggers();
        if (!isDeepStrictEqual(current, triggers)) restoreTriggers(triggers);
      } catch {}
      throw error;
    }
    assertSnapshot(manifest);
  }

  return Object.freeze({
    assertImportable(manifest) {
      if (database.inTransaction) fail();
      const rollback = Object.freeze({});
      const dryRun = database.transaction(() => {
        importInsideTransaction(manifest);
        if (!isDeepStrictEqual(captureTriggers(), expectedTriggers)
          || database.pragma('foreign_key_check').length !== 0
          || database.pragma('integrity_check', { simple: true }) !== 'ok') fail();
        throw rollback;
      });
      try {
        dryRun.immediate();
      } catch (error) {
        expectedTriggers = null;
        if (error === rollback) return;
        throw error;
      }
      fail();
    },

    importManifest(manifest) {
      importInsideTransaction(manifest);
    },

    assertCommitReady(manifest) {
      if (!database.inTransaction || expectedTriggers === null
        || !isDeepStrictEqual(captureTriggers(), expectedTriggers)) fail();
      assertSnapshot(manifest);
      if (database.pragma('foreign_key_check').length !== 0
        || database.pragma('integrity_check', { simple: true }) !== 'ok') fail();
    },
  });
}

module.exports = { createProjectArchiveV21ImportRepository };
