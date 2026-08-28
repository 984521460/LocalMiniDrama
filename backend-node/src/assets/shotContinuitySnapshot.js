const { createVersionValidation } = require('./versionValidation');

const validation = createVersionValidation('Shot continuity snapshot input is invalid');
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;

function denseArray(value, maxLength, mapper) {
  let descriptors;
  try {
    if (!Array.isArray(value)) validation.fail();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof TypeError
      && error.message === 'Shot continuity snapshot input is invalid') throw error;
    validation.fail();
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) validation.fail();
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== length) validation.fail();
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      validation.fail();
    }
    return mapper(descriptor.value, index);
  }));
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) validation.fail();
  return value;
}

function hash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) validation.fail();
  return value;
}

function sceneRecord(value) {
  const input = validation.exactObject(value, [
    'sceneUid', 'versionUid', 'name', 'visualDescription', 'lighting', 'colorAnchors',
  ]);
  return Object.freeze({
    sceneUid: validation.canonicalUid(input.sceneUid),
    versionUid: validation.canonicalUid(input.versionUid),
    name: validation.requiredString(input.name, 120),
    visualDescription: validation.requiredString(input.visualDescription, 4000),
    lighting: validation.requiredString(input.lighting, 1000),
    colorAnchors: validation.colorAnchors(input.colorAnchors),
  });
}

function characterRecord(value) {
  const input = validation.exactObject(value, [
    'factRef',
    'characterUid',
    'referencePackageUid',
    'identityVersionUid',
    'costumeVersionUid',
  ]);
  return Object.freeze({
    factRef: identifier(input.factRef),
    characterUid: validation.canonicalUid(input.characterUid),
    referencePackageUid: validation.canonicalUid(input.referencePackageUid),
    identityVersionUid: validation.canonicalUid(input.identityVersionUid),
    costumeVersionUid: validation.canonicalUid(input.costumeVersionUid),
  });
}

function propRecord(value) {
  const input = validation.exactObject(value, [
    'factRef', 'propUid', 'versionUid', 'name', 'visualDescription', 'colorAnchors',
  ]);
  return Object.freeze({
    factRef: identifier(input.factRef),
    propUid: validation.canonicalUid(input.propUid),
    versionUid: validation.canonicalUid(input.versionUid),
    name: validation.requiredString(input.name, 120),
    visualDescription: validation.requiredString(input.visualDescription, 4000),
    colorAnchors: validation.colorAnchors(input.colorAnchors),
  });
}

function createSceneBinding(value) {
  const input = validation.exactObject(value, ['sceneUid', 'versionUid']);
  return Object.freeze({
    sceneUid: validation.canonicalUid(input.sceneUid),
    versionUid: validation.canonicalUid(input.versionUid),
  });
}

function createCharacterBinding(value) {
  const input = validation.exactObject(value, [
    'factRef', 'characterUid', 'referencePackageUid', 'costumeVersionUid',
  ]);
  return Object.freeze({
    factRef: identifier(input.factRef),
    characterUid: validation.canonicalUid(input.characterUid),
    referencePackageUid: validation.canonicalUid(input.referencePackageUid),
    costumeVersionUid: validation.canonicalUid(input.costumeVersionUid),
  });
}

function createPropBinding(value) {
  const input = validation.exactObject(value, ['factRef', 'propUid', 'versionUid']);
  return Object.freeze({
    factRef: identifier(input.factRef),
    propUid: validation.canonicalUid(input.propUid),
    versionUid: validation.canonicalUid(input.versionUid),
  });
}

function createShotContinuitySnapshotInput(value) {
  const input = validation.exactObject(value, [
    'snapshotUid',
    'dramaUid',
    'shotResultUid',
    'shotResultHash',
    'shotEnvelopeHash',
    'shotApprovalRef',
    'shotId',
    'shotOrdinal',
    'scene',
    'characters',
    'props',
    'createdAtEpochMs',
  ]);
  if (
    typeof input.shotApprovalRef !== 'string'
    || !REVIEW_REF.test(input.shotApprovalRef)
    || !Number.isSafeInteger(input.shotOrdinal)
    || input.shotOrdinal < 1
    || input.shotOrdinal > 6
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999
  ) validation.fail();
  const characters = denseArray(input.characters, 128, createCharacterBinding);
  const props = denseArray(input.props, 128, createPropBinding);
  unique(characters, ['factRef', 'characterUid']);
  unique(props, ['factRef', 'propUid']);
  return Object.freeze({
    snapshotUid: validation.canonicalUid(input.snapshotUid),
    dramaUid: validation.canonicalUid(input.dramaUid),
    shotResultUid: validation.canonicalUid(input.shotResultUid),
    shotResultHash: hash(input.shotResultHash),
    shotEnvelopeHash: hash(input.shotEnvelopeHash),
    shotApprovalRef: input.shotApprovalRef,
    shotId: identifier(input.shotId),
    shotOrdinal: input.shotOrdinal,
    scene: createSceneBinding(input.scene),
    characters,
    props,
    createdAtEpochMs: input.createdAtEpochMs,
  });
}

function createShotContinuitySnapshotRequest(value) {
  const input = validation.exactObject(value, ['scene', 'characters', 'props']);
  const scene = validation.exactObject(input.scene, ['scene_uid', 'version_uid']);
  const characters = denseArray(input.characters, 128, (value) => {
    const entry = validation.exactObject(value, [
      'fact_ref', 'character_uid', 'reference_package_uid', 'costume_version_uid',
    ]);
    return createCharacterBinding({
      factRef: entry.fact_ref,
      characterUid: entry.character_uid,
      referencePackageUid: entry.reference_package_uid,
      costumeVersionUid: entry.costume_version_uid,
    });
  });
  const props = denseArray(input.props, 128, (value) => {
    const entry = validation.exactObject(value, ['fact_ref', 'prop_uid', 'version_uid']);
    return createPropBinding({
      factRef: entry.fact_ref,
      propUid: entry.prop_uid,
      versionUid: entry.version_uid,
    });
  });
  unique(characters, ['factRef', 'characterUid']);
  unique(props, ['factRef', 'propUid']);
  return Object.freeze({
    scene: createSceneBinding({ sceneUid: scene.scene_uid, versionUid: scene.version_uid }),
    characters,
    props,
  });
}

function unique(records, fields) {
  for (const field of fields) {
    if (new Set(records.map((record) => record[field])).size !== records.length) validation.fail();
  }
}

function createShotContinuitySnapshot(value) {
  const input = validation.exactObject(value, [
    'schemaVersion',
    'snapshotUid',
    'dramaUid',
    'shotResultUid',
    'shotResultHash',
    'shotEnvelopeHash',
    'shotApprovalRef',
    'shotId',
    'shotOrdinal',
    'scene',
    'characters',
    'props',
    'createdAtEpochMs',
  ]);
  if (
    input.schemaVersion !== '5.0'
    || typeof input.shotApprovalRef !== 'string'
    || !REVIEW_REF.test(input.shotApprovalRef)
    || !Number.isSafeInteger(input.shotOrdinal)
    || input.shotOrdinal < 1
    || input.shotOrdinal > 6
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999
  ) validation.fail();
  const characters = denseArray(input.characters, 128, characterRecord);
  const props = denseArray(input.props, 128, propRecord);
  unique(characters, ['factRef', 'characterUid']);
  unique(props, ['factRef', 'propUid']);
  return Object.freeze({
    schemaVersion: '5.0',
    snapshotUid: validation.canonicalUid(input.snapshotUid),
    dramaUid: validation.canonicalUid(input.dramaUid),
    shotResultUid: validation.canonicalUid(input.shotResultUid),
    shotResultHash: hash(input.shotResultHash),
    shotEnvelopeHash: hash(input.shotEnvelopeHash),
    shotApprovalRef: input.shotApprovalRef,
    shotId: identifier(input.shotId),
    shotOrdinal: input.shotOrdinal,
    scene: sceneRecord(input.scene),
    characters,
    props,
    createdAtEpochMs: input.createdAtEpochMs,
  });
}

function transitionSet(left, right, key, versionFields) {
  const leftByKey = new Map(left.map((record) => [record[key], record]));
  const rightByKey = new Map(right.map((record) => [record[key], record]));
  const unchanged = [];
  const changed = [];
  const exited = [];
  const entered = [];
  for (const [recordKey, before] of leftByKey) {
    const after = rightByKey.get(recordKey);
    if (!after) {
      exited.push(recordKey);
      continue;
    }
    const fields = versionFields.filter((field) => before[field] !== after[field]);
    if (fields.length === 0) unchanged.push(recordKey);
    else changed.push(Object.freeze({ [key]: recordKey, fields: Object.freeze(fields) }));
  }
  for (const recordKey of rightByKey.keys()) {
    if (!leftByKey.has(recordKey)) entered.push(recordKey);
  }
  return Object.freeze({
    unchanged: Object.freeze(unchanged),
    changed: Object.freeze(changed),
    entered: Object.freeze(entered),
    exited: Object.freeze(exited),
  });
}

function compareShotContinuitySnapshots(leftValue, rightValue) {
  const left = createShotContinuitySnapshot(leftValue);
  const right = createShotContinuitySnapshot(rightValue);
  if (
    left.dramaUid !== right.dramaUid
    || left.shotResultUid !== right.shotResultUid
    || left.shotResultHash !== right.shotResultHash
    || left.shotEnvelopeHash !== right.shotEnvelopeHash
    || left.shotApprovalRef !== right.shotApprovalRef
    || right.shotOrdinal !== left.shotOrdinal + 1
  ) validation.fail();
  return Object.freeze({
    schemaVersion: '5.0',
    fromSnapshotUid: left.snapshotUid,
    toSnapshotUid: right.snapshotUid,
    adjacent: true,
    scene: Object.freeze({
      changed: left.scene.sceneUid !== right.scene.sceneUid
        || left.scene.versionUid !== right.scene.versionUid,
      fromSceneUid: left.scene.sceneUid,
      fromVersionUid: left.scene.versionUid,
      toSceneUid: right.scene.sceneUid,
      toVersionUid: right.scene.versionUid,
    }),
    characters: transitionSet(left.characters, right.characters, 'characterUid', [
      'identityVersionUid', 'referencePackageUid', 'costumeVersionUid',
    ]),
    props: transitionSet(left.props, right.props, 'propUid', ['versionUid']),
  });
}

module.exports = {
  compareShotContinuitySnapshots,
  createShotContinuitySnapshot,
  createShotContinuitySnapshotInput,
  createShotContinuitySnapshotRequest,
};
