const { isSourceTextImportError, sourceTextImportError } = require('./errors');

const DEFAULT_SOURCE_TEXT_MAX_BYTES = 10 * 1024 * 1024;
const HARD_SOURCE_TEXT_MAX_BYTES = 50 * 1024 * 1024;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
).get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
).get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

const SOURCE_TYPES = Object.freeze({
  '.md': 'markdown',
  '.txt': 'txt',
});

const BINARY_SIGNATURES = Object.freeze([
  Buffer.from('25504446', 'hex'),
  Buffer.from('504b0304', 'hex'),
  Buffer.from('504b0506', 'hex'),
  Buffer.from('504b0708', 'hex'),
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('ffd8ff', 'hex'),
  Buffer.from('474946383761', 'hex'),
  Buffer.from('474946383961', 'hex'),
  Buffer.from('4d5a', 'hex'),
  Buffer.from('d0cf11e0a1b11ae1', 'hex'),
  Buffer.from('7f454c46', 'hex'),
  Buffer.from('526172211a07', 'hex'),
  Buffer.from('1f8b08', 'hex'),
  Buffer.from('53514c69746520666f726d6174203300', 'hex'),
]);

function readDataProperty(descriptors, key, required) {
  const descriptor = descriptors[key];
  if (!descriptor) {
    if (required) throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
    return undefined;
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }
  return descriptor.value;
}

function snapshotImportInput(input) {
  if (input === null || typeof input !== 'object') {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  const allowedKeys = new Set(['fileName', 'bytes', 'encoding', 'maxBytes']);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  const fileName = readDataProperty(descriptors, 'fileName', true);
  const bytes = readDataProperty(descriptors, 'bytes', true);
  const encoding = readDataProperty(descriptors, 'encoding', false);
  const maxBytes = readDataProperty(descriptors, 'maxBytes', false);

  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }
  if (encoding !== undefined && typeof encoding !== 'string') {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  const effectiveMaxBytes = maxBytes === undefined ? DEFAULT_SOURCE_TEXT_MAX_BYTES : maxBytes;
  if (!Number.isSafeInteger(effectiveMaxBytes)
    || effectiveMaxBytes < 1
    || effectiveMaxBytes > HARD_SOURCE_TEXT_MAX_BYTES) {
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  let byteSnapshot;
  try {
    if (!ArrayBuffer.isView(bytes)) throw new TypeError('not a typed array view');
    const prototype = Object.getPrototypeOf(bytes);
    if (prototype !== Buffer.prototype && prototype !== Uint8Array.prototype) {
      throw new TypeError('unsupported typed array prototype');
    }
    for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'constructor']) {
      if (Object.getOwnPropertyDescriptor(bytes, key)) {
        throw new TypeError('typed array has an unsafe own property');
      }
    }

    const backingStore = TYPED_ARRAY_BUFFER_GETTER.call(bytes);
    if (typeof SharedArrayBuffer === 'function' && backingStore instanceof SharedArrayBuffer) {
      throw new TypeError('shared byte storage is unsupported');
    }
    const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(bytes);
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
      throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
    }
    if (byteLength > effectiveMaxBytes) {
      throw sourceTextImportError('SOURCE_TEXT_FILE_TOO_LARGE');
    }

    byteSnapshot = Buffer.allocUnsafe(byteLength);
    TYPED_ARRAY_SET.call(byteSnapshot, bytes);
    if (TYPED_ARRAY_BYTE_LENGTH_GETTER.call(bytes) !== byteLength) {
      throw new TypeError('typed array changed while copying');
    }
  } catch (error) {
    if (byteSnapshot) byteSnapshot.fill(0);
    if (isSourceTextImportError(error)) throw error;
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }

  return Object.freeze({
    fileName,
    bytes: byteSnapshot,
    encoding,
    maxBytes: effectiveMaxBytes,
  });
}

function classifySourceFileName(fileName) {
  if (fileName.trim() !== fileName
    || fileName.normalize('NFC') !== fileName
    || /[\u0000-\u001f\u007f/\\:]/u.test(fileName)
    || /[. ]$/u.test(fileName)) {
    throw sourceTextImportError('SOURCE_TEXT_TYPE_UNSUPPORTED');
  }

  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) throw sourceTextImportError('SOURCE_TEXT_TYPE_UNSUPPORTED');
  const extension = fileName.slice(dot).toLowerCase();
  const sourceType = SOURCE_TYPES[extension];
  if (!sourceType) throw sourceTextImportError('SOURCE_TEXT_TYPE_UNSUPPORTED');

  return sourceType;
}

function decodesAsWhitespace(bytes, encoding) {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return bytes.length > 0 && text.trim().length === 0;
  } catch {
    return false;
  }
}

function firstBinarySignatureOffset(bytes) {
  let firstOffset = -1;
  for (const signature of BINARY_SIGNATURES) {
    const offset = bytes.indexOf(signature);
    if (offset >= 0 && (firstOffset < 0 || offset < firstOffset)) firstOffset = offset;
  }
  return firstOffset;
}

function hasOnlyWhitespaceBefore(bytes, offset) {
  if (offset < 0) return false;
  if (offset === 0) return true;
  const prefix = bytes.subarray(0, offset);
  return decodesAsWhitespace(prefix, 'utf-8') || decodesAsWhitespace(prefix, 'gb18030');
}

function assertTextLikeBytes(bytes, maxBytes) {
  if (bytes.length === 0) throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  if (bytes.length > maxBytes) throw sourceTextImportError('SOURCE_TEXT_FILE_TOO_LARGE');

  if ((bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw sourceTextImportError('SOURCE_TEXT_ENCODING_UNSUPPORTED');
  }

  if (hasOnlyWhitespaceBefore(bytes, firstBinarySignatureOffset(bytes))) {
    throw sourceTextImportError('SOURCE_TEXT_BINARY_REJECTED');
  }

  let disallowedControls = 0;
  for (const byte of bytes) {
    if (byte === 0) throw sourceTextImportError('SOURCE_TEXT_BINARY_REJECTED');
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      disallowedControls += 1;
    }
  }
  if (disallowedControls > 0) {
    throw sourceTextImportError('SOURCE_TEXT_BINARY_REJECTED');
  }
}

module.exports = {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  HARD_SOURCE_TEXT_MAX_BYTES,
  assertTextLikeBytes,
  classifySourceFileName,
  snapshotImportInput,
};
