const crypto = require('node:crypto');

const {
  MAX_BLOCK_CODE_POINTS,
  MAX_HEADING_COMPONENT_CODE_POINTS,
  MAX_HEADING_PATH_CODE_POINTS,
} = require('./blockBuilder');
const { codePointLength, sliceCodePoints } = require('./unicodeText');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

class SourceEvidenceValidationError extends Error {
  constructor() {
    super('Source evidence aggregate is invalid');
    this.name = 'SourceEvidenceValidationError';
    this.code = 'SOURCE_EVIDENCE_INVALID';
  }
}

function invalid() {
  throw new SourceEvidenceValidationError();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isCanonicalUid(value) {
  return typeof value === 'string' && CANONICAL_UID.test(value);
}

function assertHeadingPath(path) {
  if (!Array.isArray(path)) invalid();
  let total = 0;
  for (const component of path) {
    if (typeof component !== 'string') invalid();
    const length = codePointLength(component);
    total += length;
    if (length > MAX_HEADING_COMPONENT_CODE_POINTS || total > MAX_HEADING_PATH_CODE_POINTS) invalid();
  }
}

function selectedTextForSourceSelection(blocks, selection) {
  if (!Array.isArray(blocks) || !selection || typeof selection !== 'object') invalid();
  const startIndex = blocks.findIndex((block) => block.uid === selection.startBlockUid);
  const endIndex = blocks.findIndex((block) => block.uid === selection.endBlockUid);
  if (startIndex < 0
    || endIndex < startIndex
    || !Number.isSafeInteger(selection.startOffset)
    || !Number.isSafeInteger(selection.endOffset)
    || selection.startOffset < 0
    || selection.endOffset < 0) invalid();

  const startLength = codePointLength(blocks[startIndex].text);
  const endLength = codePointLength(blocks[endIndex].text);
  if (selection.startOffset > startLength
    || selection.endOffset > endLength
    || (startIndex === endIndex && selection.startOffset >= selection.endOffset)) invalid();

  const parts = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const block = blocks[index];
    const length = codePointLength(block.text);
    const start = index === startIndex ? selection.startOffset : 0;
    const end = index === endIndex ? selection.endOffset : length;
    const piece = sliceCodePoints(block.text, start, end);
    if (piece === null) invalid();
    parts.push(piece);
  }
  const selectedText = parts.join('');
  if (selectedText.length === 0) invalid();
  return selectedText;
}

function assertSourceEvidenceAggregate({ document, blocks, selections }) {
  if (!document
    || typeof document !== 'object'
    || !Array.isArray(blocks)
    || !Array.isArray(selections)
    || !isCanonicalUid(document.uid)
    || typeof document.fullText !== 'string'
    || typeof document.contentSha256 !== 'string'
    || !SHA256.test(document.contentSha256)
    || !Number.isSafeInteger(document.blockCount)
    || document.blockCount < 1
    || document.blockCount !== blocks.length) invalid();

  let expectedStart = 0;
  const textParts = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block
      || typeof block !== 'object'
      || !isCanonicalUid(block.uid)
      || block.documentUid !== document.uid
      || typeof block.text !== 'string'
      || typeof block.textSha256 !== 'string'
      || !SHA256.test(block.textSha256)) invalid();
    assertHeadingPath(block.headingPath);
    const length = codePointLength(block.text);
    if (length < 1
      || length > MAX_BLOCK_CODE_POINTS
      || block.ordinal !== index
      || block.charStart !== expectedStart
      || block.charEnd !== block.charStart + length
      || block.textSha256 !== sha256(block.text)) invalid();
    expectedStart = block.charEnd;
    textParts.push(block.text);
  }
  if (expectedStart !== codePointLength(document.fullText)
    || textParts.join('') !== document.fullText) invalid();

  for (const selection of selections) {
    if (!selection
      || typeof selection !== 'object'
      || !isCanonicalUid(selection.uid)
      || selection.documentUid !== document.uid
      || !isCanonicalUid(selection.startBlockUid)
      || !isCanonicalUid(selection.endBlockUid)
      || typeof selection.selectedTextSha256 !== 'string'
      || !SHA256.test(selection.selectedTextSha256)) invalid();
    const selectedText = selectedTextForSourceSelection(blocks, selection);
    if (selection.selectedTextSha256 !== sha256(selectedText)) invalid();
  }
  return true;
}

module.exports = {
  SourceEvidenceValidationError,
  assertSourceEvidenceAggregate,
  selectedTextForSourceSelection,
};
