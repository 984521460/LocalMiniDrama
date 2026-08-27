const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const NODE_TYPE = /^[a-z][a-z0-9]*(?:[._][a-z0-9_]+)*$/
const PORT_ID = /^[a-z][a-z0-9_]*$/
const VALUE_TYPE = /^[A-Z][A-Za-z0-9]*$/
const WORKFLOW_STATUSES = new Set(['active', 'archived', 'draft'])
const WORKFLOW_DEFINITION_KEYS = Object.freeze([
  'uid', 'dramaUid', 'name', 'version', 'status', 'description', 'createdAt', 'updatedAt',
  'registryVersion', 'graphRevision',
])

function responseInvalid() {
  throw new TypeError('Workflow response identity is invalid')
}

function pathInvalid() {
  throw new TypeError('Workflow path identifier is invalid')
}

function assertWorkflowUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) responseInvalid()
  return value
}

function exactPlainObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) responseInvalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) responseInvalid()
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) responseInvalid()
  return value
}

function nonEmptyText(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function denseArray(value, maximum, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) responseInvalid()
  const keys = Object.keys(value)
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) responseInvalid()
  return value
}

function assertWorkflowDefinitionResponse(value) {
  const definition = exactPlainObject(value, WORKFLOW_DEFINITION_KEYS)
  if (
    !UUID_V4.test(definition.uid || '')
    || !UUID_V4.test(definition.dramaUid || '')
    || !nonEmptyText(definition.name, 512)
    || !Number.isSafeInteger(definition.version)
    || definition.version < 1
    || !WORKFLOW_STATUSES.has(definition.status)
    || (definition.description !== null && typeof definition.description !== 'string')
    || !ISO_UTC_MILLISECONDS.test(definition.createdAt || '')
    || !ISO_UTC_MILLISECONDS.test(definition.updatedAt || '')
    || definition.registryVersion !== '4.0.0'
    || !Number.isSafeInteger(definition.graphRevision)
    || definition.graphRevision < 0
  ) responseInvalid()
  return definition
}

function assertRegistryPort(value, valueTypes) {
  const port = exactPlainObject(value, ['id', 'valueType', 'cardinality', 'required'])
  if (
    !nonEmptyText(port.id, 64)
    || !PORT_ID.test(port.id)
    || !valueTypes.has(port.valueType)
    || (port.cardinality !== 'one' && port.cardinality !== 'many')
    || typeof port.required !== 'boolean'
  ) responseInvalid()
  return port
}

export function assertWorkflowRegistryResponse(value) {
  const registry = exactPlainObject(value, ['schemaVersion', 'registryVersion', 'valueTypes', 'nodes'])
  if (
    registry.schemaVersion !== '4.0'
    || registry.registryVersion !== '4.0.0'
  ) responseInvalid()
  const valueTypeItems = denseArray(registry.valueTypes, 256, { allowEmpty: false })
  const nodeItems = denseArray(registry.nodes, 500, { allowEmpty: false })
  const valueTypes = new Set(valueTypeItems)
  if (
    valueTypes.size !== valueTypeItems.length
    || valueTypeItems.some((type) => !nonEmptyText(type, 64) || !VALUE_TYPE.test(type))
  ) responseInvalid()
  const nodeTypes = new Set()
  for (const valueNode of nodeItems) {
    const node = exactPlainObject(valueNode, ['type', 'title', 'inputs', 'outputs'])
    if (
      !nonEmptyText(node.type, 128)
      || !NODE_TYPE.test(node.type)
      || !nonEmptyText(node.title, 256)
      || nodeTypes.has(node.type)
    ) responseInvalid()
    nodeTypes.add(node.type)
    for (const ports of [denseArray(node.inputs, 64), denseArray(node.outputs, 64)]) {
      const ids = new Set()
      for (const valuePort of ports) {
        const port = assertRegistryPort(valuePort, valueTypes)
        if (ids.has(port.id)) responseInvalid()
        ids.add(port.id)
      }
    }
  }
  return registry
}

export function assertWorkflowDefinitionListResponse(value) {
  const definitions = denseArray(value, 500)
  const uids = new Set()
  for (const item of definitions) {
    const definition = assertWorkflowDefinitionResponse(item)
    if (uids.has(definition.uid)) responseInvalid()
    uids.add(definition.uid)
  }
  return definitions
}

export function workflowUidPath(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) pathInvalid()
  return value
}

export function dramaIdPath(value) {
  if (!Number.isSafeInteger(value) || value < 1) pathInvalid()
  return String(value)
}

export function createWorkflowOperationGuard() {
  let generation = 0
  return Object.freeze({
    begin(workflowUid) {
      generation += 1
      return Object.freeze({ generation, workflowUid: assertWorkflowUid(workflowUid) })
    },
    invalidate() {
      generation += 1
    },
    isCurrent(operation, workflowUid) {
      return Boolean(
        operation
        && Number.isSafeInteger(operation.generation)
        && operation.generation === generation
        && operation.workflowUid === workflowUid,
      )
    },
  })
}

export function assertWorkflowGraphResponse(graph, workflowUid) {
  const expected = assertWorkflowUid(workflowUid)
  const value = exactPlainObject(graph, ['definition', 'nodes', 'edges'])
  const definition = assertWorkflowDefinitionResponse(value.definition)
  if (definition.uid !== expected) responseInvalid()
  denseArray(value.nodes, 500)
  denseArray(value.edges, 2000)
  return graph
}

export function assertWorkflowRunResponse(aggregate, workflowUid) {
  const expected = assertWorkflowUid(workflowUid)
  if (
    !aggregate?.run
    || aggregate.run.workflowUid !== expected
    || !UUID_V4.test(aggregate.run.uid || '')
    || !Array.isArray(aggregate.nodes)
  ) responseInvalid()
  return aggregate
}

export function assertWorkflowRunListResponse(runs, workflowUid) {
  const expected = assertWorkflowUid(workflowUid)
  if (!Array.isArray(runs) || runs.some((run) => (
    !run
    || run.workflowUid !== expected
    || !UUID_V4.test(run.uid || '')
  ))) responseInvalid()
  return runs
}

export function assertWorkflowRunAcceptedResponse(value) {
  if (!value || !UUID_V4.test(value.run_uid || '')) responseInvalid()
  return value
}
