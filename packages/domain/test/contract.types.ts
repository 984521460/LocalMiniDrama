import {
  CONTRACT_ERROR_CODES,
  createFailureResult,
  createSuccessResult,
  type ResultEnvelope,
} from '@local-mini-drama/domain'

const success = createSuccessResult({ uid: 'scene-1', duration_ms: 3000 })
const failure = createFailureResult(CONTRACT_ERROR_CODES.INVALID_INPUT)

const successContract: ResultEnvelope<{ uid: string; duration_ms: number }> = success
const failureContract: ResultEnvelope<{ uid: string; duration_ms: number }> = failure

void successContract
void failureContract

// @ts-expect-error Versioned result payloads must be JSON-compatible.
createSuccessResult({ generated_at: new Date() })

// @ts-expect-error Error codes are a closed, stable catalog.
createFailureResult('RAW_PROVIDER_ERROR')
