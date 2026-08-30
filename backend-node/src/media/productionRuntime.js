'use strict';

const { randomUUID } = require('node:crypto');

const { createV2Repositories } = require('../repositories/v2');
const { createLocalMediaExporter } = require('./localMediaExporter');
const { createMediaExportService } = require('./mediaExportService');
const { removeVerifiedMediaExportOutput } = require('./localMediaExportWorkspace');

function createProductionMediaExportRuntime({
  database,
  localRoot,
  workspaceRoot,
  dependencies = {},
} = {}) {
  if (!database || typeof localRoot !== 'string' || typeof workspaceRoot !== 'string') {
    throw new TypeError('Production media export runtime configuration is invalid');
  }
  const repository = createV2Repositories(database).mediaExportRuns;
  const exporter = dependencies.exporter ?? createLocalMediaExporter({
    localRoot,
    workspaceRoot,
    ...(dependencies.ffmpegPath ? { ffmpegPath: dependencies.ffmpegPath } : {}),
    ...(dependencies.ffprobePath ? { ffprobePath: dependencies.ffprobePath } : {}),
    ...(dependencies.runProcess ? { runProcess: dependencies.runProcess } : {}),
    ...(dependencies.timeoutMs ? { timeoutMs: dependencies.timeoutMs } : {}),
  });
  const createUid = dependencies.createUid ?? randomUUID;
  const nowEpochMs = dependencies.nowEpochMs ?? Date.now;
  const removeOutput = dependencies.removeOutput ?? (
    (relativePath, expectedSha256) => removeVerifiedMediaExportOutput(
      localRoot, relativePath, expectedSha256,
    )
  );
  const service = createMediaExportService({
    repository, exporter, createUid, nowEpochMs, removeOutput,
  });
  return Object.freeze({ mediaExports: Object.freeze({ service }) });
}

module.exports = Object.freeze({ createProductionMediaExportRuntime });
