import { CredentialContractError } from './errors.js'

declare const credentialRefBrand: unique symbol

export type CredentialRef = string & { readonly [credentialRefBrand]: true }

export const CREDENTIAL_KINDS = Object.freeze([
  'api_key',
  'provider_token',
  'ssh_password',
  'ssh_key_passphrase',
] as const)

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

export interface CredentialDescriptor {
  readonly ref: CredentialRef
  readonly kind: CredentialKind
  readonly configured: boolean
}

export interface StoreCredentialInput {
  readonly kind: CredentialKind
  readonly secret: string
}

export interface CredentialVault {
  store(input: StoreCredentialInput): Promise<CredentialDescriptor>
  read(ref: CredentialRef): Promise<string>
  inspect(ref: CredentialRef): Promise<CredentialDescriptor>
  remove(ref: CredentialRef): Promise<boolean>
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CREDENTIAL_REF = /^credential:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

function invalid(field: string): never {
  throw new CredentialContractError('CREDENTIAL_VALUE_INVALID', field)
}

function readExactDataObject(
  value: unknown,
  requiredFields: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    invalid(field)
  }
  if (prototype !== Object.prototype && prototype !== null) invalid(field)

  const allowed = new Set(requiredFields)
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new CredentialContractError('CREDENTIAL_FIELD_UNSUPPORTED', field)
    }
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      invalid(`${field}.${key}`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(`${field}.${key}`)
    snapshot[key] = descriptor.value
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(snapshot, key)) invalid(`${field}.${key}`)
  }
  return Object.freeze(snapshot)
}

export function createCredentialRef(uuid: unknown): CredentialRef {
  if (typeof uuid !== 'string' || !UUID_V4.test(uuid)) invalid('uuid')
  return `credential:v1:${uuid}` as CredentialRef
}

export function parseCredentialRef(value: unknown): CredentialRef {
  if (typeof value !== 'string' || value.length !== 50 || !CREDENTIAL_REF.test(value)) invalid('ref')
  return value as CredentialRef
}

export function parseCredentialKind(value: unknown): CredentialKind {
  if (typeof value !== 'string' || !(CREDENTIAL_KINDS as readonly string[]).includes(value)) invalid('kind')
  return value as CredentialKind
}

export function parseCredentialDescriptor(value: unknown): CredentialDescriptor {
  const input = readExactDataObject(value, ['ref', 'kind', 'configured'], 'descriptor')
  if (typeof input.configured !== 'boolean') invalid('descriptor.configured')
  return Object.freeze({
    ref: parseCredentialRef(input.ref),
    kind: parseCredentialKind(input.kind),
    configured: input.configured,
  })
}
