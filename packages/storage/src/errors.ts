export const STORAGE_ERROR_CODES = [
  'STORAGE_VALUE_INVALID',
  'STORAGE_FIELD_UNSUPPORTED',
] as const

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number]

const ERROR_MESSAGES: Readonly<Record<StorageErrorCode, string>> = Object.freeze({
  STORAGE_VALUE_INVALID: 'Storage contract value is invalid',
  STORAGE_FIELD_UNSUPPORTED: 'Storage contract contains an unsupported field',
})

export class StorageContractError extends Error {
  readonly code: StorageErrorCode
  readonly field: string

  constructor(code: StorageErrorCode, field: string) {
    super(ERROR_MESSAGES[code])
    this.name = 'StorageContractError'
    this.code = code
    this.field = field
  }
}
