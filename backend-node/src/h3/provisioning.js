'use strict';

const { createV2Repositories } = require('../repositories/v2');
const { sha256Canonical } = require('./contract');
const { fail } = require('./errors');
const { createH3TextToVideoWorkflowBundle } = require('./workflowBundle');

function provisionH3TextToVideoManifest(database) {
  const repository = createV2Repositories(database).comfyManifests;
  const expected = createH3TextToVideoWorkflowBundle().manifest;
  const existing = repository.find(expected.manifestId, expected.version);
  if (existing) {
    if (sha256Canonical(existing) !== sha256Canonical(expected)) fail('H3_PROFILE_INVALID');
    return Object.freeze({ created: false, manifest: existing });
  }
  const manifest = repository.create(expected);
  return Object.freeze({ created: true, manifest });
}

module.exports = Object.freeze({ provisionH3TextToVideoManifest });
