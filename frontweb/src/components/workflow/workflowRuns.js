const RUN_STATUS = Object.freeze({
  queued: Object.freeze({ label: '排队中', tone: 'info' }),
  running: Object.freeze({ label: '执行中', tone: 'warning' }),
  succeeded: Object.freeze({ label: '已完成', tone: 'success' }),
  failed: Object.freeze({ label: '失败', tone: 'danger' }),
  cancelled: Object.freeze({ label: '已取消', tone: 'info' }),
  blocked: Object.freeze({ label: '已阻断', tone: 'danger' }),
  skipped: Object.freeze({ label: '已跳过', tone: 'info' }),
})

const ERROR_MESSAGES = Object.freeze({
  WORKFLOW_CONFLICT: '工作流已被其他操作更新，请刷新后重试',
  WORKFLOW_DATA_INVALID: '工作流数据不完整或已损坏，操作已安全停止',
  WORKFLOW_DRAMA_NOT_FOUND: '剧集不存在或已移除',
  WORKFLOW_EXECUTION_FAILED: '工作流执行失败，请查看节点状态后重试',
  WORKFLOW_EXECUTION_UNAVAILABLE: '当前没有可用的后端执行器',
  WORKFLOW_GRAPH_INVALID: '工作流图未通过校验，请检查端口、必填输入、状态和领域绑定',
  WORKFLOW_INPUT_INVALID: '工作流请求参数无效',
  WORKFLOW_LIMIT_EXCEEDED: '工作流数据超过本地支持的大小限制',
  WORKFLOW_NOT_FOUND: '工作流不存在或已移除',
  WORKFLOW_REQUEST_FAILED: '工作流请求失败，请稍后重试',
  WORKFLOW_RUN_NOT_FOUND: '运行记录不存在',
  WORKFLOW_RUN_TRANSITION_INVALID: '当前运行状态不允许此操作',
})

export function runStatusMeta(status) {
  const meta = RUN_STATUS[status]
  if (!meta) return { label: status || '未运行', tone: 'info' }
  return { ...meta }
}

function exactSelection(values, expectedLength = null) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new TypeError('Workflow scope selection is invalid')
  }
  const unique = [...new Set(values)]
  if (unique.length !== values.length || unique.length === 0) {
    throw new TypeError('Workflow scope selection is invalid')
  }
  if (expectedLength !== null && unique.length !== expectedLength) {
    throw new TypeError('Workflow scope selection is invalid')
  }
  return unique
}

export function buildExecutionScope(mode, selectedNodeUids) {
  if (mode === 'full') return { mode: 'full' }
  if (mode === 'node' || mode === 'downstream') {
    const [nodeUid] = exactSelection(selectedNodeUids, 1)
    return { mode, node_uid: nodeUid }
  }
  if (mode === 'selection') {
    return { mode, node_uids: exactSelection(selectedNodeUids) }
  }
  throw new TypeError('Workflow scope selection is invalid')
}

export function shouldPollWorkflowRun(run) {
  return run?.status === 'queued' || run?.status === 'running'
}

export function createWorkflowRequestGuard() {
  let generation = 0
  return Object.freeze({
    begin() {
      generation += 1
      return generation
    },
    invalidate() {
      generation += 1
    },
    isCurrent(token) {
      return Number.isSafeInteger(token) && token === generation
    },
  })
}

export function workflowErrorMeta(error) {
  const apiError = error?.response?.data?.error
  const requestedCode = typeof apiError?.code === 'string' ? apiError.code : ''
  const code = Object.hasOwn(ERROR_MESSAGES, requestedCode)
    ? requestedCode
    : 'WORKFLOW_REQUEST_FAILED'
  return {
    code,
    message: ERROR_MESSAGES[code],
  }
}
