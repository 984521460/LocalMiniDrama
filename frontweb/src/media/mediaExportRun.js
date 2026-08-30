const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const RUN_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'sourceNodeRunUid',
  'executionPlanSha256', 'status', 'outputAssetUid', 'outputAssetVersionUid',
  'output', 'errorCode', 'createdAt', 'startedAt', 'completedAt',
])
const OUTPUT_KEYS = Object.freeze([
  'relativePath', 'sha256', 'bytes', 'durationMs', 'width', 'height',
  'frameRate', 'videoCodec', 'audioCodec',
])
const LABELS = Object.freeze({ queued: '等待中', running: '导出中', succeeded: '已完成', failed: '失败' })
const ERROR_CODES = Object.freeze(new Set(['MEDIA_EXPORT_FAILED', 'MEDIA_EXPORT_CLEANUP_FAILED']))
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024
const MAX_DURATION_MS = 3_600_100

function invalid(message = 'Media export response is invalid') {
  throw new TypeError(message)
}

function exact(value, keys, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) invalid(message)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
  }
  return value
}

function uid(value, message) {
  if (typeof value !== 'string' || !UID.test(value)) invalid(message)
  return value
}

function time(value, nullable, message) {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || !TIMESTAMP.test(value)
    || new Date(value).toISOString() !== value) invalid(message)
  return value
}

function output(value, runUid, dramaUid, message) {
  const input = exact(value, OUTPUT_KEYS, message)
  if (input.relativePath !== `projects/${dramaUid}/exports/${runUid}.mp4`
    || !SHA.test(input.sha256) || !Number.isSafeInteger(input.bytes)
    || input.bytes < 1 || input.bytes > MAX_OUTPUT_BYTES
    || !Number.isSafeInteger(input.durationMs)
    || input.durationMs < 1 || input.durationMs > MAX_DURATION_MS
    || input.width !== 1920 || input.height !== 1080 || input.frameRate !== '24/1'
    || input.videoCodec !== 'h264' || input.audioCodec !== 'aac') invalid(message)
  return Object.freeze({ ...input })
}

export function mediaExportRunRequest(value) {
  const input = exact(value, ['nodeRunUid'], 'Media export request is invalid')
  return Object.freeze({ node_run_uid: uid(input.nodeRunUid, 'Media export request is invalid') })
}

export function mediaExportRunView(value) {
  const input = exact(value, RUN_KEYS)
  const runUid = uid(input.uid)
  const dramaUid = uid(input.dramaUid)
  if (input.schemaVersion !== 'media-export-run.v1' || !Object.hasOwn(LABELS, input.status)
    || !SHA.test(input.executionPlanSha256)) invalid()
  uid(input.workflowRunUid); uid(input.sourceNodeRunUid)
  const createdAt = time(input.createdAt, false)
  const startedAt = time(input.startedAt, true)
  const completedAt = time(input.completedAt, true)
  const succeeded = input.status === 'succeeded'
  const failed = input.status === 'failed'
  const normalizedOutput = succeeded ? output(input.output, runUid, dramaUid) : null
  if ((!succeeded && (input.output !== null || input.outputAssetUid !== null
    || input.outputAssetVersionUid !== null))
    || (succeeded && (input.errorCode !== null || !UID.test(input.outputAssetUid)
      || !UID.test(input.outputAssetVersionUid)))
    || (failed !== ERROR_CODES.has(input.errorCode))
    || (input.status === 'queued' && (startedAt !== null || completedAt !== null))
    || (input.status === 'running' && (startedAt === null || completedAt !== null))
    || ((succeeded || failed) && (startedAt === null || completedAt === null))
    || (startedAt !== null && Date.parse(startedAt) < Date.parse(createdAt))
    || (completedAt !== null && (
      startedAt === null || Date.parse(completedAt) < Date.parse(startedAt)
    ))) invalid()
  return Object.freeze({ ...input, output: normalizedOutput, statusLabel: LABELS[input.status], createdAt, startedAt, completedAt })
}
