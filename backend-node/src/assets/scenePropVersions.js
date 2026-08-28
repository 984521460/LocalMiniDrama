const { createVersionValidation } = require('./versionValidation');

const KINDS = Object.freeze(['scene', 'prop']);
const STATES = Object.freeze(['draft', 'ready', 'retired']);
const METADATA_FIELDS = Object.freeze({
  scene: Object.freeze(['name', 'visualDescription', 'lighting', 'colorAnchors']),
  prop: Object.freeze(['name', 'visualDescription', 'colorAnchors']),
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
} = createVersionValidation('Scene or prop version input is invalid');

function metadataFor(kind, value) {
  const metadata = exactObject(value, METADATA_FIELDS[kind]);
  const output = {
    name: requiredString(metadata.name, 120),
    visualDescription: requiredString(metadata.visualDescription, 4000),
    ...(kind === 'scene' ? { lighting: requiredString(metadata.lighting, 1000) } : {}),
    colorAnchors: colorAnchors(metadata.colorAnchors),
  };
  return Object.freeze(output);
}

function createScenePropVersionRecord(value) {
  const initial = ownDataSnapshot(value);
  if (initial.schemaVersion !== '5.0' || !KINDS.includes(initial.kind)) fail();
  const ownerField = initial.kind === 'scene' ? 'sceneUid' : 'propUid';
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'uid',
    ownerField,
    'parentUid',
    'state',
    'metadata',
    ...(Object.hasOwn(initial, 'createdAtEpochMs') ? ['createdAtEpochMs'] : []),
  ];
  const input = assertExactKeys(initial, expectedKeys);
  const uid = canonicalUid(input.uid);
  const parentUid = canonicalUid(input.parentUid, true);
  if (parentUid === uid || !STATES.includes(input.state)) fail();
  const record = {
    schemaVersion: '5.0',
    kind: input.kind,
    uid,
    [ownerField]: canonicalUid(input[ownerField]),
    parentUid,
    state: input.state,
    metadata: metadataFor(input.kind, input.metadata),
  };
  const createdAtEpochMs = optionalEpoch(input.createdAtEpochMs);
  if (createdAtEpochMs !== undefined) record.createdAtEpochMs = createdAtEpochMs;
  return Object.freeze(record);
}

module.exports = {
  SCENE_PROP_VERSION_KINDS: KINDS,
  SCENE_PROP_VERSION_STATES: STATES,
  createScenePropVersionRecord,
};
