import request from './workflowRequest.js'
import { dramaIdPath, workflowUidPath } from '../../security/workflowBoundary.js'

export const workflowAPI = Object.freeze({
  getRegistry() {
    return request.get('/v2/workflow-registry')
  },

  list(dramaId) {
    return request.get(`/v2/dramas/${dramaIdPath(dramaId)}/workflows`)
  },

  create(dramaId, input) {
    return request.post(`/v2/dramas/${dramaIdPath(dramaId)}/workflows`, {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
    })
  },

  ensureLegacyDraft(dramaId) {
    return request.post(`/v2/dramas/${dramaIdPath(dramaId)}/workflows/legacy-draft`, {})
  },

  get(workflowUid) {
    return request.get(`/v2/workflows/${workflowUidPath(workflowUid)}`)
  },

  saveGraph(workflowUid, graph) {
    return request.put(`/v2/workflows/${workflowUidPath(workflowUid)}/graph`, graph)
  },

  getPlan(workflowUid) {
    return request.get(`/v2/workflows/${workflowUidPath(workflowUid)}/plan`)
  },

  listRuns(workflowUid) {
    return request.get(`/v2/workflows/${workflowUidPath(workflowUid)}/runs`)
  },

  getRun(runUid) {
    return request.get(`/v2/workflow-runs/${workflowUidPath(runUid)}`)
  },

  startRun(workflowUid, scope, maxRetries) {
    return request.post(`/v2/workflows/${workflowUidPath(workflowUid)}/runs`, {
      scope,
      ...(maxRetries === undefined ? {} : { max_retries: maxRetries }),
    })
  },

  retryNode(nodeRunUid, maxRetries) {
    return request.post(`/v2/node-runs/${workflowUidPath(nodeRunUid)}/retry`, {
      ...(maxRetries === undefined ? {} : { max_retries: maxRetries }),
    })
  },

  cancelRun(runUid) {
    return request.post(`/v2/workflow-runs/${workflowUidPath(runUid)}/cancel`, {})
  },
})
