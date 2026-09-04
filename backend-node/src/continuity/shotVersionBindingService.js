const { randomUUID } = require('node:crypto');

const { createNarrativeReviewService } = require('../narrative/reviews');
const {
  V2RepositoryConflictError,
} = require('../repositories/v2/errors');
const { createShotVersionBindingStore } = require('./shotVersionBindingStore');

const RESULT_TYPES = Object.freeze(['extraction', 'adaptation', 'script', 'shot']);

function conflict() {
  throw new V2RepositoryConflictError('shot version binding', 'materialized');
}

function approvedDetail(reviewService, resultUid, expectedType) {
  const detail = reviewService.getResult(resultUid);
  if (detail?.result?.resultType !== expectedType
    || detail.result.status !== 'approved'
    || !detail.approval) conflict();
  return detail;
}

function loadApprovedChain(reviewService, resultUid) {
  const shot = approvedDetail(reviewService, resultUid, 'shot');
  const script = approvedDetail(reviewService, shot.result.upstreamResultUid, 'script');
  const adaptation = approvedDetail(reviewService, script.result.upstreamResultUid, 'adaptation');
  const extraction = approvedDetail(
    reviewService,
    adaptation.result.upstreamResultUid,
    'extraction',
  );
  const chain = Object.freeze([extraction, adaptation, script, shot]);
  for (let index = 0; index < chain.length; index += 1) {
    const detail = chain[index];
    if (detail.result.resultType !== RESULT_TYPES[index]
      || detail.result.dramaUid !== shot.result.dramaUid
      || detail.result.sourceSelectionUid !== shot.result.sourceSelectionUid
      || (index === 0
        ? detail.result.upstreamResultUid !== null
        : detail.result.upstreamResultUid !== chain[index - 1].result.uid)) conflict();
  }
  return Object.freeze({ extraction, adaptation, script, shot });
}

function uniqueUid(values) {
  if (values.length !== 1) conflict();
  return values[0];
}

function latestReadyVersion(repository, kind, ownerUid, metadata, createUid, createdAtEpochMs) {
  const versions = repository.list(kind, ownerUid);
  const ready = versions.filter((version) => version.state === 'ready');
  if (ready.length > 0) return ready[ready.length - 1];
  if (versions.length > 0) conflict();
  return repository.create({
    schemaVersion: '5.0',
    kind,
    uid: createUid(),
    [kind === 'scene' ? 'sceneUid' : 'propUid']: ownerUid,
    parentUid: null,
    state: 'ready',
    metadata,
    createdAtEpochMs,
  });
}

function sameCharacter(left, right) {
  return left.factRef === right.factRef
    && left.characterUid === right.characterUid
    && left.referencePackageUid === right.referencePackageUid
    && left.identityVersionUid === right.identityVersionUid
    && left.costumeVersionUid === right.costumeVersionUid;
}

function sameProp(left, right) {
  return left.factRef === right.factRef
    && left.propUid === right.propUid
    && left.versionUid === right.versionUid;
}

function sameOrdered(left, right, comparator) {
  return left.length === right.length
    && left.every((value, index) => comparator(value, right[index]));
}

function assertSnapshotSet(snapshots, expected, chain) {
  const shotRecord = chain.shot.result;
  if (snapshots.length !== expected.length) conflict();
  for (let index = 0; index < expected.length; index += 1) {
    const actual = snapshots[index];
    const planned = expected[index];
    if (actual.dramaUid !== shotRecord.dramaUid
      || actual.shotResultUid !== shotRecord.uid
      || actual.shotResultHash !== shotRecord.resultHash
      || actual.shotEnvelopeHash !== shotRecord.envelopeHash
      || actual.shotApprovalRef !== chain.shot.approval.reviewRef
      || actual.shotId !== planned.shotId
      || actual.shotOrdinal !== planned.shotOrdinal
      || actual.scene.sceneUid !== planned.scene.sceneUid
      || actual.scene.versionUid !== planned.scene.versionUid
      || !sameOrdered(actual.characters, planned.characters, sameCharacter)
      || !sameOrdered(actual.props, planned.props, sameProp)) conflict();
  }
  return snapshots;
}

function createShotVersionBindingService({
  database,
  repositories,
  reviewService = null,
  createUid = randomUUID,
  nowEpochMs = Date.now,
  store = null,
} = {}) {
  if (!database
    || !repositories?.characterCandidates
    || !repositories?.characterReferencePackages
    || !repositories?.scenePropVersions
    || !repositories?.shotContinuitySnapshots
    || typeof createUid !== 'function'
    || typeof nowEpochMs !== 'function') {
    throw new TypeError('Shot version binding service dependencies are invalid');
  }
  const reviews = reviewService || createNarrativeReviewService({ repositories });
  const bindingStore = store || createShotVersionBindingStore(database);

  function buildExpected(chain, createdAtEpochMs) {
    const extraction = chain.extraction.result.result.output;
    const script = chain.script.result.result.output;
    const shotOutput = chain.shot.result.result.output;
    const dramaUid = chain.shot.result.dramaUid;
    const characterFacts = new Map(extraction.characters.map((fact) => [fact.factId, fact]));
    const sceneFacts = new Map(extraction.scenes.map((fact) => [fact.factId, fact]));
    const propFacts = new Map(extraction.props.map((fact) => [fact.factId, fact]));
    const scriptScenes = new Map(script.scenes.map((scene) => [scene.sceneId, scene]));
    const characterBindings = new Map();
    const sceneBindings = new Map();
    const propBindings = new Map();
    const claimedCharacterUids = new Map();
    const claimedSceneUids = new Map();
    const claimedPropUids = new Map();

    function claimOwner(claims, ownerUid, factRef) {
      const existingFactRef = claims.get(ownerUid);
      if (existingFactRef && existingFactRef !== factRef) conflict();
      claims.set(ownerUid, factRef);
    }

    function characterBinding(factRef) {
      if (characterBindings.has(factRef)) return characterBindings.get(factRef);
      const fact = characterFacts.get(factRef);
      if (!fact) conflict();
      const characterUid = uniqueUid(bindingStore.findCharacterUids(dramaUid, fact.name));
      claimOwner(claimedCharacterUids, characterUid, factRef);
      const lock = repositories.characterCandidates.getLockState(characterUid);
      if (lock.status !== 'locked') conflict();
      const packages = repositories.characterReferencePackages.list(characterUid).filter(
        (entry) => entry.characterUid === characterUid
          && entry.identityVersionUid === lock.identityVersionUid
          && entry.candidateUid === lock.candidateUid
          && entry.lockEventUid === lock.eventUid
          && entry.lockStateVersion === lock.stateVersion,
      );
      if (packages.length !== 1) conflict();
      const packageRecord = packages[0];
      const binding = Object.freeze({
        factRef,
        characterUid,
        referencePackageUid: packageRecord.packageUid,
        identityVersionUid: packageRecord.identityVersionUid,
        costumeVersionUid: packageRecord.defaultCostumeVersion.uid,
      });
      characterBindings.set(factRef, binding);
      return binding;
    }

    function sceneBinding(sceneId) {
      const scriptScene = scriptScenes.get(sceneId);
      const fact = scriptScene && sceneFacts.get(scriptScene.sceneFactRef);
      if (!fact) conflict();
      if (sceneBindings.has(fact.factId)) return sceneBindings.get(fact.factId);
      const sceneUid = uniqueUid(bindingStore.findSceneUids(
        dramaUid,
        fact.location,
        fact.time,
      ));
      claimOwner(claimedSceneUids, sceneUid, fact.factId);
      const version = latestReadyVersion(
        repositories.scenePropVersions,
        'scene',
        sceneUid,
        Object.freeze({
          name: fact.location,
          visualDescription: fact.description,
          lighting: fact.time,
          colorAnchors: Object.freeze([]),
        }),
        createUid,
        createdAtEpochMs,
      );
      const binding = Object.freeze({ sceneUid, versionUid: version.uid });
      sceneBindings.set(fact.factId, binding);
      return binding;
    }

    function propBinding(factRef) {
      if (propBindings.has(factRef)) return propBindings.get(factRef);
      const fact = propFacts.get(factRef);
      if (!fact) conflict();
      const propUid = uniqueUid(bindingStore.findPropUids(dramaUid, fact.name));
      claimOwner(claimedPropUids, propUid, factRef);
      const version = latestReadyVersion(
        repositories.scenePropVersions,
        'prop',
        propUid,
        Object.freeze({
          name: fact.name,
          visualDescription: fact.description,
          colorAnchors: Object.freeze([]),
        }),
        createUid,
        createdAtEpochMs,
      );
      const binding = Object.freeze({ factRef, propUid, versionUid: version.uid });
      propBindings.set(factRef, binding);
      return binding;
    }

    return Object.freeze(shotOutput.shots.map((shot) => Object.freeze({
      shotId: shot.shotId,
      shotOrdinal: shot.ordinal,
      scene: sceneBinding(shot.sceneId),
      characters: Object.freeze(shot.characterFactRefs.map(characterBinding)),
      props: Object.freeze(shot.propFactRefs.map(propBinding)),
    })));
  }

  function materialize(resultUid) {
    return bindingStore.immediate(() => {
      const createdAtEpochMs = nowEpochMs();
      if (!Number.isSafeInteger(createdAtEpochMs)
        || createdAtEpochMs < 0
        || createdAtEpochMs > 253402300799999) {
        throw new TypeError('Shot version binding time is invalid');
      }
      const chain = loadApprovedChain(reviews, resultUid);
      const expected = buildExpected(chain, createdAtEpochMs);
      const existing = repositories.shotContinuitySnapshots.list(chain.shot.result.uid);
      if (existing.length > 0) return assertSnapshotSet(existing, expected, chain);

      for (const planned of expected) {
        repositories.shotContinuitySnapshots.create({
          snapshotUid: createUid(),
          dramaUid: chain.shot.result.dramaUid,
          shotResultUid: chain.shot.result.uid,
          shotResultHash: chain.shot.result.resultHash,
          shotEnvelopeHash: chain.shot.result.envelopeHash,
          shotApprovalRef: chain.shot.approval.reviewRef,
          shotId: planned.shotId,
          shotOrdinal: planned.shotOrdinal,
          scene: planned.scene,
          characters: planned.characters.map((character) => Object.freeze({
            factRef: character.factRef,
            characterUid: character.characterUid,
            referencePackageUid: character.referencePackageUid,
            costumeVersionUid: character.costumeVersionUid,
          })),
          props: planned.props,
          createdAtEpochMs,
        });
      }
      return assertSnapshotSet(
        repositories.shotContinuitySnapshots.list(chain.shot.result.uid),
        expected,
        chain,
      );
    });
  }

  return Object.freeze({ materialize });
}

module.exports = { createShotVersionBindingService };
