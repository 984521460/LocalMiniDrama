const { createCompatibilityError } = require('./errors');
const { readExactDataObject } = require('./safeInput');

const CORE_TABLES = Object.freeze({
  dramas: 'dramas',
  episodes: 'episodes',
  characters: 'characters',
  scenes: 'scenes',
  props: 'props',
  storyboards: 'storyboards',
});
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function storageFailure() {
  throw createCompatibilityError('V2_COMPATIBILITY_STORAGE_FAILED');
}

function mappingFailure() {
  throw createCompatibilityError();
}

function createCoreReferenceAdapter(database) {
  let prepare;
  try {
    prepare = database?.prepare;
  } catch {
    storageFailure();
  }
  if (typeof prepare !== 'function') storageFailure();

  let statements;
  try {
    statements = Object.create(null);
    for (const [entity, table] of Object.entries(CORE_TABLES)) {
      statements[entity] = Object.freeze({
        byLegacyId: Reflect.apply(prepare, database, [`SELECT id, uid FROM ${table} WHERE id = ?`]),
        byUid: Reflect.apply(prepare, database, [`SELECT id, uid FROM ${table} WHERE uid = ?`]),
      });
    }
    Object.freeze(statements);
  } catch {
    storageFailure();
  }

  function snapshotDatabaseRow(row) {
    if (!row || typeof row !== 'object') mappingFailure();
    let isArray;
    let prototype;
    let keys;
    let idDescriptor;
    let uidDescriptor;
    try {
      isArray = Array.isArray(row);
      prototype = Reflect.getPrototypeOf(row);
      keys = Reflect.ownKeys(row);
      idDescriptor = Reflect.getOwnPropertyDescriptor(row, 'id');
      uidDescriptor = Reflect.getOwnPropertyDescriptor(row, 'uid');
    } catch {
      storageFailure();
    }
    if (
      isArray
      || (prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || !keys.includes('id')
      || !keys.includes('uid')
      || !idDescriptor?.enumerable
      || !uidDescriptor?.enumerable
      || !Object.hasOwn(idDescriptor, 'value')
      || !Object.hasOwn(uidDescriptor, 'value')
    ) mappingFailure();
    return Object.freeze({ id: idDescriptor.value, uid: uidDescriptor.value });
  }

  function resolveCoreReference(value) {
    const input = readExactDataObject(value, ['entity'], ['legacyId', 'uid']);
    const entity = input.entity;
    const entityStatements = (
      typeof entity === 'string' && Object.hasOwn(statements, entity)
    ) ? statements[entity] : undefined;
    const hasLegacyId = Object.hasOwn(input, 'legacyId');
    const hasUid = Object.hasOwn(input, 'uid');

    if (!entityStatements || (!hasLegacyId && !hasUid)) mappingFailure();
    if (hasLegacyId && (!Number.isSafeInteger(input.legacyId) || input.legacyId <= 0)) mappingFailure();
    if (hasUid && (typeof input.uid !== 'string' || !UUID_V4_PATTERN.test(input.uid))) mappingFailure();

    let row;
    try {
      row = hasLegacyId
        ? entityStatements.byLegacyId.get(input.legacyId)
        : entityStatements.byUid.get(input.uid);
    } catch {
      storageFailure();
    }

    if (!row) mappingFailure();
    const rowSnapshot = snapshotDatabaseRow(row);
    if (
      !Number.isSafeInteger(rowSnapshot.id)
      || rowSnapshot.id <= 0
      || typeof rowSnapshot.uid !== 'string'
      || !UUID_V4_PATTERN.test(rowSnapshot.uid)
      || (hasLegacyId && rowSnapshot.id !== input.legacyId)
      || (hasUid && rowSnapshot.uid !== input.uid)
    ) mappingFailure();

    return Object.freeze({ entity, legacyId: rowSnapshot.id, uid: rowSnapshot.uid });
  }

  return Object.freeze({ resolveCoreReference });
}

module.exports = {
  createCoreReferenceAdapter,
};
