const { createVersionValidation } = require('./versionValidation');

const ITEM_KINDS = Object.freeze([
  'front_half_body',
  'three_quarter_face',
  'left_profile',
  'right_profile',
  'front_full_body',
  'expression_neutral',
  'expression_joy',
  'expression_anger',
  'expression_sadness',
  'expression_fear',
]);
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SHA256 = /^[0-9a-f]{64}$/u;
const validation = createVersionValidation('Character reference package input is invalid');

function denseArray(value, expectedLength, mapper) {
  let descriptors;
  try {
    if (!Array.isArray(value)) validation.fail();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    validation.fail();
  }
  const length = descriptors.length?.value;
  if (length !== expectedLength) validation.fail();
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== expectedLength) validation.fail();
  return Object.freeze(Array.from({ length: expectedLength }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      validation.fail();
    }
    return mapper(descriptor.value, index);
  }));
}

function referenceVersion(value, fieldName) {
  const input = validation.exactObject(value, ['uid', 'name', 'description', 'colorAnchors']);
  return Object.freeze({
    uid: validation.canonicalUid(input.uid),
    name: validation.requiredString(input.name, 120),
    description: validation.requiredString(input.description, 4000),
    colorAnchors: validation.colorAnchors(input.colorAnchors),
    kind: fieldName,
  });
}

function itemRecord(value, ordinal, characterUid, packageUid) {
  const input = validation.exactObject(value, [
    'uid',
    'ordinal',
    'kind',
    'assetVersionUid',
    'logicalUri',
    'mediaType',
    'width',
    'height',
    'contentSha256',
  ]);
  const kind = ITEM_KINDS[ordinal];
  const expectedUri = `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`;
  if (
    input.ordinal !== ordinal
    || input.kind !== kind
    || input.logicalUri !== expectedUri
    || !MEDIA_TYPES.has(input.mediaType)
    || !Number.isSafeInteger(input.width)
    || input.width < 64
    || input.width > 8192
    || !Number.isSafeInteger(input.height)
    || input.height < 64
    || input.height > 8192
    || typeof input.contentSha256 !== 'string'
    || !SHA256.test(input.contentSha256)
  ) validation.fail();
  return Object.freeze({
    uid: validation.canonicalUid(input.uid),
    ordinal,
    kind,
    assetVersionUid: validation.canonicalUid(input.assetVersionUid),
    logicalUri: expectedUri,
    mediaType: input.mediaType,
    width: input.width,
    height: input.height,
    contentSha256: input.contentSha256,
  });
}

function createCharacterReferencePackage(value) {
  const input = validation.exactObject(value, [
    'schemaVersion',
    'packageUid',
    'characterUid',
    'identityVersionUid',
    'candidateUid',
    'lockEventUid',
    'lockStateVersion',
    'appearanceVersion',
    'defaultCostumeVersion',
    'items',
    'createdAtEpochMs',
  ]);
  if (
    input.schemaVersion !== '5.0'
    || !Number.isSafeInteger(input.lockStateVersion)
    || input.lockStateVersion < 1
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999
  ) validation.fail();
  const packageUid = validation.canonicalUid(input.packageUid);
  const characterUid = validation.canonicalUid(input.characterUid);
  const appearanceVersion = referenceVersion(input.appearanceVersion, 'appearance');
  const defaultCostumeVersion = referenceVersion(input.defaultCostumeVersion, 'costume');
  const items = denseArray(
    input.items,
    ITEM_KINDS.length,
    (item, ordinal) => itemRecord(item, ordinal, characterUid, packageUid),
  );
  if (
    new Set(items.map((item) => item.uid)).size !== items.length
    || new Set(items.map((item) => item.assetVersionUid)).size !== items.length
    || new Set(items.map((item) => item.contentSha256)).size !== items.length
  ) validation.fail();
  return Object.freeze({
    schemaVersion: '5.0',
    packageUid,
    characterUid,
    identityVersionUid: validation.canonicalUid(input.identityVersionUid),
    candidateUid: validation.canonicalUid(input.candidateUid),
    lockEventUid: validation.canonicalUid(input.lockEventUid),
    lockStateVersion: input.lockStateVersion,
    appearanceVersion: Object.freeze({
      uid: appearanceVersion.uid,
      name: appearanceVersion.name,
      description: appearanceVersion.description,
      colorAnchors: appearanceVersion.colorAnchors,
    }),
    defaultCostumeVersion: Object.freeze({
      uid: defaultCostumeVersion.uid,
      name: defaultCostumeVersion.name,
      description: defaultCostumeVersion.description,
      colorAnchors: defaultCostumeVersion.colorAnchors,
    }),
    items,
    createdAtEpochMs: input.createdAtEpochMs,
  });
}

function createCharacterReferencePackageInput(value) {
  const input = validation.exactObject(value, [
    'packageUid',
    'characterUid',
    'appearanceVersionUid',
    'costumeVersionUid',
    'expectedLockStateVersion',
    'createdAtEpochMs',
    'items',
  ]);
  if (
    !Number.isSafeInteger(input.expectedLockStateVersion)
    || input.expectedLockStateVersion < 1
    || !Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0
    || input.createdAtEpochMs > 253402300799999
  ) validation.fail();
  const items = denseArray(input.items, ITEM_KINDS.length, (item, ordinal) => {
    const entry = validation.exactObject(item, ['uid', 'ordinal', 'kind', 'assetVersionUid']);
    if (entry.ordinal !== ordinal || entry.kind !== ITEM_KINDS[ordinal]) validation.fail();
    return Object.freeze({
      uid: validation.canonicalUid(entry.uid),
      ordinal,
      kind: entry.kind,
      assetVersionUid: validation.canonicalUid(entry.assetVersionUid),
    });
  });
  if (
    new Set(items.map((item) => item.uid)).size !== items.length
    || new Set(items.map((item) => item.assetVersionUid)).size !== items.length
  ) validation.fail();
  return Object.freeze({
    packageUid: validation.canonicalUid(input.packageUid),
    characterUid: validation.canonicalUid(input.characterUid),
    appearanceVersionUid: validation.canonicalUid(input.appearanceVersionUid),
    costumeVersionUid: validation.canonicalUid(input.costumeVersionUid),
    expectedLockStateVersion: input.expectedLockStateVersion,
    createdAtEpochMs: input.createdAtEpochMs,
    items,
  });
}

function createCharacterReferencePackageRequest(value) {
  const input = validation.exactObject(value, [
    'appearance_version_uid',
    'costume_version_uid',
    'expected_lock_state_version',
    'items',
  ]);
  if (
    !Number.isSafeInteger(input.expected_lock_state_version)
    || input.expected_lock_state_version < 1
  ) validation.fail();
  const items = denseArray(input.items, ITEM_KINDS.length, (item, ordinal) => {
    const entry = validation.exactObject(item, ['kind', 'asset_version_uid']);
    if (entry.kind !== ITEM_KINDS[ordinal]) validation.fail();
    return Object.freeze({
      kind: entry.kind,
      assetVersionUid: validation.canonicalUid(entry.asset_version_uid),
    });
  });
  if (new Set(items.map((item) => item.assetVersionUid)).size !== items.length) validation.fail();
  return Object.freeze({
    appearanceVersionUid: validation.canonicalUid(input.appearance_version_uid),
    costumeVersionUid: validation.canonicalUid(input.costume_version_uid),
    expectedLockStateVersion: input.expected_lock_state_version,
    items,
  });
}

module.exports = {
  CHARACTER_REFERENCE_ITEM_KINDS: ITEM_KINDS,
  createCharacterReferencePackage,
  createCharacterReferencePackageInput,
  createCharacterReferencePackageRequest,
};
