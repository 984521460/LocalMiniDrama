import { characterReferencePackageView } from '../assets/characterReferencePackage.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const KEYS = Object.freeze([
  'schemaVersion', 'operationUid', 'dramaUid', 'characterUid',
  'candidateExecutionUid', 'candidateUid', 'width', 'height', 'seed',
])

function invalid(message) {
  throw new TypeError(message)
}

function exact(value, keys, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(message)
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid(message)
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) invalid(message)
  const output = Object.create(null)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (!Object.hasOwn(descriptors, key)) invalid(message)
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(message)
    output[key] = descriptor.value
  }
  return output
}

function uid(value, message) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(message)
  return value
}

export function characterReferencePackageExecutionRequestView(value) {
  const message = 'Character reference package execution request is invalid'
  const input = exact(value, KEYS, message)
  if (input.schemaVersion !== 'character-reference-package-execution-request.v1'
    || !Number.isSafeInteger(input.width) || input.width < 256 || input.width > 2048
    || !Number.isSafeInteger(input.height) || input.height < 256 || input.height > 2048
    || input.width * input.height > 4_194_304
    || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295) {
    invalid(message)
  }
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    operationUid: uid(input.operationUid, message),
    dramaUid: uid(input.dramaUid, message),
    characterUid: uid(input.characterUid, message),
    candidateExecutionUid: uid(input.candidateExecutionUid, message),
    candidateUid: uid(input.candidateUid, message),
    width: input.width,
    height: input.height,
    seed: input.seed,
  })
}

export function characterReferencePackageExecutionResponseView(value, expectedRequest) {
  const message = 'Character reference package execution response is invalid'
  const input = exact(value, ['package'], message)
  const view = characterReferencePackageView(input.package)
  if (expectedRequest !== undefined) {
    const request = characterReferencePackageExecutionRequestView(expectedRequest)
    if (view.packageUid !== request.operationUid
      || view.characterUid !== request.characterUid
      || view.candidateUid !== request.candidateUid) invalid(message)
  }
  return Object.freeze({ package: input.package, view })
}

export function createCharacterReferencePackageExecutionRequest(value) {
  return characterReferencePackageExecutionRequestView({
    schemaVersion: 'character-reference-package-execution-request.v1',
    ...value,
  })
}
