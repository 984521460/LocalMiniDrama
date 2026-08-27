const CONNECTION_MESSAGES = Object.freeze({
  endpoint_missing: '连接端点不存在',
  port_missing: '端口不存在',
  self_edge: '节点不能连接自身',
  type_mismatch: '端口数据类型不匹配',
  duplicate: '该连接已经存在',
  cardinality: '目标端口只允许一个输入',
  cycle: '该连接会形成环路',
  disabled_dependency: '启用节点不能依赖已停用节点',
})

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function handlePort(handle, prefix) {
  return typeof handle === 'string' && handle.startsWith(prefix) && handle.length > prefix.length
    ? handle.slice(prefix.length)
    : null
}

function registryByType(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError('Workflow registry is invalid')
  const result = new Map()
  for (const definition of definitions) {
    if (!definition || typeof definition.type !== 'string' || result.has(definition.type)) {
      throw new TypeError('Workflow registry is invalid')
    }
    result.set(definition.type, definition)
  }
  return result
}

function canvasNode(record, definition) {
  const domainRef = record.domainRefType && record.domainRefUid
    ? { type: record.domainRefType, uid: record.domainRefUid }
    : record.domainRef || null
  return {
    id: record.uid,
    type: 'workflowNode',
    position: { x: record.position.x, y: record.position.y },
    data: {
      nodeType: record.nodeType,
      title: definition.title,
      definition,
      config: cloneJson(record.config || {}),
      domainRef: cloneJson(domainRef),
      status: record.status || 'draft',
      runStatus: null,
      errorCode: null,
    },
  }
}

function canvasEdge(record) {
  return {
    id: record.uid,
    source: record.sourceNodeUid,
    sourceHandle: `out:${record.sourcePort}`,
    target: record.targetNodeUid,
    targetHandle: `in:${record.targetPort}`,
    type: 'smoothstep',
  }
}

function result(ok, code = null) {
  return { ok, code, message: code ? CONNECTION_MESSAGES[code] : '' }
}

function reaches(edges, start, target) {
  const outgoing = new Map()
  for (const edge of edges) {
    const values = outgoing.get(edge.source) || []
    values.push(edge.target)
    outgoing.set(edge.source, values)
  }
  const queue = [start]
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (current === target) return true
    if (visited.has(current)) continue
    visited.add(current)
    queue.push(...(outgoing.get(current) || []))
  }
  return false
}

export function createWorkflowCanvasGraph(graph, definitions) {
  if (!graph?.definition || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('Workflow graph is invalid')
  }
  const registry = registryByType(definitions)
  return {
    workflowUid: graph.definition.uid,
    revision: graph.definition.graphRevision,
    nodes: graph.nodes.map((node) => {
      const definition = registry.get(node.nodeType)
      if (!definition) throw new TypeError('Workflow graph node type is unknown')
      return canvasNode(node, definition)
    }),
    edges: graph.edges.map(canvasEdge),
  }
}

export function addWorkflowNode(graph, definition, options) {
  if (!graph || !definition || typeof options?.uid !== 'string' || !options.position) {
    throw new TypeError('Workflow node input is invalid')
  }
  if (graph.nodes.some((node) => node.id === options.uid)) {
    throw new TypeError('Workflow node identity already exists')
  }
  return {
    ...graph,
    nodes: [...graph.nodes, canvasNode({
      uid: options.uid,
      nodeType: definition.type,
      position: options.position,
      config: {},
      status: 'disabled',
    }, definition)],
  }
}

export function canConnectWorkflowNodes(graph, connection) {
  const source = graph?.nodes?.find((node) => node.id === connection?.source)
  const target = graph?.nodes?.find((node) => node.id === connection?.target)
  if (!source || !target) return result(false, 'endpoint_missing')
  if (source.id === target.id) return result(false, 'self_edge')
  const sourcePortId = handlePort(connection.sourceHandle, 'out:')
  const targetPortId = handlePort(connection.targetHandle, 'in:')
  const sourcePort = source.data.definition.outputs.find((port) => port.id === sourcePortId)
  const targetPort = target.data.definition.inputs.find((port) => port.id === targetPortId)
  if (!sourcePort || !targetPort) return result(false, 'port_missing')
  if (sourcePort.valueType !== targetPort.valueType) return result(false, 'type_mismatch')
  if (source.data.status === 'disabled' && target.data.status !== 'disabled') {
    return result(false, 'disabled_dependency')
  }
  const duplicate = graph.edges.some((edge) => (
    edge.source === source.id
    && edge.sourceHandle === connection.sourceHandle
    && edge.target === target.id
    && edge.targetHandle === connection.targetHandle
  ))
  if (duplicate) return result(false, 'duplicate')
  if (targetPort.cardinality === 'one' && graph.edges.some((edge) => (
    edge.target === target.id && edge.targetHandle === connection.targetHandle
  ))) return result(false, 'cardinality')
  if (reaches(graph.edges, target.id, source.id)) return result(false, 'cycle')
  return result(true)
}

export function createWorkflowEdge(connection, uid) {
  if (typeof uid !== 'string' || uid.length === 0) throw new TypeError('Workflow edge identity is invalid')
  return {
    id: uid,
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
    type: 'smoothstep',
  }
}

export function serializeWorkflowGraph(graph, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('Workflow graph revision is invalid')
  }
  return {
    expected_revision: expectedRevision,
    nodes: graph.nodes.map((node) => ({
      uid: node.id,
      node_type: node.data.nodeType,
      position: { x: node.position.x, y: node.position.y },
      config: cloneJson(node.data.config || {}),
      ...(node.data.domainRef ? { domain_ref: cloneJson(node.data.domainRef) } : {}),
      status: node.data.status,
    })),
    edges: graph.edges.map((edge) => ({
      uid: edge.id,
      source_node_uid: edge.source,
      source_port: handlePort(edge.sourceHandle, 'out:'),
      target_node_uid: edge.target,
      target_port: handlePort(edge.targetHandle, 'in:'),
    })),
  }
}

export function applyRunStateToNodes(nodes, aggregate) {
  const byNodeUid = new Map((aggregate?.nodes || []).map((node) => [node.nodeUid, node]))
  return nodes.map((node) => {
    const run = byNodeUid.get(node.id)
    return {
      ...node,
      data: {
        ...node.data,
        runStatus: run?.status || null,
        errorCode: run?.errorCode || null,
        nodeRunUid: run?.uid || null,
      },
    }
  })
}

export function removeWorkflowSelection(graph, nodeUids, edgeUids = []) {
  const removedNodes = new Set(nodeUids)
  const removedEdges = new Set(edgeUids)
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !removedNodes.has(node.id)),
    edges: graph.edges.filter((edge) => (
      !removedEdges.has(edge.id)
      && !removedNodes.has(edge.source)
      && !removedNodes.has(edge.target)
    )),
  }
}
