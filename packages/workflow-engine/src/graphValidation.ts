import { WorkflowGraphError, type WorkflowGraphErrorCode } from './graphErrors';
import { WorkflowRegistryError } from './errors';
import { getNodeTypeDefinition, getPortDefinition } from './registry';

declare const require: (specifier: string) => {
  readonly types: { readonly isProxy: (value: unknown) => boolean };
};

const { types: { isProxy } } = require('node:util');

const MAX_NODES = 500;
const MAX_EDGES = 2000;

export interface WorkflowGraphNodeInput {
  readonly uid: string;
  readonly nodeType: string;
  readonly bound?: boolean;
  readonly disabled?: boolean;
}

export interface WorkflowGraphEdgeInput {
  readonly uid: string;
  readonly sourceNodeUid: string;
  readonly sourcePort: string;
  readonly targetNodeUid: string;
  readonly targetPort: string;
}

export interface WorkflowGraphInput {
  readonly nodes: readonly WorkflowGraphNodeInput[];
  readonly edges: readonly WorkflowGraphEdgeInput[];
}

export interface WorkflowGraphValidationResult {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly topologicalOrder: readonly string[];
}

type DataDescriptors = Record<PropertyKey, PropertyDescriptor>;

function fail(code: WorkflowGraphErrorCode): never {
  throw new WorkflowGraphError(code);
}

function recordDescriptors(value: unknown, allowedKeys: readonly string[]): DataDescriptors {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('WORKFLOW_GRAPH_INPUT_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('WORKFLOW_GRAPH_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol')) fail('WORKFLOW_GRAPH_INPUT_INVALID');
  const allowed = new Set(allowedKeys);
  for (const key of keys) {
    const stringKey = key as string;
    if (!allowed.has(stringKey) || !Object.hasOwn(descriptors[stringKey] ?? {}, 'value')) {
      fail('WORKFLOW_GRAPH_INPUT_INVALID');
    }
  }
  return descriptors;
}

function descriptorValue(descriptors: DataDescriptors, key: string): unknown {
  const descriptor = descriptors[key];
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function arrayItems(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('WORKFLOW_GRAPH_INPUT_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DataDescriptors;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) fail('WORKFLOW_GRAPH_INPUT_INVALID');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) fail('WORKFLOW_GRAPH_INPUT_INVALID');
  if (length > maximum) fail('WORKFLOW_GRAPH_TOO_LARGE');
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === 'symbol') || keys.length !== length + 1) {
    fail('WORKFLOW_GRAPH_INPUT_INVALID');
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('WORKFLOW_GRAPH_INPUT_INVALID');
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail('WORKFLOW_GRAPH_INPUT_INVALID');
  }
  return value;
}

function optionalBoolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('WORKFLOW_GRAPH_INPUT_INVALID');
  return value;
}

function parseNodes(value: unknown): WorkflowGraphNodeInput[] {
  const nodes: WorkflowGraphNodeInput[] = [];
  const seen = new Set<string>();
  for (const candidate of arrayItems(value, MAX_NODES)) {
    const descriptors = recordDescriptors(candidate, ['uid', 'nodeType', 'bound', 'disabled']);
    const uid = text(descriptorValue(descriptors, 'uid'));
    const nodeType = text(descriptorValue(descriptors, 'nodeType'));
    if (seen.has(uid)) fail('WORKFLOW_GRAPH_NODE_DUPLICATE');
    seen.add(uid);
    try {
      getNodeTypeDefinition(nodeType);
    } catch (error) {
      if (error instanceof WorkflowRegistryError) fail('WORKFLOW_GRAPH_NODE_UNKNOWN');
      throw error;
    }
    nodes.push(Object.freeze({
      uid,
      nodeType,
      bound: optionalBoolean(descriptorValue(descriptors, 'bound')),
      disabled: optionalBoolean(descriptorValue(descriptors, 'disabled')),
    }));
  }
  return nodes;
}

function parseEdges(value: unknown): WorkflowGraphEdgeInput[] {
  const edges: WorkflowGraphEdgeInput[] = [];
  const seenUids = new Set<string>();
  const seenConnections = new Set<string>();
  for (const candidate of arrayItems(value, MAX_EDGES)) {
    const descriptors = recordDescriptors(candidate, [
      'uid', 'sourceNodeUid', 'sourcePort', 'targetNodeUid', 'targetPort',
    ]);
    const parsed = Object.freeze({
      uid: text(descriptorValue(descriptors, 'uid')),
      sourceNodeUid: text(descriptorValue(descriptors, 'sourceNodeUid')),
      sourcePort: text(descriptorValue(descriptors, 'sourcePort')),
      targetNodeUid: text(descriptorValue(descriptors, 'targetNodeUid')),
      targetPort: text(descriptorValue(descriptors, 'targetPort')),
    });
    const connection = [
      parsed.sourceNodeUid,
      parsed.sourcePort,
      parsed.targetNodeUid,
      parsed.targetPort,
    ].join('\u0000');
    if (seenUids.has(parsed.uid) || seenConnections.has(connection)) {
      fail('WORKFLOW_GRAPH_EDGE_DUPLICATE');
    }
    seenUids.add(parsed.uid);
    seenConnections.add(connection);
    edges.push(parsed);
  }
  return edges;
}

function topologicalOrder(nodes: readonly WorkflowGraphNodeInput[], edges: readonly WorkflowGraphEdgeInput[]): string[] {
  const indegree = new Map(nodes.map((node) => [node.uid, 0]));
  const outgoing = new Map(nodes.map((node) => [node.uid, [] as string[]]));
  for (const edge of edges) {
    const sourceTargets = outgoing.get(edge.sourceNodeUid);
    if (!sourceTargets || !indegree.has(edge.targetNodeUid)) fail('WORKFLOW_GRAPH_ENDPOINT_UNKNOWN');
    sourceTargets.push(edge.targetNodeUid);
    indegree.set(edge.targetNodeUid, (indegree.get(edge.targetNodeUid) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort();
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([uid]) => uid)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const uid = ready.shift();
    if (uid === undefined) break;
    ordered.push(uid);
    for (const target of outgoing.get(uid) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (ordered.length !== nodes.length) fail('WORKFLOW_GRAPH_CYCLE');
  return ordered;
}

export function validateWorkflowGraph(input: unknown): Readonly<WorkflowGraphValidationResult> {
  const root = recordDescriptors(input, ['nodes', 'edges']);
  const nodes = parseNodes(descriptorValue(root, 'nodes'));
  const edges = parseEdges(descriptorValue(root, 'edges'));
  const byUid = new Map(nodes.map((node) => [node.uid, node]));

  for (const edge of edges) {
    if (!byUid.has(edge.sourceNodeUid) || !byUid.has(edge.targetNodeUid)) {
      fail('WORKFLOW_GRAPH_ENDPOINT_UNKNOWN');
    }
    if (edge.sourceNodeUid === edge.targetNodeUid) fail('WORKFLOW_GRAPH_SELF_EDGE');
  }
  const ordered = topologicalOrder(nodes, edges);

  const inputCounts = new Map<string, number>();
  for (const edge of edges) {
    const source = byUid.get(edge.sourceNodeUid);
    const target = byUid.get(edge.targetNodeUid);
    if (!source || !target) fail('WORKFLOW_GRAPH_ENDPOINT_UNKNOWN');
    if (source.disabled && !target.disabled) fail('WORKFLOW_GRAPH_DISABLED_DEPENDENCY');
    let sourcePort;
    let targetPort;
    try {
      sourcePort = getPortDefinition(source.nodeType, 'output', edge.sourcePort);
      targetPort = getPortDefinition(target.nodeType, 'input', edge.targetPort);
    } catch (error) {
      if (error instanceof WorkflowRegistryError) fail('WORKFLOW_GRAPH_PORT_UNKNOWN');
      throw error;
    }
    if (sourcePort.valueType !== targetPort.valueType) fail('WORKFLOW_GRAPH_TYPE_MISMATCH');
    const key = `${target.uid}\u0000${targetPort.id}`;
    const count = (inputCounts.get(key) ?? 0) + 1;
    inputCounts.set(key, count);
    if (targetPort.cardinality === 'one' && count > 1) fail('WORKFLOW_GRAPH_INPUT_CARDINALITY');
  }

  for (const node of nodes) {
    const definition = getNodeTypeDefinition(node.nodeType);
    if (node.bound && definition.inputs.some((port) => (
      (inputCounts.get(`${node.uid}\u0000${port.id}`) ?? 0) > 0
    ))) fail('WORKFLOW_GRAPH_BOUND_INPUT');
    if (node.bound || node.disabled) continue;
    for (const port of definition.inputs) {
      if (port.required && (inputCounts.get(`${node.uid}\u0000${port.id}`) ?? 0) === 0) {
        fail('WORKFLOW_GRAPH_REQUIRED_INPUT');
      }
    }
  }

  return Object.freeze({
    nodeCount: nodes.length,
    edgeCount: edges.length,
    topologicalOrder: Object.freeze(ordered),
  });
}
