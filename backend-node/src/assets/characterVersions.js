const { createVersionValidation } = require('./versionValidation');

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const KINDS = Object.freeze(['identity', 'appearance', 'costume', 'voice']);
const CHILD_KINDS = new Set(['appearance', 'costume', 'voice']);

const METADATA_FIELDS = Object.freeze({
  identity: Object.freeze(['name', 'visualSignature', 'colorAnchors']),
  appearance: Object.freeze(['name', 'description', 'colorAnchors']),
  costume: Object.freeze(['name', 'description', 'colorAnchors']),
  voice: Object.freeze(['name', 'language', 'style']),
});

const {
  assertExactKeys,
  canonicalUid,
  colorAnchors,
  exactObject,
  fail,
  optionalEpoch,
  ownDataSnapshot,
  requiredString,
} = createVersionValidation('Character version input is invalid');

function metadataFor(kind, value) {
  const metadata = exactObject(value, METADATA_FIELDS[kind]);
  const output = { name: requiredString(metadata.name, 120) };
  if (kind === 'identity') {
    output.visualSignature = requiredString(metadata.visualSignature, 4000);
    output.colorAnchors = colorAnchors(metadata.colorAnchors);
  } else if (kind === 'appearance' || kind === 'costume') {
    output.description = requiredString(metadata.description, 4000);
    output.colorAnchors = colorAnchors(metadata.colorAnchors);
  } else {
    output.language = requiredString(metadata.language, 16);
    if (!LANGUAGE.test(output.language)) fail();
    output.style = requiredString(metadata.style, 1000);
  }
  return Object.freeze(output);
}

function createCharacterVersionRecord(value) {
  const initial = ownDataSnapshot(value);
  if (initial.schemaVersion !== '5.0' || !KINDS.includes(initial.kind)) fail();
  const child = CHILD_KINDS.has(initial.kind);
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'uid',
    'characterUid',
    ...(child ? ['identityVersionUid'] : []),
    'parentUid',
    'metadata',
    ...(Object.hasOwn(initial, 'createdAtEpochMs') ? ['createdAtEpochMs'] : []),
  ];
  const input = assertExactKeys(initial, expectedKeys);
  const uid = canonicalUid(input.uid);
  const parentUid = canonicalUid(input.parentUid, true);
  if (parentUid === uid) fail();
  const record = {
    schemaVersion: '5.0',
    kind: input.kind,
    uid,
    characterUid: canonicalUid(input.characterUid),
    ...(child ? { identityVersionUid: canonicalUid(input.identityVersionUid) } : {}),
    parentUid,
    metadata: metadataFor(input.kind, input.metadata),
  };
  const createdAtEpochMs = optionalEpoch(input.createdAtEpochMs);
  if (createdAtEpochMs !== undefined) record.createdAtEpochMs = createdAtEpochMs;
  return Object.freeze(record);
}

module.exports = {
  CHARACTER_VERSION_KINDS: KINDS,
  createCharacterVersionRecord,
};
