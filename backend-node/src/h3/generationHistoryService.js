'use strict';

const { types: { isProxy } } = require('node:util');

const {
  createPromptSemanticVersionRecord,
} = require('../assets/generationHistory');
const {
  isPromptSemanticVersioningResult,
} = require('../narrative/promptSemanticVersioning');
const { sha256Canonical, uid } = require('./contract');
const { fail, isH3ContractError } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { validateH3VideoEvidence, validateH3VideoOutput } = require('./outputValidation');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');
const { assertH3WorkflowVerified } = require('./workflowSupport');
const { validateH3ExecutionIntent } = require('./executionIntent');

const CODE = 'H3_HISTORY_CONFLICT';
const MAX_EPOCH_MS = 253402300799999;
const HISTORY_SERVICES = new WeakSet();

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(CODE);
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail(CODE);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(CODE);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) fail(CODE);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(CODE);
    output[key] = descriptor.value;
  }
  return output;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || value.length !== 24
    || !Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) fail(CODE);
  return parsed;
}

function promptSemanticRecord(value) {
  const input = exactRecord(value, ['uid', 'semantic', 'createdAtEpochMs']);
  uid(input.uid, CODE);
  if (!Number.isSafeInteger(input.createdAtEpochMs)
    || input.createdAtEpochMs < 0 || input.createdAtEpochMs > MAX_EPOCH_MS
    || !isPromptSemanticVersioningResult(input.semantic)) fail(CODE);
  return input;
}

function storedPromptSemanticRecord(value) {
  try {
    return createPromptSemanticVersionRecord({
      uid: value.uid,
      semantic: value.semantic,
      createdAtEpochMs: value.createdAtEpochMs,
    }, CODE);
  } catch {
    return fail(CODE);
  }
}

function remotePromptId(value) {
  if (typeof value !== 'string' || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(CODE);
  return value;
}

function assertPromptBinding(promptRecord, generationSpec) {
  const semantic = promptRecord.semantic;
  if (semantic.dramaUid !== generationSpec.prompt.dramaUid
    || !semantic.output || !Array.isArray(semantic.output.semanticShots)) fail(CODE);
  const matches = semantic.output.semanticShots.filter(
    (shot) => shot.shotId === generationSpec.prompt.shotId,
  );
  if (matches.length !== 1
    || matches[0].continuitySnapshotUid !== generationSpec.prompt.continuitySnapshotUid
    || sha256Canonical(matches[0]) !== generationSpec.prompt.semanticSha256) fail(CODE);
}

function assertManifest(repositories, manifestUid) {
  uid(manifestUid, CODE);
  const expected = createH3TextToVideoWorkflowBundle().manifest;
  let manifest;
  try { manifest = repositories.comfyManifests.get(manifestUid); } catch { return fail(CODE); }
  if (manifest.uid !== expected.uid || manifestUid !== expected.uid
    || manifest.status !== 'validated'
    || manifest.workflowSha256 !== expected.workflowSha256
    || manifest.manifestId !== expected.manifestId
    || manifest.version !== expected.version) fail(CODE);
  return expected;
}

function assertVersion(repositories, assetUid, outputVersionUid, evidence, expectedParentVersionUid) {
  uid(assetUid, CODE);
  uid(outputVersionUid, CODE);
  let asset;
  let version;
  try {
    asset = repositories.assets.get(assetUid);
    version = repositories.assets.getVersion(outputVersionUid);
  } catch {
    return fail(CODE);
  }
  if (asset.ownerType !== 'drama' || asset.ownerUid === null || asset.assetType !== 'video'
    || asset.status === 'deleted' || version.assetUid !== asset.uid
    || version.status !== 'ready' || version.mimeType !== evidence.mimeType
    || version.sha256 !== evidence.sha256 || version.width !== evidence.width
    || version.height !== evidence.height || version.durationMs !== evidence.durationMs
    || version.parentUid !== expectedParentVersionUid) fail(CODE);
  return { asset, version };
}

function historyPayload({ promptSemantic, generationSpec, manifestUid, remotePromptId, videoEvidence }) {
  return Object.freeze({
    parameters: Object.freeze({
      profileUid: generationSpec.profileUid,
      mode: generationSpec.mode,
      width: generationSpec.width,
      height: generationSpec.height,
      frames: generationSpec.frames,
      fps: generationSpec.fps,
      seed: generationSpec.seed,
    }),
    input: Object.freeze({
      promptSemanticUid: promptSemantic.uid,
      manifestUid,
      remotePromptId,
      generationSpec,
      videoEvidence,
    }),
  });
}

function createH3GenerationHistoryService(options) {
  const configured = exactRecord(options, ['repositories']);
  const repositories = configured.repositories;
  if (!repositories || typeof repositories !== 'object' || isProxy(repositories)
    || !repositories.assets || !repositories.comfyManifests
    || !repositories.generationHistory || !repositories.runs
    || typeof repositories.withTransaction !== 'function') {
    throw new TypeError('H3 generation history service configuration is invalid');
  }

  function read(historyUid) {
    uid(historyUid, CODE);
    let history;
    try { history = repositories.generationHistory.get(historyUid); } catch { return fail(CODE); }
    if (history.provider !== 'local-comfy' || history.model !== 'MiniMax-H3'
      || history.status !== 'succeeded') fail(CODE);
    const input = exactRecord(history.input, [
      'promptSemanticUid', 'manifestUid', 'remotePromptId', 'generationSpec', 'videoEvidence',
    ]);
    const parameters = exactRecord(history.parameters, [
      'profileUid', 'mode', 'width', 'height', 'frames', 'fps', 'seed',
    ]);
    uid(input.promptSemanticUid, CODE);
    remotePromptId(input.remotePromptId);
    if (input.manifestUid !== history.manifestUid
      || input.promptSemanticUid !== history.promptSemanticUid) fail(CODE);
    let generationSpec;
    let videoEvidence;
    try {
      generationSpec = validateH3GenerationSpec(input.generationSpec);
      assertH3WorkflowVerified(generationSpec);
      videoEvidence = validateH3VideoEvidence({
        generationSpec,
        evidence: input.videoEvidence,
      });
    } catch (error) {
      if (isH3ContractError(error)) return fail(CODE);
      return fail(CODE);
    }
    if (generationSpec.prompt.dramaUid !== history.dramaUid
      || history.seed !== generationSpec.seed
      || parameters.profileUid !== generationSpec.profileUid
      || parameters.mode !== generationSpec.mode
      || parameters.width !== generationSpec.width
      || parameters.height !== generationSpec.height
      || parameters.frames !== generationSpec.frames
      || parameters.fps !== generationSpec.fps
      || parameters.seed !== generationSpec.seed) fail(CODE);
    if (history.outputVersionEvidence.sha256 !== videoEvidence.sha256
      || history.outputVersionEvidence.mimeType !== videoEvidence.mimeType
      || history.outputVersionEvidence.width !== videoEvidence.width
      || history.outputVersionEvidence.height !== videoEvidence.height
      || history.outputVersionEvidence.durationMs !== videoEvidence.durationMs) fail(CODE);
    return Object.freeze({ history, generationSpec, videoEvidence });
  }

  function prepareRecord(value, sourceRepositories, {
    storedPrompt = false,
    expectedParentVersionUid,
  } = {}) {
    const input = exactRecord(value, [
      'runUid', 'historyUid', 'remotePromptId', 'promptSemantic', 'generationSpec',
      'manifestUid', 'assetUid', 'outputVersionUid', 'measured',
    ]);
    uid(input.runUid, CODE);
    uid(input.historyUid, CODE);
    remotePromptId(input.remotePromptId);
    const promptSemantic = storedPrompt
      ? storedPromptSemanticRecord(input.promptSemantic)
      : promptSemanticRecord(input.promptSemantic);
    let generationSpec;
    let videoEvidence;
    try {
      generationSpec = validateH3GenerationSpec(input.generationSpec);
      assertH3WorkflowVerified(generationSpec);
      videoEvidence = validateH3VideoOutput({
        generationSpec,
        measured: input.measured,
      });
    } catch (error) {
      if (isH3ContractError(error)) throw error;
      return fail(CODE);
    }
    assertPromptBinding(promptSemantic, generationSpec);
    const manifest = assertManifest(sourceRepositories, input.manifestUid);
    const { asset, version } = assertVersion(
      sourceRepositories,
      input.assetUid,
      input.outputVersionUid,
      videoEvidence,
      expectedParentVersionUid,
    );
    const payload = historyPayload({
      promptSemantic,
      generationSpec,
      manifestUid: manifest.uid,
      remotePromptId: input.remotePromptId,
      videoEvidence,
    });
    return Object.freeze({
      input, promptSemantic, generationSpec, videoEvidence, manifest, asset, version, payload,
    });
  }

  function writeRecord(scoped, prepared, { preparedPrompt = false } = {}) {
    const {
      input, promptSemantic, generationSpec, manifest, asset, version, payload,
    } = prepared;
    let history;
    scoped.runs.createGeneration({
      uid: input.runUid,
      ownerType: asset.ownerType,
      ownerUid: asset.ownerUid,
      provider: 'local-comfy',
      model: 'MiniMax-H3',
      seed: generationSpec.seed,
      parameters: payload.parameters,
      input: payload.input,
      promptVersionUid: promptSemantic.uid,
      status: 'queued',
    });
    scoped.runs.transitionGenerationStatus({
      uid: input.runUid,
      expectedStatus: 'queued',
      nextStatus: 'running',
    });
    const terminal = scoped.runs.transitionGenerationStatus({
          uid: input.runUid,
          expectedStatus: 'running',
          nextStatus: 'succeeded',
          outputAssetVersionUid: version.uid,
        });
    const historyInput = {
      uid: input.historyUid,
      runUid: terminal.uid,
      dramaUid: generationSpec.prompt.dramaUid,
      assetUid: asset.uid,
      promptSemanticUid: promptSemantic.uid,
      manifestUid: manifest.uid,
      manifestSha256: manifest.workflowSha256,
      provider: terminal.provider,
      model: terminal.model,
      seed: terminal.seed,
      parameters: terminal.parameters,
      input: terminal.input,
      status: terminal.status,
      outputVersionUid: version.uid,
      outputVersionEvidence: version,
      parentVersionUid: version.parentUid,
      parentVersionEvidence: version.parentUid === null
        ? null : scoped.assets.getVersion(version.parentUid),
      errorCode: null,
      errorDetailRef: null,
      createdAtEpochMs: timestamp(terminal.createdAt),
      completedAtEpochMs: timestamp(terminal.completedAt),
    };
    history = preparedPrompt
      ? scoped.generationHistory.appendPrepared(promptSemantic.uid, historyInput)
      : scoped.generationHistory.append(promptSemantic, historyInput);
    return history;
  }

  function record(value) {
    const input = exactRecord(value, [
      'runUid', 'historyUid', 'remotePromptId', 'promptSemantic', 'generationSpec',
      'manifestUid', 'assetUid', 'outputVersionUid', 'measured',
    ]);
    let prepared;
    let history;
    try {
      const asset = repositories.assets.get(input.assetUid);
      prepared = prepareRecord(input, repositories, {
        expectedParentVersionUid: asset.currentVersionUid,
      });
      repositories.withTransaction((scoped) => {
        history = writeRecord(scoped, prepared);
      });
    } catch (error) {
      if (isH3ContractError(error)) throw error;
      return fail(CODE);
    }
    const result = read(history.uid);
    let selection;
    try { selection = repositories.generationHistory.getSelectionState(prepared.asset.uid); } catch {
      return fail(CODE);
    }
    return Object.freeze({ ...result, selection });
  }

  const service = Object.freeze({
    get: read,
    record,
    recordPrepared(scoped, value) {
      const input = exactRecord(value, [
        'intent', 'remotePromptId', 'outputVersionUid', 'measured',
      ]);
      const intent = validateH3ExecutionIntent(input.intent);
      const prepared = prepareRecord({
        runUid: intent.generationRunUid,
        historyUid: intent.historyUid,
        remotePromptId: input.remotePromptId,
        promptSemantic: intent.promptSemantic,
        generationSpec: intent.generationSpec,
        manifestUid: intent.manifestUid,
        assetUid: intent.assetUid,
        outputVersionUid: input.outputVersionUid,
        measured: input.measured,
      }, scoped, {
        storedPrompt: true,
        expectedParentVersionUid: intent.parentVersionUid,
      });
      return writeRecord(scoped, prepared, { preparedPrompt: true });
    },
  });
  HISTORY_SERVICES.add(service);
  return service;
}

function isH3GenerationHistoryService(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && HISTORY_SERVICES.has(value);
}

module.exports = Object.freeze({
  createH3GenerationHistoryService,
  isH3GenerationHistoryService,
});
