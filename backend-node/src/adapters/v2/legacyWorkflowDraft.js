const { createHash } = require('node:crypto');

const { WORKFLOW_REGISTRY_VERSION } = require('@local-mini-drama/workflow-engine');
const { isCanonicalUuid } = require('../../workflows/identifiers');

const LEGACY_DRAFT_NAME = 'v1 兼容草稿';
const LEGACY_DRAFT_DESCRIPTION = '由 v1 画布兼容适配器生成；旧业务数据保持只读且不嵌入 v2 工作流。';

const NODE_SPECS = Object.freeze([
  Object.freeze({ key: 'source', nodeType: 'source.selection' }),
  Object.freeze({ key: 'facts', nodeType: 'story.facts' }),
  Object.freeze({ key: 'adaptation', nodeType: 'episode.adaptation' }),
  Object.freeze({ key: 'script', nodeType: 'script.structured' }),
  Object.freeze({ key: 'shots', nodeType: 'shot.plan' }),
]);

const EDGE_SPECS = Object.freeze([
  Object.freeze({ key: 'source-facts', source: 'source', sourcePort: 'selection', target: 'facts', targetPort: 'selection' }),
  Object.freeze({ key: 'facts-adaptation', source: 'facts', sourcePort: 'facts', target: 'adaptation', targetPort: 'facts' }),
  Object.freeze({ key: 'adaptation-script', source: 'adaptation', sourcePort: 'beats', target: 'script', targetPort: 'beats' }),
  Object.freeze({ key: 'script-shots', source: 'script', sourcePort: 'script', target: 'shots', targetPort: 'script' }),
]);

function deterministicUuidV4(dramaUid, key) {
  const bytes = createHash('sha256')
    .update(`local-mini-drama:v1-draft:${dramaUid}:${key}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createLegacyWorkflowDraft({ dramaUid }) {
  if (!isCanonicalUuid(dramaUid)) throw new TypeError('Legacy workflow drama identity is invalid');
  const nodeUids = new Map(NODE_SPECS.map((spec) => [
    spec.key,
    deterministicUuidV4(dramaUid, `node:${spec.key}`),
  ]));
  const nodes = NODE_SPECS.map((spec, index) => Object.freeze({
    uid: nodeUids.get(spec.key),
    nodeType: spec.nodeType,
    position: Object.freeze({ x: 80 + index * 280, y: 120 }),
    config: Object.freeze({}),
    domainRefType: null,
    domainRefUid: null,
    status: 'disabled',
  }));
  const edges = EDGE_SPECS.map((spec) => Object.freeze({
    uid: deterministicUuidV4(dramaUid, `edge:${spec.key}`),
    sourceNodeUid: nodeUids.get(spec.source),
    sourcePort: spec.sourcePort,
    targetNodeUid: nodeUids.get(spec.target),
    targetPort: spec.targetPort,
  }));
  return Object.freeze({
    definition: Object.freeze({
      uid: deterministicUuidV4(dramaUid, 'workflow'),
      dramaUid,
      name: LEGACY_DRAFT_NAME,
      version: 1,
      status: 'draft',
      description: LEGACY_DRAFT_DESCRIPTION,
      registryVersion: WORKFLOW_REGISTRY_VERSION,
      graphRevision: 0,
    }),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

module.exports = {
  LEGACY_DRAFT_DESCRIPTION,
  LEGACY_DRAFT_NAME,
  createLegacyWorkflowDraft,
};
