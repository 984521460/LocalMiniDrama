'use strict';

const { types: { isProxy } } = require('node:util');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const LEGACY_KEYS = [
  'ordinal', 'assetUid', 'assetVersionUid', 'relativePath', 'sha256', 'byteLength',
  'width', 'height', 'originalName', 'originalSha256',
];

// Only the exact v36 shape may omit logicalUri. The derived URI still has to
// match the separately checked AssetVersion and deterministic owner path.
function projectLocalRecoveryItem(item, characterUid, operationUid, ordinal) {
  const invalid = () => { throw new TypeError('Local recovery item is invalid'); };
  if (!item || typeof item !== 'object' || isProxy(item) || Array.isArray(item)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    || !UUID.test(characterUid) || !UUID.test(operationUid)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(item);
  const keys = Object.hasOwn(descriptors, 'logicalUri') ? [...LEGACY_KEYS, 'logicalUri'] : LEGACY_KEYS;
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  const relativePath = `characters/${characterUid}/local-recoveries/${operationUid}/${ordinal}.png`;
  const logicalUri = `asset://${relativePath}`;
  if (item.ordinal !== ordinal || !UUID.test(item.assetUid) || !UUID.test(item.assetVersionUid)
    || item.relativePath !== relativePath || !SHA.test(item.sha256) || !SHA.test(item.originalSha256)
    || (Object.hasOwn(descriptors, 'logicalUri') && item.logicalUri !== logicalUri)
    || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 16 * 1024 * 1024
    || !Number.isSafeInteger(item.width) || item.width < 1
    || !Number.isSafeInteger(item.height) || item.height < 1
    || typeof item.originalName !== 'string' || item.originalName.length < 1
    || item.originalName.length > 128) invalid();
  return Object.freeze({ ...item, logicalUri });
}

module.exports = Object.freeze({ projectLocalRecoveryItem });
