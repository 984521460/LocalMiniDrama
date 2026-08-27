const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { normalizeApprovedShotPlan } = require('./approvedShotPlan');
const { narrativeTaskError } = require('./errors');
const { sha256Canonical } = require('./jsonSnapshot');
const { isProviderNeutralText } = require('./providerNeutralText');
const {
  createAuditedTaskResult,
  normalizeTaskEnvelope,
  parseStructuredResponse,
} = require('./structuredTask');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/prompt-semantic.schema.json',
));

const TASK_TYPE = 'PromptSemanticTask';
const SCHEMA_VERSION = 'prompt-semantic.v1';
const DOMAIN_KEYS = Object.freeze([
  'approvedExtraction',
  'extractionApproval',
  'adaptationResult',
  'adaptationApproval',
  'scriptResult',
  'scriptApproval',
  'assetVersions',
  'shotPlanningResult',
  'shotPlanningApproval',
]);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function responseInvalid() {
  throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
}

function referenceInvalid() {
  throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
}

function arraysEqual(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertProviderNeutralText(value) {
  if (!isProviderNeutralText(value)) responseInvalid();
}

function expectedAssetRefs(plannedShot, assetsByRef, assetType) {
  return plannedShot.assetVersionRefs.filter(
    (assetRef) => assetsByRef.get(assetRef)?.assetType === assetType,
  );
}

function assertPromptSemantics(domain, output) {
  const planned = domain.shotPlan.output;
  if (output.aspectRatio !== planned.aspectRatio
    || output.durationSummary.totalSeconds !== planned.durationSummary.totalSeconds
    || output.semanticShots.length !== planned.shots.length) referenceInvalid();

  for (let index = 0; index < planned.shots.length; index += 1) {
    const plannedShot = planned.shots[index];
    const semanticShot = output.semanticShots[index];
    const expectedCharacterAssets = expectedAssetRefs(
      plannedShot,
      domain.assetsByRef,
      'character',
    );
    const expectedSceneAssets = expectedAssetRefs(plannedShot, domain.assetsByRef, 'scene');
    const expectedPropAssets = expectedAssetRefs(plannedShot, domain.assetsByRef, 'prop');
    if (semanticShot.shotId !== plannedShot.shotId
      || semanticShot.ordinal !== plannedShot.ordinal
      || semanticShot.durationSeconds !== plannedShot.durationSeconds
      || !arraysEqual(semanticShot.subjects.characterFactRefs, plannedShot.characterFactRefs)
      || !arraysEqual(
        semanticShot.subjects.characterAssetVersionRefs,
        expectedCharacterAssets,
      )
      || semanticShot.environment.sceneId !== plannedShot.sceneId
      || !arraysEqual(semanticShot.environment.sceneAssetVersionRefs, expectedSceneAssets)
      || !arraysEqual(semanticShot.environment.propFactRefs, plannedShot.propFactRefs)
      || !arraysEqual(semanticShot.environment.propAssetVersionRefs, expectedPropAssets)
      || semanticShot.action !== plannedShot.action
      || semanticShot.camera.shotSize !== plannedShot.shotSize
      || semanticShot.camera.cameraAngle !== plannedShot.cameraAngle
      || semanticShot.camera.cameraMovement !== plannedShot.cameraMovement
      || semanticShot.camera.composition !== plannedShot.composition
      || semanticShot.continuity.transitionFromPrevious
        !== plannedShot.continuity.transitionFromPrevious
      || semanticShot.continuity.screenDirection !== plannedShot.continuity.screenDirection
      || semanticShot.continuity.axisStrategy !== plannedShot.continuity.axisStrategy
      || semanticShot.continuity.notes !== plannedShot.continuity.notes) referenceInvalid();

    for (const text of [
      semanticShot.subjects.description,
      semanticShot.environment.description,
      semanticShot.action,
      semanticShot.camera.composition,
      semanticShot.lighting.description,
      semanticShot.continuity.notes,
    ]) assertProviderNeutralText(text);
  }
}

function normalizePromptDomain(domain) {
  const shotPlan = normalizeApprovedShotPlan(
    domain.shotPlanningResult,
    domain.shotPlanningApproval,
    {
      approvedExtraction: domain.approvedExtraction,
      extractionApproval: domain.extractionApproval,
      adaptationResult: domain.adaptationResult,
      adaptationApproval: domain.adaptationApproval,
      scriptResult: domain.scriptResult,
      scriptApproval: domain.scriptApproval,
      assetVersions: domain.assetVersions,
    },
  );
  return {
    assetsByRef: new Map(
      shotPlan.assetVersions.map((asset) => [asset.assetVersionRef, asset]),
    ),
    shotPlan,
  };
}

function createPromptInputHash(domain) {
  return sha256Canonical({
    assetVersions: domain.shotPlan.assetVersions,
    ...domain.shotPlan.upstream,
    shotPlanningApproval: domain.shotPlan.approval,
    shotPlanningResult: domain.shotPlan.result,
  });
}

function createPromptSemanticTask() {
  return Object.freeze({
    complete(input) {
      const metadata = normalizeTaskEnvelope(input, DOMAIN_KEYS);
      const domain = normalizePromptDomain(metadata.domain);
      const output = parseStructuredResponse(metadata.rawResponse, validateSchema);
      assertPromptSemantics(domain, output);
      return createAuditedTaskResult({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        inputHash: createPromptInputHash(domain),
        metadata,
        auditFields: {
          upstreamShotHash: domain.shotPlan.approval.resultHash,
          shotApprovalRef: domain.shotPlan.approval.reviewRef,
          assetCatalogHash: sha256Canonical(domain.shotPlan.assetVersions),
        },
        output,
      });
    },
  });
}

module.exports = {
  SCHEMA_VERSION,
  TASK_TYPE,
  createPromptSemanticTask,
};
