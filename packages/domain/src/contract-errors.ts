export const CONTRACT_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const)

export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[keyof typeof CONTRACT_ERROR_CODES]

export interface ContractErrorDefinition {
  readonly message: string
  readonly retryable: boolean
}

export interface ContractError extends ContractErrorDefinition {
  readonly code: ContractErrorCode
}

const CONTRACT_ERROR_DEFINITIONS: Readonly<Record<ContractErrorCode, ContractErrorDefinition>> =
  Object.freeze({
    [CONTRACT_ERROR_CODES.INVALID_INPUT]: Object.freeze({
      message: 'Input validation failed',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.SCHEMA_VALIDATION_FAILED]: Object.freeze({
      message: 'Structured data validation failed',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION]: Object.freeze({
      message: 'Schema version is not supported',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.NOT_FOUND]: Object.freeze({
      message: 'Requested resource was not found',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.CONFLICT]: Object.freeze({
      message: 'The operation conflicts with current state',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.UNAUTHORIZED]: Object.freeze({
      message: 'Authentication is required',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.FORBIDDEN]: Object.freeze({
      message: 'The operation is not permitted',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.RATE_LIMITED]: Object.freeze({
      message: 'The operation was rate limited',
      retryable: true,
    }),
    [CONTRACT_ERROR_CODES.PROVIDER_UNAVAILABLE]: Object.freeze({
      message: 'The provider is unavailable',
      retryable: true,
    }),
    [CONTRACT_ERROR_CODES.OPERATION_TIMEOUT]: Object.freeze({
      message: 'The operation timed out',
      retryable: true,
    }),
    [CONTRACT_ERROR_CODES.OPERATION_CANCELLED]: Object.freeze({
      message: 'The operation was cancelled',
      retryable: false,
    }),
    [CONTRACT_ERROR_CODES.INTERNAL_ERROR]: Object.freeze({
      message: 'The operation failed',
      retryable: false,
    }),
  })

const CONTRACT_FAULT_CODES = new WeakMap<object, ContractErrorCode>()

function isContractErrorCode(value: unknown): value is ContractErrorCode {
  return typeof value === 'string' && Object.hasOwn(CONTRACT_ERROR_DEFINITIONS, value)
}

export function getContractErrorDefinition(code: ContractErrorCode): ContractErrorDefinition {
  if (!isContractErrorCode(code)) {
    throw new TypeError('Unknown contract error code')
  }

  return CONTRACT_ERROR_DEFINITIONS[code]
}

export function createContractError(code: ContractErrorCode): ContractError {
  const definition = getContractErrorDefinition(code)
  return Object.freeze({ code, ...definition })
}

/**
 * Internal error wrapper whose public message is selected only from the stable catalog.
 * Raw provider responses may be retained as `cause` for local diagnostics, but are never
 * copied into a ContractError or a ResultEnvelope.
 */
export class ContractFault extends Error {
  declare readonly code: ContractErrorCode

  constructor(code: ContractErrorCode, options?: ErrorOptions) {
    const definition = getContractErrorDefinition(code)
    super(definition.message, options)
    this.name = 'ContractFault'
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    })
    CONTRACT_FAULT_CODES.set(this, code)
    Object.freeze(this)
  }
}

export function toContractError(
  error: unknown,
  fallbackCode: ContractErrorCode = CONTRACT_ERROR_CODES.INTERNAL_ERROR,
): ContractError {
  let code = fallbackCode
  try {
    if (typeof error === 'object' && error !== null) {
      code = CONTRACT_FAULT_CODES.get(error) ?? fallbackCode
    }
  } catch {
    code = fallbackCode
  }
  return createContractError(code)
}

export function isCanonicalContractError(value: unknown): value is ContractError {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return false
    }

    const keys = Reflect.ownKeys(value)
    const expectedKeys = ['code', 'message', 'retryable'] as const
    if (
      keys.length !== expectedKeys.length
      || !keys.every((key) => typeof key === 'string' && expectedKeys.includes(key as never))
    ) {
      return false
    }

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const codeDescriptor = descriptors.code
    const messageDescriptor = descriptors.message
    const retryableDescriptor = descriptors.retryable
    if (
      !codeDescriptor?.enumerable
      || !messageDescriptor?.enumerable
      || !retryableDescriptor?.enumerable
      || !('value' in codeDescriptor)
      || !('value' in messageDescriptor)
      || !('value' in retryableDescriptor)
      || !isContractErrorCode(codeDescriptor.value)
    ) {
      return false
    }

    const definition = getContractErrorDefinition(codeDescriptor.value)
    return messageDescriptor.value === definition.message
      && retryableDescriptor.value === definition.retryable
  } catch {
    return false
  }
}
