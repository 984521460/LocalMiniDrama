import assert from 'node:assert/strict'
import test from 'node:test'

import { workflowSuccessEnvelopeDataJsonText } from '../src/api/v2/workflowRequest.js'
import { parseStrictJson } from '../src/security/strictJson.js'

const timestamp = '2026-09-02T03:24:17.264Z'

test('strict workflow transport accepts the exact backend success envelope', () => {
  const text = JSON.stringify({ success: true, data: { value: 1 }, timestamp })
  assert.deepEqual(parseStrictJson(workflowSuccessEnvelopeDataJsonText(text)), { value: 1 })
})

test('strict workflow transport rejects ambiguous, stale, or failed envelopes', () => {
  for (const text of [
    JSON.stringify({ success: true, data: {}, timestamp, extra: true }),
    JSON.stringify({ success: true, data: {} }),
    JSON.stringify({ success: false, data: {}, timestamp }),
    JSON.stringify({ success: true, data: {}, timestamp: '2026-09-02' }),
    `{"success":false,"success":true,"data":{},"timestamp":"${timestamp}"}`,
  ]) assert.throws(() => workflowSuccessEnvelopeDataJsonText(text), /Workflow request failed/u)
})

test('strict workflow transport never invokes inherited toJSON hooks', () => {
  let reads = 0
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    get() { reads += 1; return undefined },
  })
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    get() { reads += 1; return undefined },
  })
  try {
    const text = `{"success":true,"data":{"items":[1,2]},"timestamp":"${timestamp}"}`
    assert.deepEqual(parseStrictJson(workflowSuccessEnvelopeDataJsonText(text)), { items: [1, 2] })
    assert.equal(reads, 0)
  } finally {
    delete Object.prototype.toJSON
    delete Array.prototype.toJSON
  }
})
