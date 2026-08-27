import { StorageContractError } from './errors.js'
import {
  readExactDataObject,
  validateFilesystemSegments,
  validateLogicalSegments,
  validateProviderId,
} from './validation.js'

declare const assetUriBrand: unique symbol
declare const storageRelativePathBrand: unique symbol

const MAX_ASSET_URI_LENGTH = 2048

export type AssetUri = string & { readonly [assetUriBrand]: true }
export type StorageRelativePath = string & { readonly [storageRelativePathBrand]: true }

export interface AssetLocator {
  readonly storageProvider: string
  readonly logicalUri: AssetUri
  readonly relativePath: StorageRelativePath
}

export interface CreateAssetLocatorInput {
  readonly storageProvider?: string
  readonly logicalSegments: readonly string[]
  readonly relativeSegments: readonly string[]
}

export interface StorageWriteOptions {
  readonly overwrite?: boolean
}

export interface StorageProvider<Content extends Uint8Array = Uint8Array> {
  readonly id: string
  exists(locator: AssetLocator): Promise<boolean>
  read(locator: AssetLocator): Promise<Content>
  write(locator: AssetLocator, content: Content, options?: StorageWriteOptions): Promise<AssetLocator>
  remove(locator: AssetLocator): Promise<boolean>
}

function invalid(field: string): never {
  throw new StorageContractError('STORAGE_VALUE_INVALID', field)
}

export function createAssetUri(segments: readonly string[]): AssetUri {
  const snapshot = validateLogicalSegments(segments, 'logicalSegments')
  const value = `asset://${snapshot.join('/')}`
  if (value.length > MAX_ASSET_URI_LENGTH) invalid('logicalSegments')
  return value as AssetUri
}

export function parseAssetUri(value: unknown): readonly string[] {
  if (typeof value !== 'string' || value.length > MAX_ASSET_URI_LENGTH || !value.startsWith('asset://')) invalid('logicalUri')
  const remainder = value.slice('asset://'.length)
  if (!remainder || remainder.includes('\\') || remainder.includes('?') || remainder.includes('#')) invalid('logicalUri')
  const segments = remainder.split('/')
  const validated = validateLogicalSegments(segments, 'logicalUri')
  if (createAssetUri(validated) !== value) invalid('logicalUri')
  return validated
}

export function createStorageRelativePath(segments: readonly string[]): StorageRelativePath {
  const snapshot = validateFilesystemSegments(segments, 'relativeSegments')
  const value = snapshot.join('/')
  if (value.length > 1024) invalid('relativeSegments')
  return value as StorageRelativePath
}

export function parseStorageRelativePath(value: unknown): readonly string[] {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value)
    || value.includes('\\')
  ) invalid('relativePath')
  const segments = value.split('/')
  const validated = validateFilesystemSegments(segments, 'relativePath')
  if (createStorageRelativePath(validated) !== value) invalid('relativePath')
  return validated
}

export function parseAssetLocator(value: unknown): AssetLocator {
  const input = readExactDataObject(
    value,
    ['storageProvider', 'logicalUri', 'relativePath'],
    [],
    'locator',
  )
  const storageProvider = validateProviderId(input.storageProvider)
  const logicalUri = createAssetUri(parseAssetUri(input.logicalUri))
  const relativePath = createStorageRelativePath(parseStorageRelativePath(input.relativePath))
  return Object.freeze({ storageProvider, logicalUri, relativePath })
}

export function createAssetLocator(value: CreateAssetLocatorInput): AssetLocator {
  const input = readExactDataObject(
    value,
    ['logicalSegments', 'relativeSegments'],
    ['storageProvider'],
    'locatorInput',
  )
  return Object.freeze({
    storageProvider: validateProviderId(input.storageProvider ?? 'local'),
    logicalUri: createAssetUri(validateLogicalSegments(input.logicalSegments, 'logicalSegments')),
    relativePath: createStorageRelativePath(validateFilesystemSegments(input.relativeSegments, 'relativeSegments')),
  })
}
