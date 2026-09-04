'use strict';

const {
  INPUT_CODE,
  createMvpBenchmarkHumanAvReview,
  parseMvpBenchmarkHumanAvReview,
  requestRecord,
  serializeMvpBenchmarkHumanAvReview,
} = require('../../benchmark/mvpBenchmarkHumanAvReview');
const { canonicalUid, exactObject } = require('../../audio/audioContract');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark human audiovisual review';

function createMvpBenchmarkHumanAvReviewRepository(database, dependencies) {
  if (!dependencies?.sessions || !dependencies?.preflights || !dependencies?.mediaExportRuns) {
    throw new TypeError('MVP benchmark human audiovisual review repository dependencies invalid');
  }
  const statements = Object.freeze({
    get: database.prepare(`
      SELECT review.*,seal.review_sha256 AS sealed_review_sha256
      FROM mvp_benchmark_human_av_reviews AS review
      LEFT JOIN mvp_benchmark_human_av_review_seals AS seal ON seal.review_uid=review.uid
      WHERE review.uid=?
    `),
    getByAuthorization: database.prepare(`
      SELECT review.*,seal.review_sha256 AS sealed_review_sha256
      FROM mvp_benchmark_human_av_reviews AS review
      LEFT JOIN mvp_benchmark_human_av_review_seals AS seal ON seal.review_uid=review.uid
      WHERE review.authorization_uid=?
    `),
    insert: database.prepare(`
      INSERT INTO mvp_benchmark_human_av_reviews (
        uid,session_uid,authorization_uid,batch_sha256,drama_uid,workflow_run_uid,
        export_run_uid,export_execution_plan_sha256,output_asset_uid,
        output_asset_version_uid,output_sha256,output_bytes,output_duration_ms,
        output_width,output_height,export_completed_at_epoch_ms,
        video_playback_accepted,subtitle_sync_accepted,bgm_balance_accepted,
        review_note,reviewed_at_epoch_ms,review_json,review_sha256
      ) VALUES (
        @uid,@sessionUid,@authorizationUid,@batchSha256,@dramaUid,@workflowRunUid,
        @exportRunUid,@exportExecutionPlanSha256,@outputAssetUid,
        @outputAssetVersionUid,@outputSha256,@outputBytes,@outputDurationMs,
        @outputWidth,@outputHeight,@exportCompletedAtEpochMs,
        @videoPlaybackAccepted,@subtitleSyncAccepted,@bgmBalanceAccepted,
        @reviewNote,@reviewedAtEpochMs,@reviewJson,@reviewSha256
      )
    `),
  });

  function dataInvalid() {
    throw new V2RepositoryDataError(ENTITY, 'record');
  }

  function assertSources(review) {
    let batch;
    let exportRun;
    let session;
    try {
      session = dependencies.sessions.getStored(review.sessionUid);
      batch = dependencies.preflights.getStoredBatchByAuthorization(review.authorizationUid);
      exportRun = dependencies.mediaExportRuns.get(review.exportRunUid);
    } catch {
      return dataInvalid();
    }
    if (!session || session.uid !== review.sessionUid
      || session.dramaUid !== review.dramaUid
      || session.workflowRunUid !== review.workflowRunUid
      || !batch || batch.batchSha256 !== review.batchSha256
      || batch.authorizationUid !== review.authorizationUid
      || batch.sessionUid !== review.sessionUid
      || batch.dramaUid !== review.dramaUid
      || exportRun.status !== 'succeeded'
      || exportRun.dramaUid !== review.dramaUid
      || exportRun.workflowRunUid !== review.workflowRunUid
      || exportRun.executionPlanSha256 !== review.exportExecutionPlanSha256
      || exportRun.outputAssetUid !== review.outputAssetUid
      || exportRun.outputAssetVersionUid !== review.outputAssetVersionUid
      || exportRun.output?.sha256 !== review.outputSha256
      || exportRun.output?.bytes !== review.outputBytes
      || exportRun.output?.durationMs !== review.outputDurationMs
      || exportRun.output?.width !== review.outputWidth
      || exportRun.output?.height !== review.outputHeight
      || Date.parse(exportRun.completedAt) !== review.exportCompletedAtEpochMs) dataInvalid();
    return Object.freeze({ batch, exportRun });
  }

  function map(row) {
    if (!row) return null;
    try {
      const review = parseMvpBenchmarkHumanAvReview(JSON.parse(row.review_json));
      if (serializeMvpBenchmarkHumanAvReview(review) !== row.review_json
        || row.uid !== review.uid
        || row.session_uid !== review.sessionUid
        || row.authorization_uid !== review.authorizationUid
        || row.batch_sha256 !== review.batchSha256
        || row.drama_uid !== review.dramaUid
        || row.workflow_run_uid !== review.workflowRunUid
        || row.export_run_uid !== review.exportRunUid
        || row.export_execution_plan_sha256 !== review.exportExecutionPlanSha256
        || row.output_asset_uid !== review.outputAssetUid
        || row.output_asset_version_uid !== review.outputAssetVersionUid
        || row.output_sha256 !== review.outputSha256
        || row.output_bytes !== review.outputBytes
        || row.output_duration_ms !== review.outputDurationMs
        || row.output_width !== review.outputWidth
        || row.output_height !== review.outputHeight
        || row.export_completed_at_epoch_ms !== review.exportCompletedAtEpochMs
        || row.video_playback_accepted !== Number(review.videoPlaybackAccepted)
        || row.subtitle_sync_accepted !== Number(review.subtitleSyncAccepted)
        || row.bgm_balance_accepted !== Number(review.bgmBalanceAccepted)
        || row.review_note !== review.reviewNote
        || row.reviewed_at_epoch_ms !== review.reviewedAtEpochMs
        || row.review_sha256 !== review.reviewSha256
        || row.sealed_review_sha256 !== review.reviewSha256) dataInvalid();
      assertSources(review);
      return review;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return dataInvalid();
    }
  }

  function reviewFrom(request, uid, nowEpochMs) {
    const session = dependencies.sessions.getStored(request.sessionUid);
    const batch = dependencies.preflights.getStoredBatchByAuthorization(
      request.authorizationUid,
    );
    if (!session || session.dramaUid !== request.dramaUid
      || !batch || batch.sessionUid !== request.sessionUid
      || batch.dramaUid !== request.dramaUid
      || batch.batchSha256 !== request.expectedBatchSha256) {
      throw new V2RepositoryConflictError(ENTITY, 'reviewed');
    }
    const exportRun = dependencies.mediaExportRuns.get(request.exportRunUid);
    if (exportRun.status !== 'succeeded'
      || exportRun.dramaUid !== request.dramaUid
      || exportRun.workflowRunUid !== session.workflowRunUid) {
      throw new V2RepositoryConflictError(ENTITY, 'reviewed');
    }
    return createMvpBenchmarkHumanAvReview({
      uid,
      sessionUid: request.sessionUid,
      authorizationUid: request.authorizationUid,
      batchSha256: request.expectedBatchSha256,
      dramaUid: request.dramaUid,
      workflowRunUid: exportRun.workflowRunUid,
      exportRunUid: exportRun.uid,
      exportExecutionPlanSha256: exportRun.executionPlanSha256,
      outputAssetUid: exportRun.outputAssetUid,
      outputAssetVersionUid: exportRun.outputAssetVersionUid,
      outputSha256: exportRun.output.sha256,
      outputBytes: exportRun.output.bytes,
      outputDurationMs: exportRun.output.durationMs,
      outputWidth: exportRun.output.width,
      outputHeight: exportRun.output.height,
      exportCompletedAtEpochMs: Date.parse(exportRun.completedAt),
      videoPlaybackAccepted: request.videoPlaybackAccepted,
      subtitleSyncAccepted: request.subtitleSyncAccepted,
      bgmBalanceAccepted: request.bgmBalanceAccepted,
      reviewNote: request.reviewNote,
      reviewedAtEpochMs: nowEpochMs,
    });
  }

  const insertAndRead = database.transaction((request, reviewUid, nowEpochMs) => {
    const existing = statements.getByAuthorization.get(request.authorizationUid);
    if (existing) {
      const stored = map(existing);
      if (stored.sessionUid !== request.sessionUid
        || stored.dramaUid !== request.dramaUid
        || stored.batchSha256 !== request.expectedBatchSha256
        || stored.exportRunUid !== request.exportRunUid
        || stored.videoPlaybackAccepted !== request.videoPlaybackAccepted
        || stored.subtitleSyncAccepted !== request.subtitleSyncAccepted
        || stored.bgmBalanceAccepted !== request.bgmBalanceAccepted
        || stored.reviewNote !== request.reviewNote) {
        throw new V2RepositoryConflictError(ENTITY, 'reviewed');
      }
      return stored;
    }
    const review = reviewFrom(request, reviewUid, nowEpochMs);
    statements.insert.run({
      ...review,
      reviewJson: serializeMvpBenchmarkHumanAvReview(review),
      videoPlaybackAccepted: Number(review.videoPlaybackAccepted),
      subtitleSyncAccepted: Number(review.subtitleSyncAccepted),
      bgmBalanceAccepted: Number(review.bgmBalanceAccepted),
    });
    return map(statements.get.get(review.uid));
  });

  return Object.freeze({
    create(value, { nowEpochMs = Date.now() } = {}) {
      const input = exactObject(value, ['uid', 'request'], INPUT_CODE);
      let reviewUid;
      let request;
      try {
        reviewUid = canonicalUid(input.uid, INPUT_CODE);
        request = requestRecord(input.request);
      } catch {
        throw new TypeError('MVP benchmark human audiovisual review repository input invalid');
      }
      let result;
      executeWrite(ENTITY, 'reviewed', () => {
        result = insertAndRead.immediate(request, reviewUid, nowEpochMs);
      });
      return result;
    },
    get(uid) {
      try { canonicalUid(uid, INPUT_CODE); } catch {
        throw new TypeError('MVP benchmark human audiovisual review repository input invalid');
      }
      return map(statements.get.get(uid));
    },
    getByAuthorization(authorizationUid) {
      try { canonicalUid(authorizationUid, INPUT_CODE); } catch {
        throw new TypeError('MVP benchmark human audiovisual review repository input invalid');
      }
      return map(statements.getByAuthorization.get(authorizationUid));
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkHumanAvReviewRepository });
