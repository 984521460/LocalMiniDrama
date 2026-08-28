'use strict';

const { fail } = require('./errors');

function assertH3WorkflowVerified(generationSpec) {
  if (generationSpec.mode !== 't2v' || generationSpec.referenceAudio !== null) {
    fail('H3_WORKFLOW_UNVERIFIED');
  }
  return generationSpec;
}

module.exports = Object.freeze({ assertH3WorkflowVerified });
