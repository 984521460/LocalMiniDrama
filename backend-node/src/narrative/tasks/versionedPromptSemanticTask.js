const { createShotContinuitySnapshot } = require('../../assets/shotContinuitySnapshot');
const { types: { isProxy } } = require('node:util');
const { narrativeTaskError } = require('./errors');
const { deepFreeze, sha256Canonical } = require('./jsonSnapshot');
const { completePromptSemantic } = require('./promptSemanticTask');
const { exactObjectValues } = require('./structuredTask');

const TASK_TYPE = 'PromptSemanticVersioningTask';
const SCHEMA_VERSION = 'prompt-semantic-versioned.v1';

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function invalidReference() {
  throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
}

function denseSnapshots(value) {
  let descriptors;
  try {
    if (!Array.isArray(value) || isProxy(value)) invalidInput();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error?.code === 'NARRATIVE_TASK_INPUT_INVALID') throw error;
    return invalidInput();
  }
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
  if (!Number.isSafeInteger(length)
    || length < 4
    || length > 6
    || keys.length !== length) invalidInput();
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return invalidInput();
    }
    try {
      return createShotContinuitySnapshot(descriptor.value);
    } catch {
      return invalidInput();
    }
  }));
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function recordsForFacts(records, factRefs) {
  const byFact = new Map(records.map((record) => [record.factRef, record]));
  if (byFact.size !== records.length
    || !sameValues([...byFact.keys()].sort(), [...factRefs].sort())) invalidReference();
  return factRefs.map((factRef) => byFact.get(factRef));
}

function bindSemanticShot(semanticShot, snapshot) {
  if (semanticShot.shotId !== snapshot.shotId
    || semanticShot.ordinal !== snapshot.shotOrdinal) invalidReference();
  const characters = recordsForFacts(
    snapshot.characters,
    semanticShot.subjects.characterFactRefs,
  ).map((record) => ({
    factRef: record.factRef,
    characterUid: record.characterUid,
    referencePackageUid: record.referencePackageUid,
    identityVersionUid: record.identityVersionUid,
    costumeVersionUid: record.costumeVersionUid,
  }));
  const props = recordsForFacts(
    snapshot.props,
    semanticShot.environment.propFactRefs,
  ).map((record) => ({
    factRef: record.factRef,
    propUid: record.propUid,
    versionUid: record.versionUid,
  }));
  return {
    shotId: semanticShot.shotId,
    ordinal: semanticShot.ordinal,
    durationSeconds: semanticShot.durationSeconds,
    continuitySnapshotUid: snapshot.snapshotUid,
    subjects: {
      description: semanticShot.subjects.description,
      characters,
    },
    environment: {
      sceneId: semanticShot.environment.sceneId,
      description: semanticShot.environment.description,
      scene: {
        sceneUid: snapshot.scene.sceneUid,
        versionUid: snapshot.scene.versionUid,
      },
      props,
    },
    action: semanticShot.action,
    camera: semanticShot.camera,
    lighting: semanticShot.lighting,
    continuity: semanticShot.continuity,
  };
}

function createVersionedPromptSemanticTask() {
  return Object.freeze({
    complete(input) {
      const values = exactObjectValues(input, ['promptInput', 'continuitySnapshots']);
      const snapshots = denseSnapshots(values.continuitySnapshots);
      const completed = completePromptSemantic(values.promptInput);
      const promptResult = completed.result;
      const first = snapshots[0];
      if (promptResult.output.semanticShots.length !== snapshots.length
        || promptResult.upstreamShotHash !== first.shotResultHash
        || completed.shotApproval.envelopeHash !== first.shotEnvelopeHash
        || promptResult.shotApprovalRef !== first.shotApprovalRef
        || snapshots.some((snapshot) => (
          snapshot.dramaUid !== first.dramaUid
          || snapshot.shotResultUid !== first.shotResultUid
          || snapshot.shotResultHash !== first.shotResultHash
          || snapshot.shotEnvelopeHash !== first.shotEnvelopeHash
          || snapshot.shotApprovalRef !== first.shotApprovalRef
        ))) invalidReference();
      const promptResultHash = sha256Canonical(promptResult);
      const output = {
        aspectRatio: promptResult.output.aspectRatio,
        durationSummary: promptResult.output.durationSummary,
        semanticShots: promptResult.output.semanticShots.map(
          (semanticShot, index) => bindSemanticShot(semanticShot, snapshots[index]),
        ),
      };
      return deepFreeze({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        inputHash: sha256Canonical({ promptResultHash, continuitySnapshots: snapshots }),
        upstreamPromptHash: promptResultHash,
        dramaUid: first.dramaUid,
        shotResultUid: first.shotResultUid,
        shotResultHash: first.shotResultHash,
        shotEnvelopeHash: first.shotEnvelopeHash,
        shotApprovalRef: first.shotApprovalRef,
        output,
      });
    },
  });
}

module.exports = {
  SCHEMA_VERSION,
  TASK_TYPE,
  createVersionedPromptSemanticTask,
};
