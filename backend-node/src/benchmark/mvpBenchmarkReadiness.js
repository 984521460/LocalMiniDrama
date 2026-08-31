'use strict';

const { types: { isProxy } } = require('node:util');

const {
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
  is: OBJECT_IS,
} = Object;
const { ownKeys: OWN_KEYS } = Reflect;
const {
  SUPPORTED_MATERIALIZED_NODE_TYPES,
} = require('../workflows/materializedNodeExecutor');

const SCHEMA_VERSION = 'mvp-benchmark-readiness.v1';
const CHECKLIST_VERSION = 'mvp-section-19.v1';

const CAPABILITY_SPECS = Object.freeze([
  Object.freeze({ id: 'database-contracts', kind: 'local', blockerCode: 'MVP_DATABASE_CONTRACTS_UNAVAILABLE' }),
  Object.freeze({ id: 'narrative-execution', kind: 'local', blockerCode: 'MVP_NARRATIVE_EXECUTOR_UNAVAILABLE' }),
  Object.freeze({ id: 'character-candidate-execution', kind: 'local', blockerCode: 'MVP_CHARACTER_CANDIDATE_EXECUTOR_UNAVAILABLE' }),
  Object.freeze({ id: 'workflow-execution', kind: 'local', blockerCode: 'MVP_WORKFLOW_EXECUTOR_UNAVAILABLE' }),
  Object.freeze({ id: 'remote-execution', kind: 'local', blockerCode: 'MVP_REMOTE_EXECUTION_UNAVAILABLE' }),
  Object.freeze({ id: 'ready-gpu-connection', kind: 'external', blockerCode: 'MVP_READY_GPU_CONNECTION_REQUIRED' }),
  Object.freeze({ id: 'h3-local-execution', kind: 'external', blockerCode: 'MVP_H3_LOCAL_EXECUTION_UNAVAILABLE' }),
  Object.freeze({ id: 'tts-execution', kind: 'external', blockerCode: 'MVP_TTS_EXECUTION_UNAVAILABLE' }),
  Object.freeze({ id: 'media-export', kind: 'local', blockerCode: 'MVP_MEDIA_EXPORT_UNAVAILABLE' }),
  Object.freeze({ id: 'project-archive-v21', kind: 'local', blockerCode: 'MVP_PROJECT_ARCHIVE_V21_UNAVAILABLE' }),
  Object.freeze({ id: 'windows-release-evidence', kind: 'release', blockerCode: 'MVP_WINDOWS_RELEASE_EVIDENCE_PENDING' }),
  Object.freeze({ id: 'human-av-review', kind: 'human', blockerCode: 'MVP_HUMAN_AV_REVIEW_PENDING' }),
]);

const CHECKLIST_SPECS = Object.freeze([
  ['windows-package-start', 'function', 'system-test'],
  ['source-import-encoding', 'function', 'project-evidence'],
  ['source-selection', 'function', 'project-evidence'],
  ['source-evidence-trace', 'function', 'project-evidence'],
  ['facts-decision-separation', 'function', 'project-evidence'],
  ['narrative-sixty-seconds', 'function', 'project-evidence'],
  ['script-shot-schema', 'function', 'project-evidence'],
  ['character-four-candidates', 'function', 'project-evidence'],
  ['character-lock-reference-pack', 'function', 'project-evidence'],
  ['scene-prop-version-bindings', 'function', 'project-evidence'],
  ['workflow-canvas-roundtrip-execution', 'function', 'localhost-and-project-evidence'],
  ['remote-ssh-sftp-tunnel', 'function', 'external-receipt'],
  ['comfy-health-dependencies', 'function', 'external-receipt'],
  ['storyboard-image-generation', 'function', 'project-media-evidence'],
  ['h3-local-video-generation', 'function', 'project-media-evidence'],
  ['character-voice-tts', 'function', 'project-media-evidence'],
  ['subtitle-final-audio', 'function', 'project-media-evidence'],
  ['bgm-replace-ducking', 'function', 'project-media-evidence'],
  ['shot-reordering', 'function', 'project-evidence'],
  ['final-1080p-export', 'function', 'project-media-evidence'],
  ['uuid-entities', 'reliability', 'database-evidence'],
  ['asset-logical-uri-version', 'reliability', 'database-evidence'],
  ['immutable-generation-results', 'reliability', 'database-evidence'],
  ['archive-v21-roundtrip', 'reliability', 'roundtrip-receipt'],
  ['secret-free-persistence', 'reliability', 'scan-receipt'],
  ['remote-prompt-stage', 'reliability', 'database-evidence'],
  ['startup-recovery', 'reliability', 'restart-receipt'],
  ['failure-not-complete', 'reliability', 'fault-receipt'],
  ['engineering-gates', 'quality', 'test-receipt'],
  ['same-project-full-run', 'quality', 'benchmark-receipt'],
  ['final-video-decode', 'quality', 'media-receipt'],
  ['human-subtitle-sync-bgm', 'quality', 'human-review'],
  ['licenses-and-sources', 'quality', 'license-receipt'],
  ['accepted-residual-risks', 'quality', 'approval'],
].map(([id, section, evidenceKind]) => Object.freeze({ id, section, evidenceKind })));

function pushValue(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function invalidReadiness() {
  throw new TypeError('MVP benchmark readiness is invalid');
}

function ownDataSnapshot(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    invalidReadiness();
  }
  let prototype;
  let descriptors;
  try {
    prototype = GET_PROTOTYPE_OF(value);
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    invalidReadiness();
  }
  if (prototype !== Object.prototype && prototype !== null) invalidReadiness();
  return descriptors;
}

function denseArraySnapshot(value, expectedLength) {
  if (isProxy(value) || !Array.isArray(value)) invalidReadiness();
  let prototype;
  let descriptors;
  try {
    prototype = GET_PROTOTYPE_OF(value);
    descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    invalidReadiness();
  }
  if (prototype !== Array.prototype
    || descriptors.length?.value !== expectedLength
    || OWN_KEYS(descriptors).length !== expectedLength + 1) invalidReadiness();
  const snapshot = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) {
      invalidReadiness();
    }
    pushValue(snapshot, descriptor.value);
  }
  return FREEZE(snapshot);
}

function assertExactSnapshot(value, expected) {
  if (expected === null || typeof expected !== 'object') {
    if (!OBJECT_IS(value, expected)) invalidReadiness();
    return;
  }
  if (Array.isArray(expected)) {
    const actualItems = denseArraySnapshot(value, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      assertExactSnapshot(actualItems[index], expected[index]);
    }
    return;
  }
  const actualDescriptors = ownDataSnapshot(value);
  const expectedDescriptors = GET_OWN_PROPERTY_DESCRIPTORS(expected);
  const expectedKeys = OWN_KEYS(expectedDescriptors);
  const actualKeys = OWN_KEYS(actualDescriptors);
  if (actualKeys.length !== expectedKeys.length) invalidReadiness();
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (typeof key !== 'string') invalidReadiness();
    const actual = actualDescriptors[key];
    const expectedDescriptor = expectedDescriptors[key];
    if (!actual || !actual.enumerable || !HAS_OWN(actual, 'value')
      || !expectedDescriptor || !HAS_OWN(expectedDescriptor, 'value')) invalidReadiness();
    assertExactSnapshot(actual.value, expectedDescriptor.value);
  }
}

function dataValue(value, key) {
  if (!value || typeof value !== 'object' || isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function hasFunction(root, path) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = dataValue(current, path[index]);
    if (!current) return false;
  }
  return typeof dataValue(current, path[path.length - 1]) === 'function';
}

function hasProductionWorkflowExecutor(runtime) {
  if (!hasFunction(runtime, ['workflows', 'executeNode'])) return false;
  const workflows = dataValue(runtime, 'workflows');
  const supported = dataValue(workflows, 'supportedNodeTypes');
  try {
    const values = denseArraySnapshot(supported, SUPPORTED_MATERIALIZED_NODE_TYPES.length);
    for (let index = 0; index < SUPPORTED_MATERIALIZED_NODE_TYPES.length; index += 1) {
      if (values[index] !== SUPPORTED_MATERIALIZED_NODE_TYPES[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function databaseState(readinessRepository) {
  if (!readinessRepository || typeof readinessRepository !== 'object'
    || isProxy(readinessRepository)) {
    return Object.freeze({ contractsReady: false, readyConnection: false });
  }
  try {
    const inspect = dataValue(readinessRepository, 'inspect');
    if (typeof inspect !== 'function' || isProxy(inspect)) throw new TypeError();
    const result = Reflect.apply(inspect, readinessRepository, []);
    const descriptors = ownDataSnapshot(result);
    const keys = OWN_KEYS(descriptors);
    if (keys.length !== 2 || !HAS_OWN(descriptors, 'contractsReady')
      || !HAS_OWN(descriptors, 'readyConnection')) throw new TypeError();
    const contractsReady = descriptors.contractsReady.value;
    const readyConnection = descriptors.readyConnection.value;
    if (typeof contractsReady !== 'boolean' || typeof readyConnection !== 'boolean') {
      throw new TypeError();
    }
    return Object.freeze({ contractsReady, readyConnection });
  } catch {
    return Object.freeze({ contractsReady: false, readyConnection: false });
  }
}

function capabilityStates(runtime, readinessRepository) {
  const stored = databaseState(readinessRepository);
  const remoteReady = hasFunction(runtime, ['remoteExecution', 'remoteCoordinator', 'execute'])
    && hasFunction(runtime, ['remoteExecution', 'remoteTasks', 'get'])
    && hasFunction(runtime, ['remoteExecution', 'remoteEnvironment', 'inspect']);
  const states = Object.freeze({
    'database-contracts': stored.contractsReady,
    'narrative-execution': hasFunction(runtime, ['narrativeTasks', 'execute']),
    'character-candidate-execution': hasFunction(runtime, ['characterCandidates', 'complete']),
    'workflow-execution': hasProductionWorkflowExecutor(runtime),
    'remote-execution': remoteReady,
    'ready-gpu-connection': stored.readyConnection,
    'h3-local-execution': hasFunction(runtime, ['h3Local', 'execute'])
      && stored.readyConnection,
    'tts-execution': hasFunction(runtime, ['audio', 'tts', 'execute']),
    'media-export': hasFunction(runtime, ['mediaExports', 'service', 'start']),
    'project-archive-v21': stored.contractsReady,
  });
  const capabilities = [];
  for (let index = 0; index < CAPABILITY_SPECS.length; index += 1) {
    const spec = CAPABILITY_SPECS[index];
    const pending = spec.kind === 'release' || spec.kind === 'human';
    const ready = !pending && states[spec.id] === true;
    pushValue(capabilities, Object.freeze({
      id: spec.id,
      kind: spec.kind,
      status: pending ? 'pending' : ready ? 'ready' : 'blocked',
      blockerCode: ready ? null : spec.blockerCode,
    }));
  }
  return Object.freeze(capabilities);
}

function createMvpBenchmarkReadiness({ runtime, readinessRepository } = {}) {
  const capabilities = capabilityStates(runtime, readinessRepository);
  const blockedCapabilityIds = [];
  const pendingCapabilityIds = [];
  for (let index = 0; index < capabilities.length; index += 1) {
    const item = capabilities[index];
    if (item.status === 'blocked') pushValue(blockedCapabilityIds, item.id);
    if (item.status === 'pending') pushValue(pendingCapabilityIds, item.id);
  }
  FREEZE(blockedCapabilityIds);
  FREEZE(pendingCapabilityIds);
  const checklist = [];
  for (let index = 0; index < CHECKLIST_SPECS.length; index += 1) {
    const spec = CHECKLIST_SPECS[index];
    pushValue(checklist, Object.freeze({
      id: spec.id,
      section: spec.section,
      evidenceKind: spec.evidenceKind,
      status: 'pending',
    }));
  }
  FREEZE(checklist);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    checklistVersion: CHECKLIST_VERSION,
    readyForBenchmark: blockedCapabilityIds.length === 0,
    mvpComplete: false,
    capabilities,
    blockedCapabilityIds,
    pendingCapabilityIds,
    checklist,
  });
}

function parseMvpBenchmarkReadiness(value, { runtime, readinessRepository } = {}) {
  const expected = createMvpBenchmarkReadiness({ runtime, readinessRepository });
  assertExactSnapshot(value, expected);
  return expected;
}

module.exports = Object.freeze({
  CAPABILITY_SPECS,
  CHECKLIST_SPECS,
  CHECKLIST_VERSION,
  SCHEMA_VERSION,
  createMvpBenchmarkReadiness,
  parseMvpBenchmarkReadiness,
});
