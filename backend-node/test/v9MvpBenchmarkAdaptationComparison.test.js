'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const { createNarrativeExecutionService } = require('../src/narrative/execution');
const { createNarrativeReviewService } = require('../src/narrative/reviews');
const {
  NarrativeAdaptationComparisonError,
  createNarrativeAdaptationComparison,
} = require('../src/narrative/reviews/adaptationComparison');
const narrativeReviewRoutes = require('../src/routes/v2/narrativeReviews');
const {
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  setupRainBeforeClearSource,
  uidFactory,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { uid } = require('./helpers/v2RepositoryDatabase');

const OWNERSHIP = Object.freeze({ accepts() { return true; } });

function request(current, overrides = {}) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: overrides.operationUid,
    dramaUid: current.dramaUid,
    sourceSelectionUid: current.selection.selection.uid,
    resultType: overrides.resultType,
    upstreamResultUid: overrides.upstreamResultUid ?? null,
    upstreamResultHash: overrides.upstreamResultHash ?? null,
    upstreamEnvelopeHash: overrides.upstreamEnvelopeHash ?? null,
    upstreamApprovalRef: overrides.upstreamApprovalRef ?? null,
    durationBudget: overrides.durationBudget ?? null,
    style: overrides.style ?? null,
    assetVersions: [],
  };
}

async function completeComparisonChain(t, start = 181000) {
  const current = setupRainBeforeClearSource(t, start);
  const responses = Object.freeze({
    extraction: JSON.stringify(createRainExtractionOutput(current.imported.blocks)),
    adaptation: JSON.stringify(createRainAdaptationOutput()),
  });
  const execution = createNarrativeExecutionService({
    repositories: current.repositories,
    provider: Object.freeze({
      scope: 'configured-text',
      isAvailable: () => true,
      generate(command) {
        return Object.freeze({
          model: Object.freeze({ provider: 'synthetic', name: 'same-source-fixture' }),
          parameters: Object.freeze({ temperature: 0 }),
          promptVersion: `mvp-source-${command.resultType}.v1`,
          rawResponse: responses[command.resultType],
        });
      },
    }),
    assetOwnership: OWNERSHIP,
    createUid: uidFactory(start + 100),
  });
  const reviews = createNarrativeReviewService({
    repositories: current.repositories,
    createUid: uidFactory(start + 300),
  });
  const extraction = await execution.execute(request(current, {
    operationUid: uid(start + 90), resultType: 'extraction',
  }));
  const extractionApproval = reviews.reviewResult({
    resultUid: extraction.result.uid,
    decision: 'approve',
  });
  const adaptation = await execution.execute(request(current, {
    operationUid: uid(start + 91),
    resultType: 'adaptation',
    upstreamResultUid: extraction.result.uid,
    upstreamResultHash: extraction.result.resultHash,
    upstreamEnvelopeHash: extraction.result.envelopeHash,
    upstreamApprovalRef: extractionApproval.approval.reviewRef,
    durationBudget: DURATION_BUDGET,
    style: STYLE,
  }));
  return Object.freeze({ current, reviews, extraction, extractionApproval, adaptation });
}

function comparisonArguments(chain) {
  const { current, extraction, extractionApproval, adaptation } = chain;
  const selection = current.repositories.sources.getSelection(current.selection.selection.uid);
  const document = current.repositories.sources.getDocument(selection.documentUid);
  return {
    adaptationRecord: current.repositories.narrativeReviews.getResult(adaptation.result.uid),
    extractionRecord: current.repositories.narrativeReviews.getResult(extraction.result.uid),
    extractionApproval: extractionApproval.approval,
    document,
    selection,
    blocks: current.repositories.sources.listBlocks(document.uid),
  };
}

test('the same benchmark source separates approved facts, inferences, and adaptation decisions', async (t) => {
  const chain = await completeComparisonChain(t);
  const { current, reviews, extraction, adaptation } = chain;
  const comparison = reviews.getAdaptationComparison(adaptation.result.uid);
  assert.equal(comparison.schemaVersion, 'narrative-adaptation-comparison.v1');
  assert.equal(comparison.sourceResultUid, extraction.result.uid);
  assert.equal(comparison.adaptationResultUid, adaptation.result.uid);
  assert.deepEqual(comparison.beats.map((beat) => beat.classification), [
    'fact', 'inference', 'adaptation', 'adaptation', 'adaptation',
  ]);
  assert.equal(comparison.adaptationDecisions.length, 1);
  assert.equal(comparison.adaptationDecisions[0].category, 'invented-event');
  assert.equal(comparison.adaptationDecisions[0].classification, 'adaptation');
  assert.ok(comparison.sourceFacts.some((fact) => fact.factId === 'event-restore-power'));
  assert.ok(comparison.sourceFacts.every((fact) => fact.classification === 'source_fact'));
  assert.equal(comparison.sourceDocumentSha256, current.pack.manifest.contentSha256);
  assert.equal(comparison.selectedTextSha256, current.pack.manifest.selection.selectedTextSha256);
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v9/narrative-adaptation-comparison.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(comparison), true, JSON.stringify(validate.errors));
});

test('comparison rejects coordinated upstream, fact, decision, input, and source drift', async (t) => {
  const chain = await completeComparisonChain(t, 182000);
  const base = comparisonArguments(chain);
  const wrongFact = structuredClone(base);
  wrongFact.adaptationRecord.result.output.beats[0].factRefs = ['missing-fact'];
  assert.throws(
    () => createNarrativeAdaptationComparison(wrongFact),
    NarrativeAdaptationComparisonError,
  );

  const wrongDecision = structuredClone(base);
  wrongDecision.adaptationRecord.result.output.beats[2].adaptationDecisionRefs = ['missing-decision'];
  assert.throws(
    () => createNarrativeAdaptationComparison(wrongDecision),
    NarrativeAdaptationComparisonError,
  );

  const ungroundedDecision = structuredClone(base);
  ungroundedDecision.adaptationRecord.result.output.adaptationDecisions[0].factRefs = [];
  assert.throws(
    () => createNarrativeAdaptationComparison(ungroundedDecision),
    NarrativeAdaptationComparisonError,
  );

  const wrongInputHash = structuredClone(base);
  wrongInputHash.adaptationRecord.result.inputHash = 'f'.repeat(64);
  assert.throws(
    () => createNarrativeAdaptationComparison(wrongInputHash),
    NarrativeAdaptationComparisonError,
  );

  const wrongUpstream = structuredClone(base);
  wrongUpstream.adaptationRecord.result.upstreamResultHash = 'e'.repeat(64);
  assert.throws(
    () => createNarrativeAdaptationComparison(wrongUpstream),
    NarrativeAdaptationComparisonError,
  );

  chain.current.database.exec('DROP TRIGGER v2_source_documents_immutable_evidence');
  chain.current.database.prepare('UPDATE source_documents SET content_sha256=? WHERE uid=?')
    .run('d'.repeat(64), chain.current.imported.document.uid);
  assert.throws(
    () => chain.reviews.getAdaptationComparison(chain.adaptation.result.uid),
    { code: 'NARRATIVE_REVIEW_DATA_INVALID' },
  );
});

test('localhost comparison route is read-only, path-bound, and type-specific', async (t) => {
  const chain = await completeComparisonChain(t, 183000);
  const app = express();
  app.use('/api/v1/v2', narrativeReviewRoutes(chain.current.database, { info() {}, error() {} }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/v1/v2`;

  const success = await fetch(
    `${base}/narrative-results/${chain.adaptation.result.uid}/adaptation-comparison`,
  );
  assert.equal(success.status, 200);
  const body = await success.json();
  assert.equal(body.success, true);
  assert.equal(body.data.adaptationResultUid, chain.adaptation.result.uid);
  assert.equal(body.data.sourceResultUid, chain.extraction.result.uid);

  const wrongType = await fetch(
    `${base}/narrative-results/${chain.extraction.result.uid}/adaptation-comparison`,
  );
  assert.equal(wrongType.status, 404);
  const invalid = await fetch(`${base}/narrative-results/INVALID/adaptation-comparison`);
  assert.equal(invalid.status, 400);
});
