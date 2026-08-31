'use strict';

const assert = require('node:assert/strict');

const { createNarrativeReviewService } = require('../../src/narrative/reviews');
const { createV2Repositories } = require('../../src/repositories/v2');
const { createWorkflowRunService, createWorkflowService } = require('../../src/workflows');
const { createPromptSemanticFixture, seedContinuityFixture } = require('./v5ContinuityFixtures');
const { uid } = require('./v2RepositoryDatabase');

const CREDENTIAL_REF = `credential:v1:${uid(97001)}`;

function uidSequence(values) {
  const queue = [...values];
  return () => queue.shift();
}

function createAudioModeIntentFixture(t, options = {}) {
  const provider = options.provider ?? 'openai-compatible';
  const model = options.model ?? (provider === 'minimax' ? 'speech-02-hd' : 'gpt-4o-mini-tts');
  const voiceKey = options.voiceKey ?? (provider === 'minimax' ? 'female-shaonv' : 'alloy');
  const fixture = seedContinuityFixture(t);
  const prompt = createPromptSemanticFixture(fixture, 97100);
  const repositories = createV2Repositories(fixture.database);
  const voice = repositories.characterVersions.create({
    schemaVersion: '5.0',
    kind: 'voice',
    uid: uid(97200),
    characterUid: fixture.characterUid,
    identityVersionUid: fixture.character.identity.uid,
    parentUid: null,
    metadata: {
      name: 'Prepared intent voice',
      language: 'zh-CN',
      style: 'stable synthetic delivery',
    },
    createdAtEpochMs: 10,
  });
  const profile = repositories.voiceProfiles.create({
    schemaVersion: '8.0',
    uid: uid(97201),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    characterVoiceVersionUid: voice.uid,
    parentUid: null,
    revision: 1,
    provider,
    model,
    voiceKey,
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
    uid: uid(97202),
    dramaUid: fixture.dramaUid,
    characterUid: fixture.characterUid,
    voiceProfileUid: profile.uid,
    previousVoiceProfileUid: null,
    stateVersion: 1,
    changedAtEpochMs: 12,
  });

  const workflowService = createWorkflowService({
    repositories,
    createUid: () => uid(97300),
  });
  const workflow = workflowService.createWorkflow({ dramaId: 1, name: 'Prepared TTS intent' });
  const canvasNodeUid = uid(97301);
  workflowService.replaceGraph(workflow.definition.uid, {
    expectedRevision: 0,
    nodes: [{
      uid: canvasNodeUid,
      nodeType: 'audio.tts',
      position: { x: 0, y: 0 },
      config: { credentialRef: CREDENTIAL_REF, profileUid: profile.uid, speed: 1 },
      domainRef: { type: 'narrative_result', uid: fixture.shot.resultUid },
      status: 'ready',
    }],
    edges: [],
  });
  const run = createWorkflowRunService({
    repositories,
    createUid: uidSequence([uid(97310), uid(97311)]),
  }).createRun({ workflowUid: workflow.definition.uid, triggerType: 'manual' });

  const reviews = createNarrativeReviewService({ repositories });
  const shotDetail = reviews.getResult(fixture.shot.resultUid);
  const scriptResultUid = shotDetail.result.upstreamResultUid;
  const script = reviews.requireApproved(scriptResultUid, 'script').result;
  const shot = fixture.shot.result.output.shots.find((candidate) => (
    candidate.dialogueEntryRefs.length > 0
  ));
  const dialogueEntryId = shot.dialogueEntryRefs[0];
  const snapshot = prompt.snapshots.find((candidate) => candidate.shotId === shot.shotId);
  const audioNodeRun = run.nodes.find((candidate) => candidate.nodeUid === canvasNodeUid);
  assert.ok(audioNodeRun);
  const request = {
    schemaVersion: 'audio-mode-intent-request.v1',
    uid: uid(97400),
    dramaUid: fixture.dramaUid,
    workflowRunUid: run.run.uid,
    nodeRunUid: audioNodeRun.uid,
    shotResultUid: fixture.shot.resultUid,
    scriptResultUid,
    deliveries: [{
      uid: uid(97401),
      continuitySnapshotUid: snapshot.snapshotUid,
      shotId: shot.shotId,
      dialogueEntryId,
      voiceProfileUid: profile.uid,
      emotion: 'fearful',
      emotionIntensityPermille: 700,
      speedPermille: 1000,
      pauseBeforeMs: 0,
      pauseAfterMs: 120,
    }],
    createdAtEpochMs: 20,
  };
  return { fixture, profile, repositories, request, run };
}

module.exports = Object.freeze({ CREDENTIAL_REF, createAudioModeIntentFixture });
