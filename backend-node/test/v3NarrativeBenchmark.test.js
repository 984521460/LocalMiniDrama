const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSourceDocumentService } = require('../src/narrative/sourceDocuments');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const {
  NarrativeTaskError,
  createEpisodeAdaptationTask,
  createNovelExtractionTask,
  createPromptSemanticTask,
  createScriptFormattingTask,
  createShotPlanningTask,
} = require('../src/narrative/tasks');
const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');
const {
  DURATION_BUDGET,
  STYLE,
  codePointLength,
  completionMetadata,
  createAdaptationOutput,
  createAssetVersions,
  createExtractionOutput,
  createPromptOutput,
  createScriptOutput,
  createShotOutput,
} = require('./fixtures/narrative/benchmarkFixture');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'narrative', 'benchmark.txt');

function createUidFactory(start) {
  let next = start;
  return () => uid(next++);
}

function setup(t) {
  const database = createMigratedV2Database(t);
  const dramaUid = uid(7100);
  insertDrama(database, dramaUid, 'Narrative benchmark');
  const dramaId = database.prepare('SELECT id FROM dramas WHERE uid = ?').get(dramaUid).id;
  const repositories = createV2Repositories(database);
  return {
    database,
    dramaId,
    dramaUid,
    sourceService: createSourceDocumentService({ repositories, createUid: createUidFactory(7200) }),
    reviewService: createNarrativeReviewService({ repositories, createUid: createUidFactory(7300) }),
  };
}

function createWholeDocumentSource(sourceService, dramaId) {
  const imported = sourceService.importDocument({
    dramaId,
    fileName: 'benchmark.txt',
    bytes: fs.readFileSync(FIXTURE_PATH),
  });
  assert.equal(imported.status, 'ready');
  const first = imported.blocks[0];
  const last = imported.blocks.at(-1);
  const selected = sourceService.createSelection({
    documentUid: imported.document.uid,
    startBlockUid: first.uid,
    endBlockUid: last.uid,
    startOffset: 0,
    endOffset: codePointLength(last.text),
  });
  return Object.freeze({
    imported,
    source: Object.freeze({
      documentUid: imported.document.uid,
      blocks: imported.blocks.map((block) => Object.freeze({
        uid: block.uid,
        documentUid: block.documentUid,
        ordinal: block.ordinal,
        text: block.text,
        textSha256: block.textSha256,
      })),
      selection: Object.freeze({
        uid: selected.selection.uid,
        documentUid: selected.selection.documentUid,
        startBlockUid: selected.selection.startBlockUid,
        endBlockUid: selected.selection.endBlockUid,
        startOffset: selected.selection.startOffset,
        endOffset: selected.selection.endOffset,
        selectedTextSha256: selected.selection.selectedTextSha256,
      }),
    }),
  });
}

function recordAndApprove(reviewService, context, resultType, result, upstreamResultUid) {
  const stored = reviewService.recordResult({
    dramaUid: context.dramaUid,
    sourceSelectionUid: context.source.selection.uid,
    resultType,
    ...(upstreamResultUid ? { upstreamResultUid } : {}),
    result,
  });
  return reviewService.reviewResult({
    resultUid: stored.uid,
    decision: 'approve',
    comment: `benchmark ${resultType} approved`,
  });
}

function completeBenchmark(t) {
  const context = setup(t);
  Object.assign(context, createWholeDocumentSource(context.sourceService, context.dramaId));

  const extractionOutput = createExtractionOutput(context.source.blocks);
  const extractionInput = {
    source: context.source,
    ...completionMetadata('novel-extraction', 1, extractionOutput),
  };
  const extractionResult = createNovelExtractionTask().complete(extractionInput);
  const extraction = recordAndApprove(
    context.reviewService, context, 'extraction', extractionResult,
  );

  const adaptationOutput = createAdaptationOutput();
  const adaptationInput = {
    approvedExtraction: extractionResult.output,
    approval: extraction.approval,
    durationBudget: DURATION_BUDGET,
    style: STYLE,
    ...completionMetadata('episode-adaptation', 2, adaptationOutput),
  };
  const adaptationResult = createEpisodeAdaptationTask().complete(adaptationInput);
  const adaptation = recordAndApprove(
    context.reviewService, context, 'adaptation', adaptationResult, extraction.result.uid,
  );

  const scriptOutput = createScriptOutput();
  const scriptInput = {
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    ...completionMetadata('script-formatting', 3, scriptOutput),
  };
  const scriptResult = createScriptFormattingTask().complete(scriptInput);
  const script = recordAndApprove(
    context.reviewService, context, 'script', scriptResult, adaptation.result.uid,
  );

  const assetVersions = createAssetVersions();
  const shotOutput = createShotOutput();
  const shotInput = {
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    scriptResult,
    scriptApproval: script.approval,
    assetVersions,
    ...completionMetadata('shot-planning', 4, shotOutput),
  };
  const shotResult = createShotPlanningTask().complete(shotInput);
  const shot = recordAndApprove(
    context.reviewService, context, 'shot', shotResult, script.result.uid,
  );

  const promptOutput = createPromptOutput();
  const promptInput = {
    approvedExtraction: extractionResult.output,
    extractionApproval: extraction.approval,
    adaptationResult,
    adaptationApproval: adaptation.approval,
    scriptResult,
    scriptApproval: script.approval,
    assetVersions,
    shotPlanningResult: shotResult,
    shotPlanningApproval: shot.approval,
    ...completionMetadata('prompt-semantic', 5, promptOutput),
  };
  const promptResult = createPromptSemanticTask().complete(promptInput);

  return Object.freeze({
    ...context,
    extraction: Object.freeze({ input: extractionInput, result: extractionResult, reviewed: extraction }),
    adaptation: Object.freeze({ input: adaptationInput, result: adaptationResult, reviewed: adaptation }),
    script: Object.freeze({ input: scriptInput, result: scriptResult, reviewed: script }),
    shot: Object.freeze({ input: shotInput, result: shotResult, reviewed: shot }),
    prompt: Object.freeze({ input: promptInput, result: promptResult }),
  });
}

function assertTaskFailure(task, input, expectedCodes) {
  const sourceSentinel = '赵云在雨夜进入客栈';
  assert.throws(() => task.complete(input), (error) => (
    error instanceof NarrativeTaskError
    && expectedCodes.includes(error.code)
    && !error.message.includes(sourceSentinel)
    && !JSON.stringify(error).includes(sourceSentinel)
    && !String(error.stack).includes(sourceSentinel)
  ));
}

test('runs the synthetic text from import through an approved five-shot storyboard', (t) => {
  const benchmark = completeBenchmark(t);
  const approved = benchmark.reviewService.requireApproved(benchmark.shot.reviewed.result.uid, 'shot');

  assert.equal(approved.approval.status, 'approved');
  assert.equal(approved.result.taskType, 'ShotPlanningTask');
  assert.equal(benchmark.shot.result.output.shots.length, 5);
  assert.equal(benchmark.shot.result.output.durationSummary.totalSeconds, 60);
  assert.equal(benchmark.prompt.result.output.semanticShots.length, 5);
  assert.deepEqual(
    benchmark.reviewService.listForDrama(benchmark.dramaId).map((result) => [result.resultType, result.status]),
    [['extraction', 'approved'], ['adaptation', 'approved'], ['script', 'approved'], ['shot', 'approved']],
  );
  assert.equal(
    benchmark.extraction.result.output.characters.every(
      (fact) => fact.evidence.every((item) => benchmark.source.blocks.some((block) => block.uid === item.blockUid)),
    ),
    true,
  );
  assert.equal(Object.isFrozen(benchmark.prompt.result), true);
});

test('fails closed for truncated JSON, wrong types and out-of-selection evidence', (t) => {
  const benchmark = completeBenchmark(t);
  const task = createNovelExtractionTask();
  const before = benchmark.database.prepare('SELECT count(*) AS count FROM narrative_results').get().count;

  assertTaskFailure(task, { ...benchmark.extraction.input, rawResponse: '{"schemaVersion":' }, [
    'NARRATIVE_TASK_RESPONSE_INVALID',
  ]);
  const wrongType = createExtractionOutput(benchmark.source.blocks);
  wrongType.characters = {};
  assertTaskFailure(task, {
    ...benchmark.extraction.input,
    rawResponse: JSON.stringify(wrongType),
  }, ['NARRATIVE_TASK_RESPONSE_INVALID']);
  const outsideSelection = createExtractionOutput(benchmark.source.blocks);
  outsideSelection.characters[0].evidence[0].endOffset = 100000;
  assertTaskFailure(task, {
    ...benchmark.extraction.input,
    rawResponse: JSON.stringify(outsideSelection),
  }, ['NARRATIVE_TASK_EVIDENCE_INVALID']);

  assert.equal(benchmark.database.prepare('SELECT count(*) AS count FROM narrative_results').get().count, before);
});

test('fails closed for excessive duration and inconsistent downstream references', (t) => {
  const benchmark = completeBenchmark(t);

  const excessiveDuration = createAdaptationOutput();
  excessiveDuration.beats.at(-1).estimatedDurationSeconds = 40;
  excessiveDuration.durationSummary.totalSeconds = 90;
  assertTaskFailure(createEpisodeAdaptationTask(), {
    ...benchmark.adaptation.input,
    rawResponse: JSON.stringify(excessiveDuration),
  }, ['NARRATIVE_TASK_RESPONSE_INVALID']);

  const inconsistentScript = createScriptOutput();
  inconsistentScript.scenes[0].characterFactRefs.push('character-not-approved');
  assertTaskFailure(createScriptFormattingTask(), {
    ...benchmark.script.input,
    rawResponse: JSON.stringify(inconsistentScript),
  }, ['NARRATIVE_TASK_REFERENCE_INVALID']);

  const inconsistentShot = createShotOutput();
  inconsistentShot.shots[0].entryRefs = ['entry-not-approved'];
  assertTaskFailure(createShotPlanningTask(), {
    ...benchmark.shot.input,
    rawResponse: JSON.stringify(inconsistentShot),
  }, ['NARRATIVE_TASK_REFERENCE_INVALID']);

  const inconsistentPrompt = createPromptOutput();
  inconsistentPrompt.semanticShots[0].shotId = 'shot-not-approved';
  assertTaskFailure(createPromptSemanticTask(), {
    ...benchmark.prompt.input,
    rawResponse: JSON.stringify(inconsistentPrompt),
  }, ['NARRATIVE_TASK_REFERENCE_INVALID']);
});
