const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const SCHEMA_DIRECTORY = path.resolve(__dirname, '../../../schemas/v1')

function readSchema(filename) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIRECTORY, filename), 'utf8'))
}

test('v1 JSON Schemas stay aligned with the public error catalog', () => {
  const {
    CONTRACT_ERROR_CODES,
    CONTRACT_SCHEMA_VERSION,
    getContractErrorDefinition,
  } = require('@local-mini-drama/domain')
  const errorSchema = readSchema('contract-error.schema.json')
  const resultSchema = readSchema('result-envelope.schema.json')

  assert.equal(errorSchema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(errorSchema['x-schema-version'], CONTRACT_SCHEMA_VERSION)
  assert.deepEqual(errorSchema.properties.code.enum, Object.values(CONTRACT_ERROR_CODES))
  assert.equal(errorSchema.additionalProperties, false)

  const schemaDefinitions = new Map(errorSchema.allOf.map((branch) => [
    branch.if.properties.code.const,
    {
      message: branch.then.properties.message.const,
      retryable: branch.then.properties.retryable.const,
    },
  ]))

  for (const code of Object.values(CONTRACT_ERROR_CODES)) {
    assert.deepEqual(schemaDefinitions.get(code), getContractErrorDefinition(code))
  }

  assert.equal(resultSchema['x-schema-version'], CONTRACT_SCHEMA_VERSION)
  assert.equal(resultSchema.oneOf[0].properties.schema_version.const, CONTRACT_SCHEMA_VERSION)
  assert.equal(resultSchema.oneOf[1].properties.schema_version.const, CONTRACT_SCHEMA_VERSION)
  assert.equal(resultSchema.oneOf[0].additionalProperties, false)
  assert.equal(resultSchema.oneOf[1].additionalProperties, false)
  assert.equal(resultSchema.oneOf[1].properties.error.$ref, errorSchema.$id)
})

test('a Draft 2020-12 validator compiles the schema set and enforces both branches', () => {
  const Ajv2020 = require('ajv/dist/2020')
  const errorSchema = readSchema('contract-error.schema.json')
  const resultSchema = readSchema('result-envelope.schema.json')
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  ajv.addKeyword({ keyword: 'x-schema-version', schemaType: 'string', valid: true })
  ajv.addSchema(errorSchema)
  const validate = ajv.compile(resultSchema)

  const canonicalFailure = {
    schema_version: '1.0.0',
    ok: false,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The provider is unavailable',
      retryable: true,
    },
  }
  assert.equal(validate({ schema_version: '1.0.0', ok: true, value: { shots: [] } }), true)
  assert.equal(validate(canonicalFailure), true)

  const invalidValues = [
    { ...canonicalFailure, schema_version: '2.0.0' },
    { ...canonicalFailure, extra: true },
    { ...canonicalFailure, value: null },
    { ...canonicalFailure, error: { ...canonicalFailure.error, code: 'RAW_PROVIDER_ERROR' } },
    { ...canonicalFailure, error: { ...canonicalFailure.error, message: 'raw provider response' } },
    { ...canonicalFailure, error: { ...canonicalFailure.error, retryable: false } },
  ]
  for (const value of invalidValues) {
    assert.equal(validate(value), false)
  }
})

test('result factories create versioned success and stable failure envelopes', () => {
  const {
    CONTRACT_ERROR_CODES,
    CONTRACT_SCHEMA_VERSION,
    createFailureResult,
    createSuccessResult,
  } = require('@local-mini-drama/domain')

  assert.deepEqual(createSuccessResult({ uid: 'scene-1' }), {
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: true,
    value: { uid: 'scene-1' },
  })
  assert.deepEqual(createFailureResult(CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE), {
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: false,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The provider is unavailable',
      retryable: true,
    },
  })
})

test('unknown and provider failures never expose raw error text downstream', () => {
  const {
    CONTRACT_ERROR_CODES,
    ContractFault,
    createFailureResultFromUnknown,
  } = require('@local-mini-drama/domain')
  const rawProviderText = 'upstream token=provider-secret-value; request rejected'

  const unknownFailure = createFailureResultFromUnknown(new Error(rawProviderText))
  const providerFailure = createFailureResultFromUnknown(new ContractFault(
    CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE,
    { cause: new Error(rawProviderText) },
  ))

  assert.equal(JSON.stringify(unknownFailure).includes(rawProviderText), false)
  assert.equal(JSON.stringify(providerFailure).includes(rawProviderText), false)
  assert.equal(unknownFailure.error.code, CONTRACT_ERROR_CODES.INTERNAL_ERROR)
  assert.equal(providerFailure.error.code, CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE)
})

test('unknown-error conversion and public guards fail closed for hostile objects', () => {
  const {
    CONTRACT_ERROR_CODES,
    ContractFault,
    createFailureResultFromUnknown,
    isCanonicalContractError,
  } = require('@local-mini-drama/domain')
  const rawProviderText = 'raw provider secret from reflection trap'
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const throwingProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error(rawProviderText)
    },
  })
  const codeGetter = {}
  Object.defineProperty(codeGetter, 'code', {
    enumerable: true,
    get() {
      throw new Error(rawProviderText)
    },
  })
  Object.assign(codeGetter, { message: 'unused', retryable: false })

  for (const value of [revoked.proxy, throwingProxy, codeGetter]) {
    assert.doesNotThrow(() => createFailureResultFromUnknown(value))
    assert.equal(createFailureResultFromUnknown(value).error.code, CONTRACT_ERROR_CODES.INTERNAL_ERROR)
    assert.doesNotThrow(() => isCanonicalContractError(value))
    assert.equal(isCanonicalContractError(value), false)
  }

  const fault = new ContractFault(CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE)
  assert.equal(Reflect.set(fault, 'code', 'RAW_PROVIDER_ERROR'), false)
  const spoofedFault = new Proxy(fault, {
    get(target, property, receiver) {
      return property === 'code' ? 'RAW_PROVIDER_ERROR' : Reflect.get(target, property, receiver)
    },
  })
  assert.equal(
    createFailureResultFromUnknown(spoofedFault).error.code,
    CONTRACT_ERROR_CODES.INTERNAL_ERROR,
  )

  const forgedFault = Object.create(ContractFault.prototype)
  let forgedCodeReads = 0
  Object.defineProperty(forgedFault, 'code', {
    enumerable: true,
    get() {
      forgedCodeReads += 1
      return forgedCodeReads === 1
        ? CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE
        : 'RAW_PROVIDER_ERROR'
    },
  })
  assert.doesNotThrow(() => createFailureResultFromUnknown(forgedFault))
  assert.equal(
    createFailureResultFromUnknown(forgedFault).error.code,
    CONTRACT_ERROR_CODES.INTERNAL_ERROR,
  )
  assert.equal(forgedCodeReads, 0)
})

test('parser accepts only the exact supported version and canonical error definitions', () => {
  const {
    CONTRACT_ERROR_CODES,
    CONTRACT_SCHEMA_VERSION,
    createFailureResult,
    createSuccessResult,
    isCompatibleResultSchemaVersion,
    parseResultEnvelope,
  } = require('@local-mini-drama/domain')

  const success = createSuccessResult({ shots: [1, 2] })
  const failure = createFailureResult(CONTRACT_ERROR_CODES.OPERATION_TIMEOUT)

  assert.deepEqual(parseResultEnvelope(success), { ok: true, value: success })
  assert.deepEqual(parseResultEnvelope(failure), { ok: true, value: failure })
  assert.equal(isCompatibleResultSchemaVersion(CONTRACT_SCHEMA_VERSION), true)
  assert.equal(isCompatibleResultSchemaVersion('1.0.1'), false)
  assert.equal(isCompatibleResultSchemaVersion('2.0.0'), false)

  const unsupported = parseResultEnvelope({
    schema_version: '2.0.0',
    ok: true,
    value: null,
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, CONTRACT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION)

  const nonCanonicalError = parseResultEnvelope({
    ...failure,
    error: {
      ...failure.error,
      message: 'raw provider response',
    },
  })
  assert.equal(nonCanonicalError.ok, false)
  assert.equal(nonCanonicalError.error.code, CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
})

test('parser and factories reject malformed or non-JSON contract values', () => {
  const {
    CONTRACT_ERROR_CODES,
    CONTRACT_SCHEMA_VERSION,
    createSuccessResult,
    parseResultEnvelope,
  } = require('@local-mini-drama/domain')
  const malformedValues = [
    null,
    {},
    { schema_version: CONTRACT_SCHEMA_VERSION, ok: true },
    { schema_version: CONTRACT_SCHEMA_VERSION, ok: true, value: undefined },
    { schema_version: CONTRACT_SCHEMA_VERSION, ok: true, value: 1, extra: true },
    {
      schema_version: CONTRACT_SCHEMA_VERSION,
      ok: false,
      error: { code: 'MADE_UP', message: 'unknown', retryable: false },
    },
  ]

  for (const value of malformedValues) {
    const parsed = parseResultEnvelope(value)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error.code, CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
  }

  assert.throws(() => createSuccessResult({ amount: Number.NaN }), {
    name: 'TypeError',
    message: 'Result value must be JSON-compatible',
  })

  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => createSuccessResult(cyclic), {
    name: 'TypeError',
    message: 'Result value must be JSON-compatible',
  })
})

test('success boundaries return deep JSON snapshots and reject accessors', () => {
  const {
    CONTRACT_ERROR_CODES,
    CONTRACT_SCHEMA_VERSION,
    createSuccessResult,
    isJsonValue,
    parseResultEnvelope,
  } = require('@local-mini-drama/domain')
  const rawProviderText = 'provider-secret-after-validation'
  const accessorPayload = {}
  let reads = 0
  Object.defineProperty(accessorPayload, 'value', {
    enumerable: true,
    get() {
      reads += 1
      return reads < 3 ? 'safe' : rawProviderText
    },
  })

  assert.equal(isJsonValue(accessorPayload), false)
  const accessorResult = parseResultEnvelope({
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: true,
    value: accessorPayload,
  })
  assert.equal(accessorResult.ok, false)
  assert.equal(accessorResult.error.code, CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED)
  assert.equal(reads, 0)

  const source = { nested: { label: 'safe' }, shots: [1, 2] }
  const created = createSuccessResult(source)
  const parsed = parseResultEnvelope({
    schema_version: CONTRACT_SCHEMA_VERSION,
    ok: true,
    value: source,
  })
  assert.equal(parsed.ok, true)

  source.nested.label = rawProviderText
  source.shots.push(3)
  source.self = source

  assert.deepEqual(created.value, { nested: { label: 'safe' }, shots: [1, 2] })
  assert.deepEqual(parsed.value.value, { nested: { label: 'safe' }, shots: [1, 2] })
  assert.equal(JSON.stringify(created).includes(rawProviderText), false)
  assert.equal(JSON.stringify(parsed).includes(rawProviderText), false)
  assert.equal(Object.isFrozen(created.value), true)
  assert.equal(Object.isFrozen(created.value.nested), true)
  assert.equal(Object.isFrozen(created.value.shots), true)
})

test('array snapshots read an own length descriptor once and ignore dynamic get traps', () => {
  const { createSuccessResult } = require('@local-mini-drama/domain')
  let lengthReads = 0
  const dynamicLengthArray = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') {
        lengthReads += 1
        return lengthReads === 1 ? 0 : 3
      }
      return Reflect.get(target, property, receiver)
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === '0' || property === '1' || property === '2') {
        return {
          value: Number(property) + 1,
          enumerable: true,
          writable: true,
          configurable: true,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
  })

  const result = createSuccessResult(dynamicLengthArray)
  assert.deepEqual(result.value, [])
  assert.equal(lengthReads, 0)
})

test('Node ESM consumers receive the contract exports', async () => {
  const domain = await import('@local-mini-drama/domain')

  assert.equal(domain.CONTRACT_SCHEMA_VERSION, '1.0.0')
  assert.equal(typeof domain.createFailureResultFromUnknown, 'function')
  assert.equal(typeof domain.parseResultEnvelope, 'function')
})
