import {
  WorkflowExecutionScopeError,
  type WorkflowExecutionScopeErrorCode,
} from './executionScopeErrors';

declare const require: (specifier: string) => {
  readonly types: { readonly isProxy: (value: unknown) => boolean };
};

const { types: { isProxy } } = require('node:util');

const MAX_NODES = 500;
const MAX_EDGES = 2000;

export type WorkflowExecutionScopeMode = 'full' | 'node' | 'downstream' | 'selection';

export interface WorkflowExecutionScopePlanNode {
  readonly uid: string;
  readonly enabled: boolean;
}

export interface WorkflowExecutionScopePlanEdge {
  readonly sourceNodeUid: string;
  readonly targetNodeUid: string;
}

export interface WorkflowExecutionScopePlan {
  readonly nodes: readonly WorkflowExecutionScopePlanNode[];
  readonly edges: readonly WorkflowExecutionScopePlanEdge[];
  readonly topologicalOrder: readonly string[];
}

export type WorkflowExecutionScopeInput =
  | Readonly<{ mode: 'full' }>
  | Readonly<{ mode: 'node' | 'downstream'; nodeUid: string }>
  | Readonly<{ mode: 'selection'; nodeUids: readonly string[] }>;

export interface WorkflowExecutionScope {
  readonly mode: WorkflowExecutionScopeMode;
  readonly executionOrder: readonly string[];
  readonly skippedNodeUids: readonly string[];
}

type DataDescriptors = Record<PropertyKey, PropertyDescriptor>;

function fail(code: WorkflowExecutionScopeErrorCode): never {
  throw new WorkflowExecutionScopeError(code);
}

function recordDescriptors(value: unknown, allowedKeys: readonly string[]): DataDescriptors {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('WORKFLOW_SCOPE_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set(allowedKeys);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  for (const key of keys as string[]) {
    if (!Object.hasOwn(descriptors[key] ?? {}, 'value')) fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  return descriptors;
}

function descriptorValue(descriptors: DataDescriptors, key: string): unknown {
  const descriptor = descriptors[key];
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function arrayItems(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DataDescriptors;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) fail('WORKFLOW_SCOPE_INPUT_INVALID');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) fail('WORKFLOW_SCOPE_INPUT_INVALID');
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('WORKFLOW_SCOPE_INPUT_INVALID');
    items.push(descriptor.value);
  }
  return items;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail('WORKFLOW_SCOPE_INPUT_INVALID');
  }
  return value;
}

function parsePlan(value: unknown): {
  nodes: ReadonlyMap<string, boolean>;
  edges: readonly WorkflowExecutionScopePlanEdge[];
  order: readonly string[];
} {
  const root = recordDescriptors(value, ['nodes', 'edges', 'topologicalOrder']);
  const nodes = new Map<string, boolean>();
  for (const candidate of arrayItems(descriptorValue(root, 'nodes'), MAX_NODES)) {
    const descriptors = recordDescriptors(candidate, ['uid', 'enabled']);
    const uid = text(descriptorValue(descriptors, 'uid'));
    const enabled = descriptorValue(descriptors, 'enabled');
    if (typeof enabled !== 'boolean' || nodes.has(uid)) fail('WORKFLOW_SCOPE_INPUT_INVALID');
    nodes.set(uid, enabled);
  }
  const edges = arrayItems(descriptorValue(root, 'edges'), MAX_EDGES).map((candidate) => {
    const descriptors = recordDescriptors(candidate, ['sourceNodeUid', 'targetNodeUid']);
    const edge = Object.freeze({
      sourceNodeUid: text(descriptorValue(descriptors, 'sourceNodeUid')),
      targetNodeUid: text(descriptorValue(descriptors, 'targetNodeUid')),
    });
    if (!nodes.has(edge.sourceNodeUid) || !nodes.has(edge.targetNodeUid)) {
      fail('WORKFLOW_SCOPE_INPUT_INVALID');
    }
    return edge;
  });
  const order = arrayItems(descriptorValue(root, 'topologicalOrder'), MAX_NODES).map(text);
  if (order.length !== nodes.size || new Set(order).size !== order.length
    || order.some((uid) => !nodes.has(uid))) fail('WORKFLOW_SCOPE_INPUT_INVALID');
  return { nodes, edges: Object.freeze(edges), order: Object.freeze(order) };
}

function parseScope(value: unknown): WorkflowExecutionScopeInput {
  const initial = recordDescriptors(value, ['mode', 'nodeUid', 'nodeUids']);
  const mode = descriptorValue(initial, 'mode');
  if (mode === 'full') {
    recordDescriptors(value, ['mode']);
    return Object.freeze({ mode });
  }
  if (mode === 'node' || mode === 'downstream') {
    const descriptors = recordDescriptors(value, ['mode', 'nodeUid']);
    return Object.freeze({ mode, nodeUid: text(descriptorValue(descriptors, 'nodeUid')) });
  }
  if (mode === 'selection') {
    const descriptors = recordDescriptors(value, ['mode', 'nodeUids']);
    const nodeUids = arrayItems(descriptorValue(descriptors, 'nodeUids'), MAX_NODES).map(text);
    if (nodeUids.length === 0) fail('WORKFLOW_SCOPE_SELECTION_EMPTY');
    if (new Set(nodeUids).size !== nodeUids.length) fail('WORKFLOW_SCOPE_SELECTION_DUPLICATE');
    return Object.freeze({ mode, nodeUids: Object.freeze(nodeUids) });
  }
  fail('WORKFLOW_SCOPE_INPUT_INVALID');
}

export function createExecutionScope(planInput: unknown, scopeInput: unknown): Readonly<WorkflowExecutionScope> {
  const plan = parsePlan(planInput);
  const scope = parseScope(scopeInput);
  let selected: Set<string>;
  if (scope.mode === 'full') {
    selected = new Set([...plan.nodes].filter(([, enabled]) => enabled).map(([uid]) => uid));
  } else if (scope.mode === 'selection') {
    selected = new Set(scope.nodeUids);
  } else {
    selected = new Set([scope.nodeUid]);
    if (scope.mode === 'downstream') {
      const outgoing = new Map<string, string[]>();
      for (const edge of plan.edges) {
        const targets = outgoing.get(edge.sourceNodeUid) ?? [];
        targets.push(edge.targetNodeUid);
        outgoing.set(edge.sourceNodeUid, targets);
      }
      const pending = [scope.nodeUid];
      while (pending.length > 0) {
        const source = pending.shift();
        if (source === undefined) break;
        for (const target of outgoing.get(source) ?? []) {
          if (!selected.has(target)) {
            selected.add(target);
            pending.push(target);
          }
        }
      }
    }
  }
  for (const uid of selected) {
    if (!plan.nodes.has(uid)) fail('WORKFLOW_SCOPE_NODE_UNKNOWN');
    if (plan.nodes.get(uid) !== true) fail('WORKFLOW_SCOPE_NODE_DISABLED');
  }
  const executionOrder = plan.order.filter((uid) => selected.has(uid));
  const skippedNodeUids = plan.order.filter((uid) => !selected.has(uid));
  return Object.freeze({
    mode: scope.mode,
    executionOrder: Object.freeze(executionOrder),
    skippedNodeUids: Object.freeze(skippedNodeUids),
  });
}
