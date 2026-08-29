'use strict';

const TRUSTED_PHASE_7_VARIANT_KEYS = new Set([
  'fl2va-first:1:0',
  'fl2va-first-last:2:0',
  'ref2va:4:1',
]);

function workflowVariantKey(mode, referenceImageCount, referenceAudio) {
  return `${mode}:${referenceImageCount}:${referenceAudio ? 1 : 0}`;
}

function isH3Phase7WorkflowVariantTrusted({ mode, referenceImageCount, referenceAudio }) {
  return TRUSTED_PHASE_7_VARIANT_KEYS.has(
    workflowVariantKey(mode, referenceImageCount, referenceAudio),
  );
}

module.exports = Object.freeze({ isH3Phase7WorkflowVariantTrusted });
