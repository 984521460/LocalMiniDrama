const { createHash } = require('node:crypto');

const { CHARACTER_REFERENCE_ITEM_KINDS } = require('../../src/assets/characterReferencePackage');
const { createCharacterCandidateBatch } = require('../../src/assets/characterCandidateBatch');
const { createNarrativeReviewService } = require('../../src/narrative/reviews');
const {
  createPromptSemanticVersioningService,
} = require('../../src/narrative/promptSemanticVersioning');
const {
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createScriptFormattingTask,
  createShotPlanningTask,
} = require('../../src/narrative/tasks');
const { createV2Repositories } = require('../../src/repositories/v2');
const { createMigratedV2Database, insertDrama, uid } = require('./v2RepositoryDatabase');
const {
  DURATION_BUDGET,
  STYLE,
  completionMetadata,
  createAdaptationOutput,
  createAssetVersions,
  createExtractionOutput,
  createPromptOutput,
  createScriptOutput,
  createShotOutput,
} = require('../fixtures/narrative/benchmarkFixture');

function shaText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shaNumber(value) {
  return value.toString(16).padStart(64, '0');
}

function addImageAsset(
  repositories,
  characterUid,
  assetIndex,
  logicalUri,
  relativePath,
  assetType,
  materializeAssetVersion,
) {
  const assetUid = uid(assetIndex);
  const assetVersionUid = uid(assetIndex + 1);
  const materialized = typeof materializeAssetVersion === 'function'
    ? materializeAssetVersion({ assetIndex, assetVersionUid, relativePath })
    : null;
  const storedRelativePath = materialized?.relativePath ?? relativePath;
  const contentSha256 = materialized?.sha256 ?? shaNumber(assetIndex);
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'character',
    ownerUid: characterUid,
    assetType,
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: assetVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri,
    relativePath: storedRelativePath,
    sha256: contentSha256,
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  return assetVersionUid;
}

function createReferencePackage(
  repositories,
  characterUid,
  offset = 18100,
  materializeAssetVersion,
) {
  const batchUid = uid(offset);
  const candidates = Array.from({ length: 4 }, (_, ordinal) => {
    const logicalUri = `asset://characters/${characterUid}/candidate-batches/${batchUid}/${ordinal}`;
    const assetVersionUid = addImageAsset(
      repositories,
      characterUid,
      offset + ordinal * 3 + 40,
      logicalUri,
      `characters/${characterUid}/candidates/${batchUid}/${ordinal}.png`,
      'character_candidate',
      materializeAssetVersion,
    );
    const storedVersion = repositories.assets.getVersion(assetVersionUid);
    return {
      uid: uid(offset + ordinal * 3 + 2),
      ordinal,
      assetVersionUid,
      logicalUri,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: storedVersion.sha256,
      presentation: 'single_portrait',
    };
  });
  repositories.characterCandidates.appendBatch(createCharacterCandidateBatch({
    schemaVersion: '5.0',
    batchUid,
    characterUid,
    promptSemanticUid: uid(offset + 20),
    profileUid: uid(offset + 21),
    manifestUid: uid(offset + 22),
    width: 1024,
    height: 1024,
    seed: 42,
    candidateCount: 4,
  }, { candidates }));
  const identity = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'identity',
    uid: uid(offset + 60),
    characterUid,
    parentUid: null,
    metadata: {
      name: 'Hero identity',
      visualSignature: 'oval face, straight dark hair, amber eyes',
      colorAnchors: ['#1f2937', '#d6a77a'],
    },
    createdAtEpochMs: 0,
  });
  const appearance = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'appearance',
    uid: uid(offset + 61),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: {
      name: 'Hero appearance',
      description: 'Oval face, dark hair, amber eyes.',
      colorAnchors: ['#1f2937', '#d6a77a'],
    },
    createdAtEpochMs: 0,
  });
  const costume = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'costume',
    uid: uid(offset + 62),
    characterUid,
    identityVersionUid: identity.uid,
    parentUid: null,
    metadata: {
      name: 'Rain costume',
      description: 'Charcoal coat over a cream shirt.',
      colorAnchors: ['#232323', '#f5f0df'],
    },
    createdAtEpochMs: 0,
  });
  const lock = repositories.characterCandidates.lock({
    eventUid: uid(offset + 63),
    characterUid,
    candidateUid: candidates[0].uid,
    identityVersionUid: identity.uid,
    expectedStateVersion: 0,
    changedAtEpochMs: 0,
  });
  const packageUid = uid(offset + 70);
  const items = CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
    uid: uid(offset + 100 + ordinal * 3 + 2),
    ordinal,
    kind,
    assetVersionUid: addImageAsset(
      repositories,
      characterUid,
      offset + 100 + ordinal * 3,
      `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      `characters/${characterUid}/reference-packages/${packageUid}/${kind}.png`,
      'character_reference',
      materializeAssetVersion,
    ),
  }));
  const packageRecord = repositories.characterReferencePackages.create({
    packageUid,
    characterUid,
    appearanceVersionUid: appearance.uid,
    costumeVersionUid: costume.uid,
    expectedLockStateVersion: lock.stateVersion,
    createdAtEpochMs: 0,
    items,
  });
  return { appearance, costume, identity, lock, packageRecord };
}

function createNarrativeSelection(repositories, dramaUid, offset) {
  const text = '赵云在雨夜进入客栈。\n\n掌柜说道：“楼上有人。”';
  const documentUid = uid(offset);
  const blockUid = uid(offset + 1);
  const selectionUid = uid(offset + 2);
  const block = {
    uid: blockUid,
    documentUid,
    ordinal: 0,
    text,
    textSha256: shaText(text),
  };
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: documentUid,
      dramaUid,
      sourceType: 'txt',
      originalName: 'continuity.txt',
      encoding: 'utf-8',
      contentSha256: shaText(text),
      fullText: text,
    },
    blocks: [{ ...block, headingPath: [], charStart: 0, charEnd: text.length }],
  });
  repositories.sources.createSelection({
    uid: selectionUid,
    documentUid,
    startBlockUid: blockUid,
    endBlockUid: blockUid,
    startOffset: 0,
    endOffset: text.length,
    selectedTextSha256: shaText(text),
  });
  return {
    selectionUid,
    source: {
      documentUid,
      blocks: [block],
      selection: {
        uid: selectionUid,
        documentUid,
        startBlockUid: blockUid,
        endBlockUid: blockUid,
        startOffset: 0,
        endOffset: Array.from(text).length,
        selectedTextSha256: shaText(text),
      },
    },
  };
}

function createApprovedShot(repositories, dramaUid, offset = 18400) {
  const { selectionUid, source } = createNarrativeSelection(repositories, dramaUid, offset);
  let nextUid = offset + 10;
  const reviews = createNarrativeReviewService({
    repositories,
    createUid: () => uid(nextUid++),
  });
  const approve = (resultType, result, upstreamResultUid) => {
    const stored = reviews.recordResult({
      dramaUid,
      sourceSelectionUid: selectionUid,
      resultType,
      ...(upstreamResultUid ? { upstreamResultUid } : {}),
      result,
    });
    return reviews.reviewResult({ resultUid: stored.uid, decision: 'approve' });
  };

  const extractionOutput = structuredClone(createExtractionOutput(source.blocks));
  const propStart = Array.from(source.blocks[0].text.slice(0, source.blocks[0].text.indexOf('客栈'))).length;
  extractionOutput.props = [{
    factId: 'prop-sword',
    name: 'Sword',
    description: 'A continuity prop represented by source evidence.',
    evidence: [{
      blockUid: source.blocks[0].uid,
      startOffset: propStart,
      endOffset: propStart + 2,
      quote: '客栈',
    }],
  }];
  const extractionResult = createNovelExtractionTask().complete({
    source,
    ...completionMetadata('novel-extraction', offset + 101, extractionOutput),
  });
  const extraction = approve('extraction', extractionResult);

  const adaptationOutput = createAdaptationOutput();
  const adaptationResult = createEpisodeAdaptationTask().complete({
    approvedExtraction: extractionResult.output,
    approval: extraction.approval,
    durationBudget: DURATION_BUDGET,
    style: STYLE,
    ...completionMetadata('episode-adaptation', offset + 102, adaptationOutput),
  });
  const adaptation = approve('adaptation', adaptationResult, extraction.result.uid);

  const scriptOutput = structuredClone(createScriptOutput());
  scriptOutput.scenes[0].propFactRefs = ['prop-sword'];
  scriptOutput.scenes[0].entries[0].propFactRefs = ['prop-sword'];
  const scriptResult = createScriptFormattingTask().complete({
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    ...completionMetadata('script-formatting', offset + 103, scriptOutput),
  });
  const script = approve('script', scriptResult, adaptation.result.uid);

  const propAssetRef = `asset-version:v1:${uid(offset + 500)}`;
  const assetVersions = [
    ...createAssetVersions(),
    { assetVersionRef: propAssetRef, assetType: 'prop', bindingRef: 'prop-sword' },
  ];
  const shotOutput = structuredClone(createShotOutput());
  for (const shot of shotOutput.shots.slice(0, 2)) {
    shot.propFactRefs = ['prop-sword'];
    shot.assetVersionRefs.push(propAssetRef);
  }
  const shotResult = createShotPlanningTask().complete({
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    scriptResult,
    scriptApproval: script.approval,
    assetVersions,
    ...completionMetadata('shot-planning', offset + 104, shotOutput),
  });
  const shot = approve('shot', shotResult, script.result.uid);
  return {
    resultUid: shot.result.uid,
    reviewUid: shot.review.uid,
    resultHash: shot.result.resultHash,
    envelopeHash: shot.result.envelopeHash,
    result: shotResult,
  };
}

function seedContinuityFixture(t, existingDatabase = null, options = {}) {
  const database = existingDatabase ?? createMigratedV2Database(t);
  const dramaUid = options.dramaUid ?? uid(18000);
  insertDrama(database, dramaUid, 'Continuity fixture drama');
  const factMatchedEntities = options.factMatchedEntities === true;
  database.prepare('INSERT INTO characters (id, drama_id, name) VALUES (1, 1, ?)')
    .run(factMatchedEntities ? '赵云' : 'Hero');
  if (factMatchedEntities) {
    database.prepare("INSERT INTO characters (id, drama_id, name) VALUES (2, 1, '掌柜')").run();
  }
  database.prepare(`
    INSERT INTO scenes (id, drama_id, location, time) VALUES (1, 1, ?, ?)
  `).run(factMatchedEntities ? '客栈' : 'Courtyard', factMatchedEntities ? '雨夜' : 'Dawn');
  database.prepare("INSERT INTO props (id, drama_id, name) VALUES (1, 1, 'Sword')").run();
  const characterUid = database.prepare('SELECT uid FROM characters WHERE id = 1').pluck().get();
  const innkeeperUid = factMatchedEntities
    ? database.prepare('SELECT uid FROM characters WHERE id = 2').pluck().get()
    : null;
  const sceneUid = database.prepare('SELECT uid FROM scenes WHERE id = 1').pluck().get();
  const propUid = database.prepare('SELECT uid FROM props WHERE id = 1').pluck().get();
  const repositories = createV2Repositories(database);
  const character = createReferencePackage(
    repositories,
    characterUid,
    18100,
    options.materializeAssetVersion,
  );
  const innkeeper = innkeeperUid ? createReferencePackage(
    repositories,
    innkeeperUid,
    28100,
    options.materializeAssetVersion,
  ) : null;
  const createScenePropVersions = options.createScenePropVersions !== false;
  const sceneVersion = createScenePropVersions ? repositories.scenePropVersions.create({
    schemaVersion: '5.0',
    kind: 'scene',
    uid: uid(18300),
    sceneUid,
    parentUid: null,
    state: 'ready',
    metadata: {
      name: factMatchedEntities ? '客栈' : 'Courtyard',
      visualDescription: factMatchedEntities ? '雨夜的客栈' : 'Stone courtyard after rain.',
      lighting: factMatchedEntities ? '雨夜' : 'Cool dawn light.',
      colorAnchors: ['#334455'],
    },
    createdAtEpochMs: 0,
  }) : null;
  const propVersion = createScenePropVersions ? repositories.scenePropVersions.create({
    schemaVersion: '5.0',
    kind: 'prop',
    uid: uid(18301),
    propUid,
    parentUid: null,
    state: 'ready',
    metadata: {
      name: 'Sword',
      visualDescription: 'Weathered steel sword.',
      colorAnchors: ['#778899'],
    },
    createdAtEpochMs: 0,
  }) : null;
  const shot = createApprovedShot(repositories, dramaUid);
  return {
    character,
    characterUid,
    factCharacters: Object.freeze({
      'character-zhao-yun': Object.freeze({ characterUid, reference: character }),
      ...(innkeeperUid ? {
        'character-innkeeper': Object.freeze({
          characterUid: innkeeperUid,
          reference: innkeeper,
        }),
      } : {}),
    }),
    database,
    dramaUid,
    propUid,
    propVersion,
    repositories,
    sceneUid,
    sceneVersion,
    shot,
  };
}

function snapshotInput(fixture, ordinal = 1, snapshotIndex = 18500) {
  const plannedShot = fixture.shot.result.output.shots[ordinal - 1];
  return {
    snapshotUid: uid(snapshotIndex),
    dramaUid: fixture.dramaUid,
    shotResultUid: fixture.shot.resultUid,
    shotResultHash: fixture.shot.resultHash,
    shotEnvelopeHash: fixture.shot.envelopeHash,
    shotApprovalRef: `review:v1:${fixture.shot.reviewUid}`,
    shotId: plannedShot.shotId,
    shotOrdinal: plannedShot.ordinal,
    scene: { sceneUid: fixture.sceneUid, versionUid: fixture.sceneVersion.uid },
    characters: [{
      factRef: plannedShot.characterFactRefs[0],
      characterUid: fixture.characterUid,
      referencePackageUid: fixture.character.packageRecord.packageUid,
      costumeVersionUid: fixture.character.costume.uid,
    }],
    props: [{
      factRef: plannedShot.propFactRefs[0],
      propUid: fixture.propUid,
      versionUid: fixture.propVersion.uid,
    }],
    createdAtEpochMs: ordinal,
  };
}

function createPromptSemanticFixture(fixture, start = 19010) {
  const resultUid = (resultType) => fixture.database.prepare(`
    SELECT uid FROM narrative_results WHERE drama_uid = ? AND result_type = ?
  `).pluck().get(fixture.dramaUid, resultType);
  const reviews = createNarrativeReviewService({ repositories: fixture.repositories });
  const detail = (resultType) => reviews.getResult(resultUid(resultType));
  const extraction = detail('extraction');
  const adaptation = detail('adaptation');
  const script = detail('script');
  const propAssetRef = `asset-version:v1:${uid(18900)}`;
  const output = structuredClone(createPromptOutput());
  for (const semanticShot of output.semanticShots.slice(0, 2)) {
    semanticShot.environment.propFactRefs = ['prop-sword'];
    semanticShot.environment.propAssetVersionRefs = [propAssetRef];
  }
  const promptInput = {
    approvedExtraction: extraction.result.result.output,
    extractionApproval: extraction.approval,
    adaptationResult: adaptation.result.result,
    adaptationApproval: adaptation.approval,
    scriptResult: script.result.result,
    scriptApproval: script.approval,
    assetVersions: [
      ...createAssetVersions(),
      { assetVersionRef: propAssetRef, assetType: 'prop', bindingRef: 'prop-sword' },
    ],
    shotPlanningResult: fixture.shot.result,
    shotPlanningApproval: {
      status: 'approved',
      resultHash: fixture.shot.resultHash,
      envelopeHash: fixture.shot.envelopeHash,
      reviewRef: `review:v1:${fixture.shot.reviewUid}`,
    },
    ...completionMetadata('prompt-semantic', start - 1, output),
  };
  const snapshots = fixture.shot.result.output.shots.map((shot, index) => (
    fixture.repositories.shotContinuitySnapshots.create({
      ...snapshotInput(fixture, shot.ordinal, start + index),
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
    })
  ));
  const semantic = createPromptSemanticVersioningService({
    repositories: fixture.repositories,
  }).complete({
    promptInput,
    continuitySnapshotUids: snapshots.map((snapshot) => snapshot.snapshotUid),
  });
  return Object.freeze({ promptInput, semantic, snapshots });
}

module.exports = { createPromptSemanticFixture, seedContinuityFixture, snapshotInput };
