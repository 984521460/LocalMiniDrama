'use strict';

const { createH3TextToVideoWorkflowBundle } = require('../h3/workflowBundle');
const { exactKeys, sha256Canonical, snapshot } = require('../h3/contract');
const { fail } = require('../h3/errors');
const { isH3LocalVideoInspector } = require('../h3/localVideoInspector');
const {
  validateH3OutputExpectation,
  validateH3WorkflowValues,
} = require('../h3/outputExpectation');
const { H3_PROFILE } = require('../h3/profile');

const VERIFIERS = new WeakSet();

function createRemoteOutputVerifier({ h3Inspector } = {}) {
  if (!isH3LocalVideoInspector(h3Inspector)) throw new TypeError('Remote output verifier configuration is invalid');
  const expectedManifest = createH3TextToVideoWorkflowBundle().manifest;
  function copiedInput(input, fields) {
    const root = snapshot(input, 'H3_OUTPUT_INVALID', {
      maxArrayLength: 5000,
      maxDepth: 40,
      maxEntries: 60_000,
      maxStringBytes: 512 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    });
    exactKeys(root, fields, 'H3_OUTPUT_INVALID');
    return root;
  }

  function expectation(planNode, manifest) {
    const config = planNode?.config;
    const claimsH3 = config?.profileUid === H3_PROFILE.uid
      || config?.manifestUid === expectedManifest.uid
      || manifest?.uid === expectedManifest.uid
      || manifest?.manifestId === expectedManifest.manifestId
      || manifest?.workflowSha256 === expectedManifest.workflowSha256
      || manifest?.modelFamily === expectedManifest.modelFamily;
    if (!claimsH3) return null;
    if (planNode.nodeType !== 'shot.video'
      || config.profileUid !== H3_PROFILE.uid
      || config.manifestUid !== expectedManifest.uid
      || manifest?.uid !== expectedManifest.uid
      || sha256Canonical(manifest) !== sha256Canonical(expectedManifest)) {
      fail('H3_OUTPUT_INVALID');
    }
    return validateH3OutputExpectation({
      width: config.width,
      height: config.height,
      durationMs: config.durationMs,
      fps: config.fps,
    });
  }

  const verifier = Object.freeze({
    preflight(input) {
      let root;
      try {
        root = copiedInput(input, ['planNode', 'manifest', 'values']);
        const expected = expectation(root.planNode, root.manifest);
        if (expected !== null) {
          validateH3WorkflowValues(root.values, expected, root.planNode.config.seed);
        }
        return expected;
      } catch {
        return fail('H3_OUTPUT_INVALID');
      }
    },
    async verify(input) {
      let root;
      let expected;
      try {
        root = copiedInput(input, [
          'planNode', 'manifest', 'localRelativePath', 'remoteSha256', 'remoteBytes', 'mimeType',
        ]);
        expected = expectation(root.planNode, root.manifest);
      } catch {
        return fail('H3_OUTPUT_INVALID');
      }
      if (expected === null) {
        return Object.freeze({ width: null, height: null, durationMs: null, measured: null });
      }
      try {
        if (root.mimeType !== 'video/mp4') fail('H3_OUTPUT_INVALID');
        const measured = await h3Inspector.inspect({
          localRelativePath: root.localRelativePath,
          remoteSha256: root.remoteSha256,
          remoteBytes: root.remoteBytes,
          expected: {
            width: expected.width,
            height: expected.height,
            durationMs: expected.durationMs,
            frames: expected.frames,
            fps: expected.fps,
          },
        });
        return Object.freeze({
          width: measured.width,
          height: measured.height,
          durationMs: measured.durationMs,
          measured,
        });
      } catch {
        return fail('H3_OUTPUT_INVALID');
      }
    },
  });
  VERIFIERS.add(verifier);
  return verifier;
}

function isRemoteOutputVerifier(value) {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && VERIFIERS.has(value);
}

module.exports = Object.freeze({ createRemoteOutputVerifier, isRemoteOutputVerifier });
