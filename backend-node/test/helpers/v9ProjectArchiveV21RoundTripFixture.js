'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createNarrativeStalenessService } = require('../../src/narrative/staleness');
const { normalizeWorkflowNodeConfig } = require('../../src/workflows/nodeConfig');
const { createWorkflowExecutionPlan } = require('../../src/workflows/executionPlan');
const {
  createPromptSemanticFixture,
  seedContinuityFixture,
} = require('./v5ContinuityFixtures');
const { createLocalMediaExportFixture } = require('./v8LocalMediaFixture');
const { uid: v8Uid } = require('./v8AudioFixture');
const { uid } = require('./v2RepositoryDatabase');

const CREDENTIAL_REF = `credential:v1:${uid(19990)}`;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeMedia(root, relativePath, label) {
  const bytes = Buffer.from(`project-archive-v2.1:${label}`, 'utf8');
  const absolutePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return Object.freeze({
    byteLength: bytes.length,
    relativePath,
    sha256: sha256(bytes),
  });
}

function addLegacyRecords(database, fixture) {
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid=?').pluck().get(fixture.dramaUid);
  const characterId = database.prepare('SELECT id FROM characters WHERE uid=?').pluck().get(fixture.characterUid);
  const sceneId = database.prepare('SELECT id FROM scenes WHERE uid=?').pluck().get(fixture.sceneUid);
  const propId = database.prepare('SELECT id FROM props WHERE uid=?').pluck().get(fixture.propUid);
  const episodeId = Number(database.prepare(`
    INSERT INTO episodes (
      uid,drama_id,episode_number,title,description,duration,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    uid(19500), dramaId, 1, 'Archive episode', 'Complete 2.1 round-trip fixture',
    4, 'draft', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
  ).lastInsertRowid);
  const storyboardId = Number(database.prepare(`
    INSERT INTO storyboards (
      uid,episode_id,scene_id,storyboard_number,title,duration,continuity_snapshot,
      creation_mode,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid(19501), episodeId, sceneId, 1, 'Archive shot', 4, '{}', 'classic', 'draft',
    '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z',
  ).lastInsertRowid);

  const characterLibraryId = Number(database.prepare(`
    INSERT INTO character_libraries (
      drama_id,name,local_path,image_url,identity_anchors,style_tokens,color_palette,
      source_type,source_id,created_at,updated_at
    ) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'Archive hero', 'projects/archive/character.png', '/static/projects/archive/character.png',
    '{}', '[]', '[]', 'character', String(characterId),
    '2026-08-31T00:00:02.000Z', '2026-08-31T00:00:02.000Z',
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO scene_libraries (
      drama_id,location,local_path,image_url,source_type,source_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    dramaId, 'Courtyard', 'projects/archive/scene.png', '/static/projects/archive/scene.png',
    'scene', String(sceneId), '2026-08-31T00:00:03.000Z', '2026-08-31T00:00:03.000Z',
  );
  database.prepare(`
    INSERT INTO prop_libraries (
      drama_id,name,local_path,image_url,source_type,source_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    dramaId, 'Sword', 'projects/archive/prop.png', '/static/projects/archive/prop.png',
    'prop', String(propId), '2026-08-31T00:00:04.000Z', '2026-08-31T00:00:04.000Z',
  );
  database.prepare('INSERT INTO episode_characters (episode_id,character_id) VALUES (?,?)')
    .run(episodeId, characterId);
  database.prepare(`
    INSERT INTO storyboard_characters (storyboard_id,character_id,created_at)
    VALUES (?,?,?)
  `).run(storyboardId, characterLibraryId, '2026-08-31T00:00:05.000Z');
  database.prepare('INSERT INTO storyboard_props (storyboard_id,prop_id) VALUES (?,?)')
    .run(storyboardId, propId);
  database.prepare(`
    INSERT INTO frame_prompts (
      storyboard_id,frame_type,prompt,description,layout,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    storyboardId, 'first', 'Archive opening frame', 'Opening frame', 'center',
    '2026-08-31T00:00:06.000Z', '2026-08-31T00:00:06.000Z',
  );

  const imageGenerationId = Number(database.prepare(`
    INSERT INTO image_generations (
      storyboard_id,drama_id,episode_id,scene_id,character_id,provider,prompt,model,
      reference_images,image_url,local_path,width,height,status,task_id,completed_at,
      error_msg,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    storyboardId, dramaId, episodeId, sceneId, characterId, 'local', 'Archive image',
    'fixture', '[]', '/static/projects/archive/frame.png', 'projects/archive/frame.png',
    1024, 576, 'completed', null, '2026-08-31T00:00:08.000Z', null,
    '2026-08-31T00:00:07.000Z', '2026-08-31T00:00:08.000Z',
  ).lastInsertRowid);
  const videoGenerationId = Number(database.prepare(`
    INSERT INTO video_generations (
      drama_id,storyboard_id,scene_id,provider,prompt,model,duration,aspect_ratio,
      resolution,seed,camera_fixed,watermark,reference_image_urls,video_url,local_path,
      status,task_id,provider_task_id,completed_at,error_msg,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    dramaId, storyboardId, sceneId, 'local', 'Archive video', 'fixture', 4, '16:9',
    '1024x576', 42, 0, 0, '[]', '/static/projects/archive/shot.mp4',
    'projects/archive/shot.mp4', 'completed', null, null,
    '2026-08-31T00:00:10.000Z', null,
    '2026-08-31T00:00:09.000Z', '2026-08-31T00:00:10.000Z',
  ).lastInsertRowid);
  database.prepare(`
    INSERT INTO video_merges (
      episode_id,drama_id,title,provider,model,status,scenes,merge_options,task_id,
      merged_url,duration,completed_at,error_msg,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    episodeId, dramaId, 'Archive episode final', 'local', 'ffmpeg', 'completed',
    '[]', '{}', null, '/static/projects/archive/episode.mp4', 4000,
    '2026-08-31T00:00:12.000Z', null, '2026-08-31T00:00:11.000Z',
  );
  database.prepare(`
    INSERT INTO legacy_assets (
      drama_id,name,type,url,local_path,file_size,mime_type,width,height,duration,
      image_gen_id,video_gen_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    dramaId, 'Archive output', 'video', '/static/projects/archive/shot.mp4',
    'projects/archive/shot.mp4', 1000, 'video/mp4', 1024, 576, 4,
    imageGenerationId, videoGenerationId,
    '2026-08-31T00:00:13.000Z', '2026-08-31T00:00:13.000Z',
  );
  database.prepare(`
    UPDATE storyboards SET first_frame_image_id=?,last_frame_image_id=? WHERE id=?
  `).run(imageGenerationId, imageGenerationId, storyboardId);
}

function addVoiceAndBgm(fixture, storageRoot) {
  const { repositories } = fixture;
  const voiceVersion = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(19600),
    characterUid: fixture.characterUid,
    identityVersionUid: fixture.character.identity.uid,
    parentUid: null,
    metadata: { name: 'Archive voice', language: 'zh-CN', style: 'calm' },
    createdAtEpochMs: 10,
  });
  const voiceProfile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(19601),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    characterVoiceVersionUid: voiceVersion.uid,
    parentUid: null,
    revision: 1,
    provider: 'openai-compatible',
    model: 'gpt-4o-mini-tts',
    voiceKey: 'alloy',
    credentialRef: CREDENTIAL_REF,
    sourceKind: 'provider-preset',
    status: 'ready',
    defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 500,
    defaultSpeedPermille: 1000,
    maximumSpeedPermille: 2000,
    createdAtEpochMs: 11,
  });
  repositories.voiceProfiles.activate({
    schemaVersion: '8.0',
    uid: uid(19602),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    voiceProfileUid: voiceProfile.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 12,
  });

  const bgmAssetUid = uid(19610);
  const bgmVersionUid = uid(19611);
  const relativePath = `projects/${fixture.dramaUid}/assets/bgm/${bgmAssetUid}/${bgmVersionUid}.mp3`;
  const media = writeMedia(storageRoot, relativePath, 'bgm');
  repositories.assets.create({
    uid: bgmAssetUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    assetType: 'bgm',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: bgmVersionUid,
    assetUid: bgmAssetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/bgm/${bgmAssetUid}/${bgmVersionUid}`,
    relativePath,
    sha256: media.sha256,
    mimeType: 'audio/mpeg',
    width: null,
    height: null,
    durationMs: 60_000,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  repositories.bgmTracks.create({
    schemaVersion: 'bgm-track.v1',
    uid: uid(19612),
    dramaUid: fixture.dramaUid,
    title: 'Archive theme',
    sourceKind: 'local-import',
    providerId: 'local-library',
    assetVersionUid: bgmVersionUid,
    license: {
      schemaVersion: 'bgm-license.v1',
      uid: uid(19613),
      basis: 'licensed',
      attestationKind: 'user-attestation',
      commercialUseAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: null,
      attestedAtEpochMs: 13,
    },
    createdAtEpochMs: 14,
  });
  return Object.freeze({ voiceProfile, voiceVersion });
}

function addGenerationHistory(fixture, promptFixture, storageRoot) {
  const { repositories } = fixture;
  const promptSemanticUid = uid(18120);
  const manifestUid = uid(18122);
  const manifestSha256 = 'a'.repeat(64);
  const assetUid = uid(19700);
  const parentVersionUid = uid(19701);
  const outputVersionUid = uid(19702);
  const runUid = uid(19703);
  const historyUid = uid(19704);
  const parentPath = `projects/${fixture.dramaUid}/generation-history/parent.png`;
  const outputPath = `projects/${fixture.dramaUid}/generation-history/output.png`;
  const parentMedia = writeMedia(storageRoot, parentPath, 'generation-parent');
  const outputMedia = writeMedia(storageRoot, outputPath, 'generation-output');
  const parameters = { steps: 20, width: 1280, height: 720 };
  const input = {
    promptSemanticUid,
    manifestUid,
    continuitySnapshotUids: promptFixture.snapshots.map((snapshot) => snapshot.snapshotUid),
  };

  repositories.workflows.createManifest({
    uid: manifestUid,
    manifestId: 'project-archive-v21-generation',
    version: '1.0.0',
    engine: 'local',
    workflowFile: 'workflows/project-archive-v21-generation.json',
    workflowSha256: manifestSha256,
    modelFamily: 'synthetic',
    requirements: [],
    inputs: { promptSemanticUid: 'uuid' },
    outputs: { image: 'asset-version' },
    validation: { valid: true },
    status: 'validated',
  });
  repositories.assets.create({
    uid: assetUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    assetType: 'image',
    status: 'draft',
  });
  repositories.assets.addVersion({
    uid: parentVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generation-history/parent.png`,
    relativePath: parentPath,
    sha256: parentMedia.sha256,
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: null,
    status: 'ready',
  }, { makeCurrent: true });
  repositories.assets.addVersion({
    uid: outputVersionUid,
    assetUid,
    storageProvider: 'local',
    logicalUri: `asset://dramas/${fixture.dramaUid}/generation-history/output.png`,
    relativePath: outputPath,
    sha256: outputMedia.sha256,
    mimeType: 'image/png',
    width: 1280,
    height: 720,
    durationMs: null,
    parentUid: parentVersionUid,
    status: 'ready',
  });
  repositories.runs.createGeneration({
    uid: runUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    provider: 'local',
    model: 'synthetic-image-v1',
    seed: 42,
    parameters,
    input,
    promptVersionUid: promptSemanticUid,
    status: 'queued',
  });
  repositories.runs.transitionGenerationStatus({
    uid: runUid,
    expectedStatus: 'queued',
    nextStatus: 'running',
  });
  const terminal = repositories.runs.transitionGenerationStatus({
    uid: runUid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    outputAssetVersionUid: outputVersionUid,
  });
  const createdAtEpochMs = Date.parse(terminal.createdAt);
  const completedAtEpochMs = Date.parse(terminal.completedAt);
  repositories.generationHistory.append({
    uid: promptSemanticUid,
    semantic: promptFixture.semantic,
    createdAtEpochMs,
  }, {
    uid: historyUid,
    runUid,
    dramaUid: fixture.dramaUid,
    assetUid,
    promptSemanticUid,
    manifestUid,
    manifestSha256,
    provider: 'local',
    model: 'synthetic-image-v1',
    seed: 42,
    parameters,
    input,
    status: 'succeeded',
    outputVersionUid,
    outputVersionEvidence: repositories.assets.getVersion(outputVersionUid),
    parentVersionUid,
    parentVersionEvidence: repositories.assets.getVersion(parentVersionUid),
    errorCode: null,
    errorDetailRef: null,
    createdAtEpochMs,
    completedAtEpochMs,
  });
  repositories.generationHistory.select({
    uid: uid(19705),
    historyUid,
    assetUid,
    selectedVersionUid: outputVersionUid,
    previousVersionUid: parentVersionUid,
    stateVersion: 1,
    changedAtEpochMs: completedAtEpochMs + 1,
  });
}

function addPortableWorkflow(fixture, voiceProfile) {
  const { repositories } = fixture;
  const workflowUid = uid(29000);
  const nodeUid = uid(29001);
  const runUid = uid(29002);
  const nodeRunUid = uid(29003);
  const sourceNodeUid = uid(29005);
  const sourceNodeRunUid = uid(29006);
  const factsNodeUid = uid(29007);
  const factsNodeRunUid = uid(29008);
  const config = normalizeWorkflowNodeConfig('audio.tts', {
    profileUid: voiceProfile.uid,
    speed: 1,
  });
  repositories.workflows.createGraph({
    definition: {
      uid: workflowUid,
      dramaUid: fixture.dramaUid,
      name: 'Archive portable workflow',
      version: 1,
      status: 'active',
      description: 'Exercises every nested credential carrier.',
    },
    nodes: [
      {
        uid: sourceNodeUid,
        nodeType: 'source.selection',
        position: { x: 0, y: 0 },
        config: normalizeWorkflowNodeConfig('source.selection', {
          contextAfterBlocks: 0,
          contextBeforeBlocks: 0,
        }),
        domainRefType: null,
        domainRefUid: null,
        status: 'disabled',
      },
      {
        uid: nodeUid,
        nodeType: 'audio.tts',
        position: { x: 200, y: 0 },
        config,
        domainRefType: null,
        domainRefUid: null,
        status: 'disabled',
      },
      {
        uid: factsNodeUid,
        nodeType: 'story.facts',
        position: { x: 100, y: 100 },
        config: normalizeWorkflowNodeConfig('story.facts', {
          profileUid: uid(29009),
          temperature: 0,
        }),
        domainRefType: null,
        domainRefUid: null,
        status: 'disabled',
      },
    ],
    edges: [{
      uid: uid(29010),
      sourceNodeUid,
      sourcePort: 'selection',
      targetNodeUid: factsNodeUid,
      targetPort: 'selection',
    }],
  });
  const plan = createWorkflowExecutionPlan(repositories.workflows.getGraph(workflowUid), repositories);
  repositories.runs.createWorkflowWithNodes({
    run: {
      uid: runUid,
      workflowUid,
      graphSnapshot: plan,
      graphHash: plan.graphHash,
      graphRevision: plan.graphRevision,
      triggerType: 'manual',
      status: 'queued',
    },
    nodes: [
      {
        uid: nodeRunUid,
        nodeUid,
        ordinal: 0,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
      {
        uid: sourceNodeRunUid,
        nodeUid: sourceNodeUid,
        ordinal: 1,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
      {
        uid: factsNodeRunUid,
        nodeUid: factsNodeUid,
        ordinal: 2,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
    ],
  });
  repositories.runs.createExport({
    uid: uid(29004),
    dramaUid: fixture.dramaUid,
    workflowRunUid: runUid,
    timelineSnapshot: { shots: [] },
    encoding: { codec: 'h264' },
    audio: {},
    subtitle: {},
    outputAssetVersionUid: null,
    validation: {},
    status: 'queued',
  });
}

function addMediaExportSeal(fixture, executionPlan) {
  const { repositories } = fixture;
  const workflowUid = uid(29100);
  const sourceAssetUid = uid(29101);
  const sourceNodeUid = uid(29102);
  const exportNodeUid = uid(29103);
  const sourceNodeRunUid = uid(29104);
  const exportNodeRunUid = uid(29105);
  repositories.assets.create({
    uid: sourceAssetUid,
    ownerType: 'drama',
    ownerUid: fixture.dramaUid,
    assetType: 'video',
    status: 'draft',
  });
  repositories.workflows.createGraph({
    definition: {
      uid: workflowUid,
      dramaUid: fixture.dramaUid,
      name: 'Archive media export workflow',
      version: 1,
      status: 'active',
      description: 'Exercises the terminal media export seal.',
    },
    nodes: [
      {
        uid: sourceNodeUid,
        nodeType: 'shot.video',
        position: { x: 0, y: 0 },
        config: normalizeWorkflowNodeConfig('shot.video', {
          durationMs: 1500, fps: 24, height: 1080, width: 1920,
        }),
        domainRefType: 'asset',
        domainRefUid: sourceAssetUid,
        status: 'ready',
      },
      {
        uid: exportNodeUid,
        nodeType: 'export.final',
        position: { x: 300, y: 0 },
        config: normalizeWorkflowNodeConfig('export.final', {
          format: 'mp4', fps: 24, height: 1080, width: 1920,
        }),
        domainRefType: null,
        domainRefUid: null,
        status: 'ready',
      },
    ],
    edges: [{
      uid: uid(29106),
      sourceNodeUid,
      sourcePort: 'video',
      targetNodeUid: exportNodeUid,
      targetPort: 'videos',
    }],
  });
  const plan = createWorkflowExecutionPlan(
    repositories.workflows.getGraph(workflowUid), repositories,
  );
  repositories.runs.createWorkflowWithNodes({
    run: {
      uid: executionPlan.workflowRunUid,
      workflowUid,
      graphSnapshot: plan,
      graphHash: plan.graphHash,
      graphRevision: plan.graphRevision,
      triggerType: 'manual',
      status: 'queued',
    },
    nodes: [
      {
        uid: sourceNodeRunUid,
        nodeUid: sourceNodeUid,
        ordinal: 0,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
      {
        uid: exportNodeRunUid,
        nodeUid: exportNodeUid,
        ordinal: 1,
        inputSnapshot: {},
        output: null,
        cacheKey: null,
        status: 'queued',
      },
    ],
  });
  repositories.runs.transitionWorkflowStatus({
    uid: executionPlan.workflowRunUid, expectedStatus: 'queued', nextStatus: 'running',
  });
  repositories.runs.transitionNodeStatus({
    uid: sourceNodeRunUid, expectedStatus: 'queued', nextStatus: 'running', inputSnapshot: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: sourceNodeRunUid, expectedStatus: 'running', nextStatus: 'succeeded', output: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: exportNodeRunUid, expectedStatus: 'queued', nextStatus: 'running', inputSnapshot: {},
  });
  repositories.runs.transitionNodeStatus({
    uid: exportNodeRunUid,
    expectedStatus: 'running',
    nextStatus: 'succeeded',
    output: { schemaVersion: 'media-export-node-output.v1', executionPlan },
  });
  repositories.runs.transitionWorkflowStatus({
    uid: executionPlan.workflowRunUid, expectedStatus: 'running', nextStatus: 'succeeded',
  });
  const seal = repositories.mediaExportRuns.prepareFromNode(
    exportNodeRunUid, executionPlan.createdAtEpochMs, fixture.dramaUid,
  );
  repositories.mediaExportRuns.start(seal.uid);
  repositories.mediaExportRuns.fail(
    seal.uid, 'MEDIA_EXPORT_FAILED', executionPlan.createdAtEpochMs + 1,
  );
}

async function seedProjectArchiveV21RoundTripFixture(t, database, storageRoot) {
  const localExport = await createLocalMediaExportFixture(t, 29150);
  const fixture = seedContinuityFixture(t, database, {
    dramaUid: v8Uid(1),
    materializeAssetVersion({ assetVersionUid, relativePath }) {
      return writeMedia(storageRoot, relativePath, assetVersionUid);
    },
  });
  addLegacyRecords(database, fixture);
  const promptFixture = createPromptSemanticFixture(fixture, 19010);
  const { voiceProfile } = addVoiceAndBgm(fixture, storageRoot);
  addGenerationHistory(fixture, promptFixture, storageRoot);
  addPortableWorkflow(fixture, voiceProfile);
  addMediaExportSeal(fixture, localExport.fixture.executionPlan);
  const selectionUid = database.prepare(`
    SELECT uid FROM source_selections
    WHERE document_uid IN (SELECT uid FROM source_documents WHERE drama_uid=?)
    ORDER BY uid LIMIT 1
  `).pluck().get(fixture.dramaUid);
  createNarrativeStalenessService({ repositories: fixture.repositories, now: () => 20 })
    .invalidate({ rootKind: 'source_selection', rootUid: selectionUid });
  return Object.freeze({
    ...fixture,
    credentialRef: CREDENTIAL_REF,
    promptFixture,
  });
}

module.exports = Object.freeze({ seedProjectArchiveV21RoundTripFixture });
