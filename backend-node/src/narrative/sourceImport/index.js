const crypto = require('node:crypto');

const { isSourceTextImportError, sourceTextImportError } = require('./errors');
const { inspectTextEncoding } = require('./encoding');
const {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  HARD_SOURCE_TEXT_MAX_BYTES,
  assertTextLikeBytes,
  classifySourceFileName,
  snapshotImportInput,
} = require('./filePolicy');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inspectSourceTextFile(input) {
  try {
    const snapshot = snapshotImportInput(input);
    const sourceType = classifySourceFileName(snapshot.fileName);
    assertTextLikeBytes(snapshot.bytes, snapshot.maxBytes);

    const contentSha256 = sha256(snapshot.bytes);
    const encodingResult = inspectTextEncoding(snapshot.bytes, snapshot.encoding);
    if (encodingResult.encodingRequired) {
      return Object.freeze({
        status: 'encoding_required',
        sourceType,
        originalName: snapshot.fileName,
        rawByteLength: snapshot.bytes.length,
        contentSha256,
        encodingOptions: encodingResult.encodingOptions,
      });
    }

    const originalBytes = Buffer.from(snapshot.bytes);
    const text = encodingResult.text;
    return Object.freeze({
      status: 'ready',
      sourceType,
      originalName: snapshot.fileName,
      encoding: encodingResult.encoding,
      rawByteLength: originalBytes.length,
      contentSha256,
      normalizedTextSha256: sha256(Buffer.from(text, 'utf8')),
      text,
      copyOriginalBytes() {
        return Buffer.from(originalBytes);
      },
    });
  } catch (error) {
    if (isSourceTextImportError(error)) throw error;
    throw sourceTextImportError('SOURCE_TEXT_FILE_INVALID');
  }
}

module.exports = {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  HARD_SOURCE_TEXT_MAX_BYTES,
  inspectSourceTextFile,
  isSourceTextImportError,
};
