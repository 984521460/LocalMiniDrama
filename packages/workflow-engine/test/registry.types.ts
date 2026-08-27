import {
  validateWorkflowGraph,
  getNodeTypeDefinition,
  getPortDefinition,
  getWorkflowRegistry,
  type WorkflowNodeType,
  type WorkflowPortCardinality,
  type WorkflowValueType,
} from '../src';

const nodeType: WorkflowNodeType = 'shot.video';
const valueType: WorkflowValueType = 'VideoAsset';
const cardinality: WorkflowPortCardinality = 'many';

getNodeTypeDefinition(nodeType);
getPortDefinition(nodeType, 'input', 'shot');
getWorkflowRegistry().valueTypes.includes(valueType);
const ordered: readonly string[] = validateWorkflowGraph({ nodes: [], edges: [] }).topologicalOrder;
void cardinality;
void ordered;

// @ts-expect-error port direction is a closed public union
getPortDefinition(nodeType, 'sideways', 'shot');
// @ts-expect-error node identifiers are a closed public union
const invalidNodeType: WorkflowNodeType = 'unknown.node';
// @ts-expect-error value types are a closed public union
const invalidValueType: WorkflowValueType = 'OpaqueAnything';
void invalidNodeType;
void invalidValueType;
