const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createNarrativeReviewService } = require('../src/narrative/reviews');
const { sha256Canonical } = require('../src/narrative/tasks/jsonSnapshot');
const {
  createPromptSemanticVersioningService,
} = require('../src/narrative/promptSemanticVersioning');
const narrativeTasks = require('../src/narrative/tasks');
const { NarrativeTaskError } = narrativeTasks;
const {
  completionMetadata,
  createAssetVersions,
  createPromptOutput,
} = require('./fixtures/narrative/benchmarkFixture');
const {
  seedContinuityFixture,
} = require('./helpers/v5ContinuityFixtures');
const { uid } = require('./helpers/v2RepositoryDatabase');

const schema = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../schemas/v5/prompt-semantic-versioned.schema.json'),
  'utf8',
));

function approvedDetail(fixture, resultType) {
  const resultUid = fixture.database.prepare(`
    SELECT uid FROM narrative_results WHERE drama_uid = ? AND result_type = ?
  `).pluck().get(fixture.dramaUid, resultType);
  return createNarrativeReviewService({ repositories: fixture.repositories }).getResult(resultUid);
}

function promptInput(fixture) {
  const extraction = approvedDetail(fixture, 'extraction');
  const adaptation = approvedDetail(fixture, 'adaptation');
  const script = approvedDetail(fixture, 'script');
  const propAssetRef = `asset-version:v1:${uid(18900)}`;
  const assetVersions = [
    ...createAssetVersions(),
    { assetVersionRef: propAssetRef, assetType: 'prop', bindingRef: 'prop-sword' },
  ];
  const output = structuredClone(createPromptOutput());
  for (const semanticShot of output.semanticShots.slice(0, 2)) {
    semanticShot.environment.propFactRefs = ['prop-sword'];
    semanticShot.environment.propAssetVersionRefs = [propAssetRef];
  }
  return {
    approvedExtraction: extraction.result.result.output,
    extractionApproval: extraction.approval,
    adaptationResult: adaptation.result.result,
    adaptationApproval: adaptation.approval,
    scriptResult: script.result.result,
    scriptApproval: script.approval,
    assetVersions,
    shotPlanningResult: fixture.shot.result,
    shotPlanningApproval: {
      status: 'approved',
      resultHash: fixture.shot.resultHash,
      envelopeHash: fixture.shot.envelopeHash,
      reviewRef: `review:v1:${fixture.shot.reviewUid}`,
    },
    ...completionMetadata('prompt-semantic', 19000, output),
  };
}

function createSnapshots(fixture, start = 19010) {
  return fixture.shot.result.output.shots.map((shot, index) => (
    fixture.repositories.shotContinuitySnapshots.create({
      snapshotUid: uid(start + index),
      dramaUid: fixture.dramaUid,
      shotResultUid: fixture.shot.resultUid,
      shotResultHash: fixture.shot.resultHash,
      shotEnvelopeHash: fixture.shot.envelopeHash,
      shotApprovalRef: `review:v1:${fixture.shot.reviewUid}`,
      shotId: shot.shotId,
      shotOrdinal: shot.ordinal,
      scene: { sceneUid: fixture.sceneUid, versionUid: fixture.sceneVersion.uid },
      characters: shot.characterFactRefs.map((factRef) => ({
        factRef,
        characterUid: fixture.characterUid,
        referencePackageUid: fixture.character.packageRecord.packageUid,
        costumeVersionUid: fixture.character.costume.uid,
      })),
      props: shot.propFactRefs.map((factRef) => ({
        factRef,
        propUid: fixture.propUid,
        versionUid: fixture.propVersion.uid,
      })),
      createdAtEpochMs: shot.ordinal,
    })
  ));
}

test('versioned Prompt Semantic is exposed only through the persistence-validated service', () => {
  assert.equal(
    Object.hasOwn(narrativeTasks, 'createVersionedPromptSemanticTask'),
    false,
  );
});

test('versioned Prompt Semantic rejects Proxy containers without executing traps', (t) => {
  const fixture = seedContinuityFixture(t);
  const snapshots = createSnapshots(fixture, 19020);
  const service = createPromptSemanticVersioningService({ repositories: fixture.repositories });
  const values = {
    promptInput: promptInput(fixture),
    continuitySnapshotUids: snapshots.map((snapshot) => snapshot.snapshotUid),
  };
  let rootTrapReads = 0;
  const root = new Proxy(values, {
    ownKeys() {
      rootTrapReads += 1;
      throw new Error('synthetic-root-proxy-trap');
    },
  });
  assert.throws(
    () => service.complete(root),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_INPUT_INVALID',
  );
  assert.equal(rootTrapReads, 0);

  let arrayTrapReads = 0;
  const continuitySnapshotUids = new Proxy(values.continuitySnapshotUids, {
    ownKeys() {
      arrayTrapReads += 1;
      throw new Error('synthetic-array-proxy-trap');
    },
  });
  assert.throws(
    () => service.complete({ ...values, continuitySnapshotUids }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_INPUT_INVALID',
  );
  assert.equal(arrayTrapReads, 0);
});

test('versioned Prompt Semantic binds every semantic shot to concrete continuity versions', (t) => {
  const fixture = seedContinuityFixture(t);
  const snapshots = createSnapshots(fixture);
  const service = createPromptSemanticVersioningService({ repositories: fixture.repositories });
  const result = service.complete({
    promptInput: promptInput(fixture),
    continuitySnapshotUids: snapshots.map((snapshot) => snapshot.snapshotUid),
  });

  assert.equal(result.taskType, 'PromptSemanticVersioningTask');
  assert.equal(result.shotResultUid, fixture.shot.resultUid);
  assert.equal(result.output.semanticShots.length, 5);
  assert.equal(result.output.semanticShots[0].continuitySnapshotUid, snapshots[0].snapshotUid);
  assert.equal(
    result.output.semanticShots[0].subjects.characters[0].identityVersionUid,
    fixture.character.identity.uid,
  );
  assert.equal(
    result.output.semanticShots[0].environment.scene.versionUid,
    fixture.sceneVersion.uid,
  );
  assert.equal(
    result.output.semanticShots[0].environment.props[0].versionUid,
    fixture.propVersion.uid,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.output.semanticShots), true);
  assert.equal(new Ajv2020({ allErrors: true, strict: true }).compile(schema)(result), true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /asset-version:v1:|benchmark-model|rawResponse|provider/i,
  );
});

test('versioned Prompt Semantic rejects stale approval, version drift, and hostile references', (t) => {
  const fixture = seedContinuityFixture(t);
  const snapshots = createSnapshots(fixture, 19030);
  const service = createPromptSemanticVersioningService({ repositories: fixture.repositories });
  const input = promptInput(fixture);

  const alteredShotResult = structuredClone(input.shotPlanningResult);
  alteredShotResult.model.name = 'different-envelope-model';
  assert.throws(
    () => service.complete({
      promptInput: {
        ...input,
        shotPlanningResult: alteredShotResult,
        shotPlanningApproval: {
          ...input.shotPlanningApproval,
          envelopeHash: sha256Canonical(alteredShotResult),
        },
      },
      continuitySnapshotUids: snapshots.map((snapshot) => snapshot.snapshotUid),
    }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_REFERENCE_INVALID',
  );
  assert.throws(
    () => service.complete({
      promptInput: input,
      continuitySnapshotUids: [
        snapshots[1].snapshotUid,
        snapshots[0].snapshotUid,
        ...snapshots.slice(2).map((snapshot) => snapshot.snapshotUid),
      ],
    }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_REFERENCE_INVALID',
  );

  const extraction = fixture.database.prepare(`
    SELECT uid, result_hash, envelope_hash FROM narrative_results
    WHERE drama_uid = ? AND result_type = 'extraction'
  `).get(fixture.dramaUid);
  const newReviewUid = uid(19040);
  fixture.database.prepare(`
    INSERT INTO narrative_review_events
      (uid, result_uid, decision, result_hash, envelope_hash, comment)
    VALUES (?, ?, 'approve', ?, ?, NULL)
  `).run(newReviewUid, extraction.uid, extraction.result_hash, extraction.envelope_hash);
  fixture.database.prepare(`
    UPDATE narrative_results SET status = 'approved', current_review_uid = ? WHERE uid = ?
  `).run(newReviewUid, extraction.uid);
  assert.throws(
    () => service.complete({
      promptInput: input,
      continuitySnapshotUids: snapshots.map((snapshot) => snapshot.snapshotUid),
    }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_REFERENCE_INVALID',
  );

  const drifted = seedContinuityFixture(t);
  const driftedSnapshots = createSnapshots(drifted, 19050);
  drifted.database.exec('DROP TRIGGER v2_scene_versions_immutable_update');
  drifted.database.prepare(`
    UPDATE scene_versions SET metadata_json = ? WHERE uid = ?
  `).run(JSON.stringify({
    name: 'Changed',
    visualDescription: 'Changed persisted scene evidence.',
    lighting: 'Changed light.',
    colorAnchors: ['#112233'],
  }), drifted.sceneVersion.uid);
  const driftedService = createPromptSemanticVersioningService({
    repositories: drifted.repositories,
  });
  assert.throws(
    () => driftedService.complete({
      promptInput: promptInput(drifted),
      continuitySnapshotUids: driftedSnapshots.map((snapshot) => snapshot.snapshotUid),
    }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_REFERENCE_INVALID',
  );

  let reads = 0;
  assert.throws(
    () => driftedService.complete({
      get promptInput() {
        reads += 1;
        return promptInput(drifted);
      },
      continuitySnapshotUids: driftedSnapshots.map((snapshot) => snapshot.snapshotUid),
    }),
    (error) => error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_INPUT_INVALID',
  );
  assert.equal(reads, 0);
});
