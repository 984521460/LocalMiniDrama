const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

const { inspectSourceTextFile } = require('../sourceImport');
const { parseSourceStructure } = require('../sourceStructure');
const { V2RepositoryNotFoundError } = require('../../repositories/v2');
const {
  buildSourceBlocks,
} = require('./blockBuilder');
const {
  SourceEvidenceValidationError,
  assertSourceEvidenceAggregate,
  selectedTextForSourceSelection,
} = require('./evidenceValidator');
const { sourceDocumentError } = require('./errors');

const CANONICAL_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function snapshotObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], 'value'))) {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
  const snapshot = {};
  for (const key of allowedKeys) {
    if (descriptors[key]) snapshot[key] = descriptors[key].value;
  }
  return snapshot;
}

function assertDramaId(dramaId) {
  if (!Number.isSafeInteger(dramaId) || dramaId < 1) {
    throw sourceDocumentError('SOURCE_DOCUMENT_INPUT_INVALID');
  }
}

function isCanonicalUid(value) {
  return typeof value === 'string' && CANONICAL_UID.test(value);
}

function assertCanonicalUid(value, errorCode = 'SOURCE_DOCUMENT_INPUT_INVALID') {
  if (!isCanonicalUid(value)) {
    throw sourceDocumentError(errorCode);
  }
}

function documentSummary(document, blockCount) {
  return Object.freeze({
    uid: document.uid,
    dramaUid: document.dramaUid,
    sourceType: document.sourceType,
    originalName: document.originalName,
    encoding: document.encoding,
    contentSha256: document.contentSha256,
    createdAt: document.createdAt,
    blockCount,
  });
}

function translateEvidenceValidation(action, errorCode) {
  try {
    return action();
  } catch (error) {
    if (error instanceof SourceEvidenceValidationError) throw sourceDocumentError(errorCode);
    throw error;
  }
}

function createSourceDocumentService({ repositories, createUid = randomUUID } = {}) {
  if (!repositories?.sources || typeof createUid !== 'function') {
    throw new TypeError('Source document service dependencies are invalid');
  }
  const sources = repositories.sources;

  function resolveDrama(dramaId) {
    assertDramaId(dramaId);
    const drama = sources.findDramaByLegacyId(dramaId);
    if (!drama) throw sourceDocumentError('SOURCE_DRAMA_NOT_FOUND');
    return drama;
  }

  function getDocument(documentUid) {
    assertCanonicalUid(documentUid);
    try {
      const document = sources.getDocument(documentUid);
      const blocks = sources.listBlocks(document.uid);
      const selections = sources.listSelections(document.uid);
      translateEvidenceValidation(
        () => assertSourceEvidenceAggregate({ document, blocks, selections }),
        'SOURCE_DOCUMENT_DATA_INVALID',
      );
      return Object.freeze({
        document,
        blocks,
        selections,
      });
    } catch (error) {
      if (error instanceof V2RepositoryNotFoundError) {
        throw sourceDocumentError('SOURCE_DOCUMENT_NOT_FOUND');
      }
      throw error;
    }
  }

  return Object.freeze({
    importDocument(input) {
      const snapshot = snapshotObject(input, ['dramaId', 'fileName', 'bytes', 'encoding']);
      const drama = resolveDrama(snapshot.dramaId);
      const inspected = inspectSourceTextFile({
        fileName: snapshot.fileName,
        bytes: snapshot.bytes,
        ...(snapshot.encoding === undefined ? {} : { encoding: snapshot.encoding }),
      });
      if (inspected.status === 'encoding_required') return inspected;

      const structure = parseSourceStructure({
        text: inspected.text,
        sourceType: inspected.sourceType,
      });
      const documentUid = createUid();
      const blocks = buildSourceBlocks({
        text: inspected.text,
        structure,
        createUid,
      });
      const aggregate = sources.createDocumentWithBlocks({
        document: {
          uid: documentUid,
          dramaUid: drama.uid,
          sourceType: inspected.sourceType,
          originalName: inspected.originalName,
          encoding: inspected.encoding,
          contentSha256: inspected.contentSha256,
          fullText: inspected.text,
        },
        blocks,
      });
      return Object.freeze({ status: 'ready', ...aggregate });
    },

    listDocuments(dramaId) {
      const drama = resolveDrama(dramaId);
      return Object.freeze(sources.listDocumentsByDrama(drama.uid).map((document) => (
        documentSummary(document, document.blockCount)
      )));
    },

    getDocument,

    createSelection(input) {
      const snapshot = snapshotObject(input, [
        'documentUid',
        'startBlockUid',
        'endBlockUid',
        'startOffset',
        'endOffset',
      ]);
      assertCanonicalUid(snapshot.documentUid);
      assertCanonicalUid(snapshot.startBlockUid);
      assertCanonicalUid(snapshot.endBlockUid);
      const aggregate = getDocument(snapshot.documentUid);
      const selectedText = translateEvidenceValidation(
        () => selectedTextForSourceSelection(aggregate.blocks, snapshot),
        'SOURCE_SELECTION_INVALID',
      );
      const selection = sources.createSelection({
        uid: createUid(),
        documentUid: aggregate.document.uid,
        startBlockUid: snapshot.startBlockUid,
        endBlockUid: snapshot.endBlockUid,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset,
        selectedTextSha256: sha256(selectedText),
      });
      return Object.freeze({ selection, selectedText });
    },
  });
}

module.exports = { createSourceDocumentService };
