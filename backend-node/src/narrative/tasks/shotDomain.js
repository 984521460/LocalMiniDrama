const { normalizeApprovedScript } = require('./approvedScript');
const { narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  deepFreeze,
  sha256Canonical,
  snapshotJson,
} = require('./jsonSnapshot');

const ASSET_VERSION_REF = /^asset-version:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const ASSET_TYPES = new Set(['character', 'scene', 'prop']);

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function referenceInvalid() {
  throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function normalizeAssetVersions(value) {
  let snapshot;
  try {
    snapshot = snapshotJson(value, {
      maxDepth: 4,
      maxNodes: 1200,
      maxStringBytes: 256 * 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  if (!Array.isArray(snapshot) || snapshot.length > 256) invalidInput();
  const refs = new Set();
  for (const asset of snapshot) {
    if (!exactKeys(asset, ['assetType', 'assetVersionRef', 'bindingRef'])
      || typeof asset.assetVersionRef !== 'string'
      || !ASSET_VERSION_REF.test(asset.assetVersionRef)
      || refs.has(asset.assetVersionRef)
      || !ASSET_TYPES.has(asset.assetType)
      || typeof asset.bindingRef !== 'string'
      || !IDENTIFIER.test(asset.bindingRef)) invalidInput();
    refs.add(asset.assetVersionRef);
  }
  return deepFreeze(snapshot);
}

function normalizeShotDomain(domain) {
  const script = normalizeApprovedScript(domain.scriptResult, domain.scriptApproval, {
    approvedExtraction: domain.approvedExtraction,
    extractionApproval: domain.extractionApproval,
    adaptationResult: domain.adaptationResult,
    adaptationApproval: domain.adaptationApproval,
  });
  const assetVersions = normalizeAssetVersions(domain.assetVersions);
  const scenes = new Map();
  const entries = new Map();
  let entryIndex = 0;
  for (const scene of script.output.scenes) {
    scenes.set(scene.sceneId, scene);
    for (const entry of scene.entries) {
      entries.set(entry.entryId, { entry, entryIndex, scene });
      entryIndex += 1;
    }
  }
  return {
    assetVersions,
    assetsByRef: new Map(assetVersions.map((asset) => [asset.assetVersionRef, asset])),
    entries,
    scenes,
    script,
  };
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertAssetRef(asset, shot, scene) {
  if (asset.assetType === 'character') {
    if (!shot.characterFactRefs.includes(asset.bindingRef)) referenceInvalid();
    return;
  }
  if (asset.assetType === 'prop') {
    if (!shot.propFactRefs.includes(asset.bindingRef)) referenceInvalid();
    return;
  }
  if (asset.bindingRef !== scene.sceneId && asset.bindingRef !== scene.sceneFactRef) {
    referenceInvalid();
  }
}

function assertShotSemantics(domain, output) {
  const shotIds = new Set();
  const coveredEntryIds = new Set();
  const sceneDurations = new Map();
  let previousShot = null;
  let previousLastEntryIndex = -1;
  let totalSeconds = 0;

  for (let shotIndex = 0; shotIndex < output.shots.length; shotIndex += 1) {
    const shot = output.shots[shotIndex];
    if (shot.ordinal !== shotIndex + 1 || shotIds.has(shot.shotId)) referenceInvalid();
    shotIds.add(shot.shotId);
    const scene = domain.scenes.get(shot.sceneId);
    if (!scene) referenceInvalid();
    const entryRecords = shot.entryRefs.map((entryRef) => domain.entries.get(entryRef));
    if (entryRecords.some((record) => !record || record.scene.sceneId !== scene.sceneId)) {
      referenceInvalid();
    }
    const indices = entryRecords.map((record) => record.entryIndex);
    if (indices.some((index, position) => position > 0 && index <= indices[position - 1])
      || indices[0] < previousLastEntryIndex) referenceInvalid();
    previousLastEntryIndex = indices.at(-1);
    for (const record of entryRecords) coveredEntryIds.add(record.entry.entryId);

    const expectedDialogueRefs = entryRecords
      .filter((record) => record.entry.type === 'dialogue')
      .map((record) => record.entry.entryId);
    if (!arraysEqual(shot.dialogueEntryRefs, expectedDialogueRefs)
      || shot.characterFactRefs.some((ref) => !scene.characterFactRefs.includes(ref))
      || shot.propFactRefs.some((ref) => !scene.propFactRefs.includes(ref))) referenceInvalid();

    const requiredCharacterRefs = new Set();
    const requiredPropRefs = new Set();
    for (const { entry } of entryRecords) {
      if (entry.type === 'action') {
        for (const ref of entry.characterFactRefs) requiredCharacterRefs.add(ref);
        for (const ref of entry.propFactRefs) requiredPropRefs.add(ref);
      } else if (entry.speakerCharacterFactId !== null) {
        requiredCharacterRefs.add(entry.speakerCharacterFactId);
      }
    }
    if ([...requiredCharacterRefs].some((ref) => !shot.characterFactRefs.includes(ref))
      || [...requiredPropRefs].some((ref) => !shot.propFactRefs.includes(ref))) referenceInvalid();

    for (const assetRef of shot.assetVersionRefs) {
      const asset = domain.assetsByRef.get(assetRef);
      if (!asset) referenceInvalid();
      assertAssetRef(asset, shot, scene);
    }

    if (shotIndex === 0) {
      if (shot.continuity.transitionFromPrevious !== 'start'
        || shot.continuity.axisStrategy !== 'establish') referenceInvalid();
    } else {
      if (shot.continuity.transitionFromPrevious === 'start') referenceInvalid();
      const sceneChanged = previousShot.sceneId !== shot.sceneId;
      if (sceneChanged && shot.continuity.axisStrategy !== 'establish') referenceInvalid();
      if (!sceneChanged
        && previousShot.continuity.screenDirection !== 'neutral'
        && shot.continuity.screenDirection !== 'neutral'
        && previousShot.continuity.screenDirection !== shot.continuity.screenDirection
        && shot.continuity.axisStrategy !== 'intentional_cross') referenceInvalid();
    }

    sceneDurations.set(
      scene.sceneId,
      (sceneDurations.get(scene.sceneId) || 0) + shot.durationSeconds,
    );
    totalSeconds += shot.durationSeconds;
    previousShot = shot;
  }

  if (domain.script.orderedEntries.some((entryId) => !coveredEntryIds.has(entryId))) {
    referenceInvalid();
  }
  if (domain.script.output.scenes.some(
    (scene) => sceneDurations.get(scene.sceneId) !== scene.estimatedDurationSeconds,
  )
    || !Number.isSafeInteger(totalSeconds)
    || totalSeconds !== output.durationSummary.totalSeconds
    || totalSeconds !== domain.script.output.durationSummary.totalSeconds) {
    throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  }
}

function createShotPlanningInputHash(domain) {
  return sha256Canonical({
    assetVersions: domain.assetVersions,
    ...domain.script.upstream,
    scriptApproval: domain.script.approval,
    scriptResult: domain.script.result,
  });
}

module.exports = {
  assertShotSemantics,
  createShotPlanningInputHash,
  normalizeShotDomain,
};
