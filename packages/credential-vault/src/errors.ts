export type CredentialContractErrorCode =
  | 'CREDENTIAL_VALUE_INVALID'
  | 'CREDENTIAL_FIELD_UNSUPPORTED'

export class CredentialContractError extends Error {
  readonly code: CredentialContractErrorCode

  readonly field: string

  constructor(code: CredentialContractErrorCode, field: string) {
    const message = code === 'CREDENTIAL_FIELD_UNSUPPORTED'
      ? `Credential contract contains an unsupported field: ${field}`
      : `Credential contract value is invalid: ${field}`
    super(message)
    this.name = 'CredentialContractError'
    this.code = code
    this.field = field
  }
}
