import { computed, onBeforeUnmount, ref } from 'vue'

import { workflowAPI } from '../api/v2/workflows.js'
import {
  assertWorkflowDefinitionListResponse,
  assertWorkflowGraphResponse,
  assertWorkflowRegistryResponse,
  assertWorkflowRunAcceptedResponse,
  assertWorkflowRunListResponse,
  assertWorkflowRunResponse,
  createWorkflowOperationGuard,
} from '../security/workflowBoundary.js'
import {
  addWorkflowNode,
  applyRunStateToNodes,
  canConnectWorkflowNodes,
  createWorkflowCanvasGraph,
  createWorkflowEdge,
  removeWorkflowSelection,
  serializeWorkflowGraph,
} from '../components/workflow/workflowGraph.js'
import {
  buildExecutionScope,
  createWorkflowRequestGuard,
  shouldPollWorkflowRun,
  workflowErrorMeta,
} from '../components/workflow/workflowRuns.js'

const POLL_INTERVAL_MS = 1500

function canonicalIds(items) {
  return [...new Set((items || []).filter((value) => typeof value === 'string'))]
}

export function useWorkflowCanvas({ dramaId, api = workflowAPI }) {
  const registry = ref(null)
  const workflows = ref([])
  const activeWorkflowUid = ref('')
  const workflow = ref(null)
  const nodes = ref([])
  const edges = ref([])
  const selectedNodeUids = ref([])
  const selectedEdgeUids = ref([])
  const runs = ref([])
  const activeRun = ref(null)
  const loading = ref(false)
  const saving = ref(false)
  const running = ref(false)
  const dirty = ref(false)
  const lastError = ref(null)
  const requestGuard = createWorkflowRequestGuard()
  const runRequestGuard = createWorkflowRequestGuard()
  const operationGuard = createWorkflowOperationGuard()
  let pollTimer = null

  const activeWorkflow = computed(() => (
    workflows.value.find((item) => item.uid === activeWorkflowUid.value) || workflow.value?.definition || null
  ))
  const canCancel = computed(() => (
    activeRun.value?.run?.status === 'queued' || activeRun.value?.run?.status === 'running'
  ))

  function graphState() {
    return {
      workflowUid: activeWorkflowUid.value,
      revision: workflow.value?.definition?.graphRevision ?? 0,
      nodes: nodes.value,
      edges: edges.value,
    }
  }

  function setError(error) {
    lastError.value = workflowErrorMeta(error)
  }

  function clearError() {
    lastError.value = null
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  async function loadRun(runUid, { schedule = true } = {}) {
    if (!runUid) return null
    const workflowUid = activeWorkflowUid.value
    const token = runRequestGuard.begin()
    try {
      const response = await api.getRun(runUid)
      if (!runRequestGuard.isCurrent(token) || activeWorkflowUid.value !== workflowUid) return null
      const aggregate = assertWorkflowRunResponse(response, workflowUid)
      clearError()
      activeRun.value = aggregate
      nodes.value = applyRunStateToNodes(nodes.value, aggregate)
      if (schedule && shouldPollWorkflowRun(aggregate.run)) {
        stopPolling()
        pollTimer = setTimeout(async () => {
          try {
            await loadRun(runUid)
          } catch {
            stopPolling()
          }
        }, POLL_INTERVAL_MS)
      } else {
        stopPolling()
        await refreshRuns({ openLatest: false })
      }
      return aggregate
    } catch (error) {
      if (runRequestGuard.isCurrent(token) && activeWorkflowUid.value === workflowUid) setError(error)
      throw error
    }
  }

  async function refreshRuns({ openLatest = true } = {}) {
    if (!activeWorkflowUid.value) {
      runs.value = []
      activeRun.value = null
      return []
    }
    const workflowUid = activeWorkflowUid.value
    const token = runRequestGuard.begin()
    try {
      const response = await api.listRuns(workflowUid)
      if (!runRequestGuard.isCurrent(token) || activeWorkflowUid.value !== workflowUid) return []
      const result = assertWorkflowRunListResponse(response, workflowUid)
      clearError()
      runs.value = result
      if (openLatest && runs.value.length) await loadRun(runs.value[0].uid)
      return runs.value
    } catch (error) {
      if (runRequestGuard.isCurrent(token) && activeWorkflowUid.value === workflowUid) setError(error)
      throw error
    }
  }

  function installGraph(graph) {
    const canvas = createWorkflowCanvasGraph(graph, registry.value?.nodes || [])
    workflow.value = graph
    nodes.value = canvas.nodes
    edges.value = canvas.edges
    selectedNodeUids.value = []
    selectedEdgeUids.value = []
    dirty.value = false
  }

  async function selectWorkflow(workflowUid) {
    stopPolling()
    runRequestGuard.invalidate()
    operationGuard.invalidate()
    saving.value = false
    running.value = false
    clearError()
    const token = requestGuard.begin()
    activeWorkflowUid.value = workflowUid || ''
    workflow.value = null
    nodes.value = []
    edges.value = []
    runs.value = []
    activeRun.value = null
    if (!workflowUid) return
    loading.value = true
    try {
      const response = await api.get(workflowUid)
      if (!requestGuard.isCurrent(token)) return
      const graph = assertWorkflowGraphResponse(response, workflowUid)
      installGraph(graph)
      await refreshRuns()
    } catch (error) {
      if (requestGuard.isCurrent(token)) setError(error)
    } finally {
      if (requestGuard.isCurrent(token)) loading.value = false
    }
  }

  async function load() {
    stopPolling()
    clearError()
    const token = requestGuard.begin()
    loading.value = true
    try {
      const [registryResult, workflowList] = await Promise.all([
        api.getRegistry(),
        api.list(dramaId),
      ])
      if (!requestGuard.isCurrent(token)) return
      const validatedRegistry = assertWorkflowRegistryResponse(registryResult)
      let availableWorkflows = assertWorkflowDefinitionListResponse(workflowList)
      if (availableWorkflows.length === 0) {
        const draftResponse = await api.ensureLegacyDraft(dramaId)
        if (!requestGuard.isCurrent(token)) return
        const draft = assertWorkflowGraphResponse(draftResponse, draftResponse?.definition?.uid)
        availableWorkflows = [draft.definition]
      }
      registry.value = validatedRegistry
      workflows.value = availableWorkflows
      const nextUid = workflows.value.some((item) => item.uid === activeWorkflowUid.value)
        ? activeWorkflowUid.value
        : workflows.value[0]?.uid || ''
      loading.value = false
      await selectWorkflow(nextUid)
    } catch (error) {
      if (requestGuard.isCurrent(token)) {
        setError(error)
        loading.value = false
      }
    }
  }

  async function createWorkflow(input) {
    clearError()
    const token = requestGuard.begin()
    try {
      const response = await api.create(dramaId, input)
      if (!requestGuard.isCurrent(token)) return null
      const createdUid = response?.definition?.uid
      const created = assertWorkflowGraphResponse(response, createdUid)
      workflows.value = [...workflows.value, created.definition]
      await selectWorkflow(created.definition.uid)
      return created
    } catch (error) {
      if (requestGuard.isCurrent(token)) setError(error)
      throw error
    }
  }

  function addNode(definition, position) {
    const next = addWorkflowNode(graphState(), definition, {
      uid: crypto.randomUUID(),
      position,
    })
    nodes.value = next.nodes
    dirty.value = true
  }

  function connectNodes(connection) {
    const validation = validateConnection(connection)
    if (!validation.ok) return validation
    edges.value = [...edges.value, createWorkflowEdge(connection, crypto.randomUUID())]
    dirty.value = true
    return validation
  }

  function validateConnection(connection) {
    return canConnectWorkflowNodes(graphState(), connection)
  }

  function setSelection(nextNodes, nextEdges) {
    selectedNodeUids.value = canonicalIds(nextNodes?.map((node) => node.id))
    selectedEdgeUids.value = canonicalIds(nextEdges?.map((edge) => edge.id))
  }

  function deleteSelection() {
    const next = removeWorkflowSelection(
      graphState(),
      selectedNodeUids.value,
      selectedEdgeUids.value,
    )
    nodes.value = next.nodes
    edges.value = next.edges
    selectedNodeUids.value = []
    selectedEdgeUids.value = []
    dirty.value = true
  }

  function updateSelectedNode(patch) {
    const selected = new Set(selectedNodeUids.value)
    nodes.value = nodes.value.map((node) => selected.has(node.id)
      ? { ...node, data: { ...node.data, ...patch } }
      : node)
    dirty.value = true
  }

  function markDirty() {
    dirty.value = true
  }

  async function save() {
    if (!workflow.value || !dirty.value) return workflow.value
    const workflowUid = activeWorkflowUid.value
    const operation = operationGuard.begin(workflowUid)
    saving.value = true
    clearError()
    try {
      const payload = serializeWorkflowGraph(
        graphState(),
        workflow.value.definition.graphRevision,
      )
      const response = await api.saveGraph(workflowUid, payload)
      if (!operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      const saved = assertWorkflowGraphResponse(response, workflowUid)
      installGraph(saved)
      const index = workflows.value.findIndex((item) => item.uid === saved.definition.uid)
      if (index >= 0) workflows.value[index] = saved.definition
      return saved
    } catch (error) {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) setError(error)
      throw error
    } finally {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) saving.value = false
    }
  }

  async function execute(mode, maxRetries = 0) {
    const workflowUid = activeWorkflowUid.value
    let operation = null
    running.value = true
    clearError()
    try {
      if (dirty.value) {
        const saved = await save()
        if (!saved || activeWorkflowUid.value !== workflowUid) return null
      }
      operation = operationGuard.begin(workflowUid)
      const scope = buildExecutionScope(mode, selectedNodeUids.value)
      const response = await api.startRun(workflowUid, scope, maxRetries)
      if (!operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      const accepted = assertWorkflowRunAcceptedResponse(response)
      const aggregate = await loadRun(accepted.run_uid)
      if (!aggregate || !operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      await refreshRuns({ openLatest: false })
      return accepted
    } catch (error) {
      if (
        operation
          ? operationGuard.isCurrent(operation, activeWorkflowUid.value)
          : activeWorkflowUid.value === workflowUid
      ) setError(error)
      throw error
    } finally {
      if (
        operation
          ? operationGuard.isCurrent(operation, activeWorkflowUid.value)
          : activeWorkflowUid.value === workflowUid
      ) running.value = false
    }
  }

  async function retryNode(nodeRunUid, maxRetries = 0) {
    const workflowUid = activeWorkflowUid.value
    const operation = operationGuard.begin(workflowUid)
    running.value = true
    clearError()
    try {
      const response = await api.retryNode(nodeRunUid, maxRetries)
      if (!operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      const accepted = assertWorkflowRunAcceptedResponse(response)
      const aggregate = await loadRun(accepted.run_uid)
      if (!aggregate || !operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      return accepted
    } catch (error) {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) setError(error)
      throw error
    } finally {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) running.value = false
    }
  }

  async function cancelRun() {
    if (!activeRun.value?.run?.uid) return null
    const workflowUid = activeWorkflowUid.value
    const runUid = activeRun.value.run.uid
    const operation = operationGuard.begin(workflowUid)
    running.value = true
    clearError()
    try {
      const response = await api.cancelRun(runUid)
      if (!operationGuard.isCurrent(operation, activeWorkflowUid.value)) return null
      const cancelled = assertWorkflowRunResponse(response, workflowUid)
      if (cancelled.run.uid !== runUid) throw new TypeError('Workflow response identity is invalid')
      activeRun.value = cancelled
      nodes.value = applyRunStateToNodes(nodes.value, cancelled)
      stopPolling()
      await refreshRuns({ openLatest: false })
      return cancelled
    } catch (error) {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) setError(error)
      throw error
    } finally {
      if (operationGuard.isCurrent(operation, activeWorkflowUid.value)) running.value = false
    }
  }

  onBeforeUnmount(() => {
    requestGuard.invalidate()
    runRequestGuard.invalidate()
    operationGuard.invalidate()
    stopPolling()
  })

  return {
    activeRun,
    activeWorkflow,
    activeWorkflowUid,
    canCancel,
    cancelRun,
    connectNodes,
    createWorkflow,
    deleteSelection,
    dirty,
    edges,
    execute,
    lastError,
    load,
    loadRun,
    loading,
    markDirty,
    nodes,
    refreshRuns,
    registry,
    retryNode,
    running,
    runs,
    save,
    saving,
    selectedEdgeUids,
    selectedNodeUids,
    selectWorkflow,
    setSelection,
    updateSelectedNode,
    validateConnection,
    workflows,
    addNode,
  }
}
