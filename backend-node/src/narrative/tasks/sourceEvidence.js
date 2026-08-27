const crypto = require('node:crypto');

const { narrativeTaskError } = require('./errors');
const { deepFreeze, sha256Canonical, snapshotJson } = require('./jsonSnapshot');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_BLOCKS = 2048;
const MAX_SOURCE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_BLOCK_CODE_POINTS = 3000;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function codePoints(value) {
  return Array.from(value);
}

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function invalidEvidence() {
  throw narrativeTaskError('NARRATIVE_TASK_EVIDENCE_INVALID');
}

function normalizeSource(source) {
  let snapshot;
  try {
    snapshot = snapshotJson(source, {
      maxDepth: 12,
      maxNodes: 20000,
      maxStringBytes: MAX_SOURCE_TEXT_BYTES,
    });
  } catch {
    return invalidInput();
  }
  if (!snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !CANONICAL_UID.test(snapshot.documentUid)
    || !Array.isArray(snapshot.blocks)
    || snapshot.blocks.length < 1
    || snapshot.blocks.length > MAX_SOURCE_BLOCKS
    || !snapshot.selection
    || typeof snapshot.selection !== 'object'
    || Array.isArray(snapshot.selection)) invalidInput();

  const allowedSourceKeys = ['blocks', 'documentUid', 'selection'];
  if (Object.keys(snapshot).sort().join('\0') !== allowedSourceKeys.join('\0')) invalidInput();
  const allowedBlockKeys = ['documentUid', 'ordinal', 'text', 'textSha256', 'uid'];
  const blockByUid = new Map();
  let previousOrdinal = null;
  for (const block of snapshot.blocks) {
    const points = typeof block?.text === 'string' ? codePoints(block.text) : null;
    if (!block
      || typeof block !== 'object'
      || Array.isArray(block)
      || Object.keys(block).sort().join('\0') !== allowedBlockKeys.join('\0')
      || !CANONICAL_UID.test(block.uid)
      || blockByUid.has(block.uid)
      || block.documentUid !== snapshot.documentUid
      || !Number.isSafeInteger(block.ordinal)
      || block.ordinal < 0
      || (previousOrdinal !== null && block.ordinal !== previousOrdinal + 1)
      || typeof block.text !== 'string'
      || block.text.length === 0
      || points.length > MAX_BLOCK_CODE_POINTS
      || !SHA256.test(block.textSha256)
      || sha256(block.text) !== block.textSha256) invalidInput();
    previousOrdinal = block.ordinal;
    blockByUid.set(block.uid, { block, points });
  }

  const selection = snapshot.selection;
  const allowedSelectionKeys = [
    'documentUid', 'endBlockUid', 'endOffset', 'selectedTextSha256',
    'startBlockUid', 'startOffset', 'uid',
  ];
  if (Object.keys(selection).sort().join('\0') !== allowedSelectionKeys.join('\0')
    || !CANONICAL_UID.test(selection.uid)
    || selection.documentUid !== snapshot.documentUid
    || selection.startBlockUid !== snapshot.blocks[0].uid
    || selection.endBlockUid !== snapshot.blocks[snapshot.blocks.length - 1].uid
    || !Number.isSafeInteger(selection.startOffset)
    || !Number.isSafeInteger(selection.endOffset)
    || selection.startOffset < 0
    || selection.endOffset < 0
    || !SHA256.test(selection.selectedTextSha256)) invalidInput();

  const firstText = blockByUid.get(snapshot.blocks[0].uid).points;
  const lastText = blockByUid.get(snapshot.blocks[snapshot.blocks.length - 1].uid).points;
  if (selection.startOffset > firstText.length
    || selection.endOffset > lastText.length
    || (snapshot.blocks.length === 1 && selection.startOffset >= selection.endOffset)) invalidInput();
  const selectedParts = snapshot.blocks.map((block, index) => {
    const points = blockByUid.get(block.uid).points;
    const start = index === 0 ? selection.startOffset : 0;
    const end = index === snapshot.blocks.length - 1 ? selection.endOffset : points.length;
    return points.slice(start, end).join('');
  });
  const selectedText = selectedParts.join('');
  if (selectedText.length === 0 || sha256(selectedText) !== selection.selectedTextSha256) invalidInput();

  return deepFreeze({
    source: snapshot,
    inputHash: sha256Canonical(snapshot),
    blockByUid,
  });
}

function assertEvidenceReferences(normalized, output) {
  const startUid = normalized.source.selection.startBlockUid;
  const endUid = normalized.source.selection.endBlockUid;
  const arrays = [
    output.characters,
    output.scenes,
    output.props,
    output.relationships,
    output.events,
    output.dialogue,
  ];
  for (const fact of arrays.flat()) {
    for (const evidence of fact.evidence) {
      const sourceBlock = normalized.blockByUid.get(evidence.blockUid);
      if (!sourceBlock) invalidEvidence();
      const { block, points } = sourceBlock;
      const minimum = block.uid === startUid ? normalized.source.selection.startOffset : 0;
      const maximum = block.uid === endUid ? normalized.source.selection.endOffset : points.length;
      if (!Number.isSafeInteger(evidence.startOffset)
        || !Number.isSafeInteger(evidence.endOffset)
        || evidence.startOffset < minimum
        || evidence.endOffset > maximum
        || evidence.startOffset >= evidence.endOffset
        || points.slice(evidence.startOffset, evidence.endOffset).join('') !== evidence.quote) {
        invalidEvidence();
      }
    }
  }
}

module.exports = {
  assertEvidenceReferences,
  normalizeSource,
};
